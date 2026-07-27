const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { generateEmbedding } = require('./embeddings');
const { searchContext, getRecentAcrossSources } = require('./supabase');
const { channelRef, dateRef, rowEpoch } = require('./utils/slack-format');
const logger = require('./utils/logger');

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

// gemini-2.0-flash is no longer granted on the free tier (429, quota limit: 0).
// 2.5-flash is a thinking model, so maxOutputTokens must leave headroom for
// reasoning tokens or `response.text` comes back empty.
const GENERATION_MODEL = 'gemini-2.5-flash';

// Fallback chain. Gemini returns transient 503 UNAVAILABLE ("high demand")
// often enough that a single attempt is not good enough for an interactive
// bot — an unretried blip reaches the user as a hard error. If the primary
// stays degraded, move down the chain rather than failing the request.
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash'];

// 503/500/502/504 are capacity blips and usually clear on an immediate retry.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
// 429 is not worth retrying in-request: Gemini's own retryDelay for an
// exhausted quota is tens of seconds, far longer than a Slack reply can wait.
// Switch models instead.
const FAILOVER_STATUSES = new Set([429]);
const ATTEMPTS_PER_MODEL = 3;
const BASE_BACKOFF_MS = 350;

// Headroom for reasoning tokens plus a long answer: enumerating a 30-message
// recency window with a paraphrase each will not fit in 2048.
const MAX_OUTPUT_TOKENS = 4096;
const SIMILARITY_THRESHOLD = 0.4;
const MAX_RESULTS = 8;

// Recency requests are answered from a time-ordered read, so they need their
// own ceiling — high enough for "last 30 messages", low enough to stay inside
// the model's context budget.
const DEFAULT_RECENCY_COUNT = 15;
const MAX_RECENCY_COUNT = 30;

// Recency intent has to be detected from wording because pgvector can only
// rank by similarity. English + Spanish, since the workspace uses both.
const RECENCY_RE =
  /\b(last|latest|recent(?:ly)?|newest|most recent|today|yesterday|so far|recap|catch\s*me\s*up|summar(?:y|ise|ize)|[uú]ltim\w+|recient\w+|hoy|ayer|resum\w+)\b/i;
const COUNT_RE = /\b(\d{1,3})\b/;

const SYSTEM_PROMPT = `You are PM-Insight-Hub, an AI assistant for a product management team.
You answer questions using context retrieved from Slack conversations and ClickUp tasks.

Grounding:
- Base your answers ONLY on the provided context. If the context doesn't contain enough information, say so clearly.
- Never make up information that isn't in the context.
- If asked about task status, priorities, or assignments, reference the ClickUp details when available.

Formatting — you are writing directly into Slack, which uses mrkdwn, NOT Markdown:
- Bold is a SINGLE asterisk: *bold*. Never write **bold** — Slack shows the asterisks literally.
- Italic is _italic_. Bullets are "• ". Never start a line with "- " or "* ".
- No Markdown headings (#) and no tables.

Referring to sources:
- Each context block has a header with a channel reference like <#C0123ABC> and a date token like <!date^...>. Copy those verbatim if you mention them — Slack expands them into a channel name and a local date.
- NEVER print raw channel IDs, user IDs, Unix timestamps, or thread_ts values. They are meaningless to the reader.
- Do NOT end your answer with a list or table of the sources you used — a source summary is appended automatically. Weave attribution into the prose only when it matters (e.g. "in <#C0123ABC> yesterday").
- When the question asks you to list or enumerate messages, give each entry a short paraphrase of what it actually said. A bare list of channels and dates is useless to the reader — the substance is the point, the location is the label.

Be concise and actionable. Answer the question that was asked; don't narrate the retrieval process.`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract an HTTP status from a @google/genai error, which reports it either
 * on `.status` or only inside the serialized message body.
 * @param {Error} error
 * @returns {number|null}
 */
function errorStatus(error) {
  if (typeof error?.status === 'number') return error.status;
  const match = String(error?.message || '').match(/"code"\s*:\s*(\d{3})/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Issue a single generation call. Extracted so the retry/fallback policy can be
 * exercised against injected failures without touching the network.
 * @param {string} model
 * @param {string} userPrompt
 * @returns {Promise<Object>}
 */
function callModel(model, userPrompt) {
  return ai.models.generateContent({
    model,
    contents: userPrompt,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      temperature: 0.3,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });
}

/**
 * Generate content, retrying transient failures and falling back across models.
 * Throws the last error only when every model is exhausted.
 * @param {Object} params
 * @param {string} params.userPrompt
 * @param {(model: string, prompt: string) => Promise<Object>} [params.generate] - Injectable for tests
 * @param {(ms: number) => Promise<void>} [params.wait] - Injectable for tests
 * @returns {Promise<{response: Object, model: string, attempts: number}>}
 */
async function generateWithFallback({ userPrompt, generate = callModel, wait = sleep }) {
  const chain = [GENERATION_MODEL, ...FALLBACK_MODELS];
  let attempts = 0;
  let lastError;

  for (const model of chain) {
    for (let attempt = 1; attempt <= ATTEMPTS_PER_MODEL; attempt++) {
      attempts++;
      try {
        const response = await generate(model, userPrompt);
        if (model !== GENERATION_MODEL || attempt > 1) {
          logger.warn('Generation recovered after retry/fallback', { model, attempt, attempts });
        }
        return { response, model, attempts };
      } catch (error) {
        lastError = error;
        const status = errorStatus(error);

        if (FAILOVER_STATUSES.has(status)) {
          logger.warn('Model quota exhausted — failing over', { model, status });
          break;
        }
        if (!RETRYABLE_STATUSES.has(status)) {
          logger.error('Non-retryable generation error', { model, status, error: error.message });
          throw error;
        }
        if (attempt === ATTEMPTS_PER_MODEL) {
          logger.warn('Model exhausted retries — failing over', { model, status, attempt });
          break;
        }

        // Exponential backoff with jitter, so concurrent mentions don't retry in lockstep.
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random());
        logger.warn('Transient generation error — retrying', {
          model,
          status,
          attempt,
          retryInMs: Math.round(delay),
        });
        await wait(delay);
      }
    }
  }

  logger.error('All generation models failed', { attempts, error: lastError?.message });
  throw lastError;
}

/**
 * Detect whether a question is asking about recency rather than topic, and
 * how many items it wants.
 * @param {string} question
 * @returns {{isRecency: boolean, count: number, requestedCount: number|null}}
 */
function detectRecencyIntent(question) {
  const isRecency = RECENCY_RE.test(question);
  if (!isRecency) return { isRecency: false, count: 0, requestedCount: null };

  const match = question.match(COUNT_RE);
  const requestedCount = match ? Number.parseInt(match[1], 10) : null;
  const count = Math.min(requestedCount || DEFAULT_RECENCY_COUNT, MAX_RECENCY_COUNT);

  return { isRecency: true, count: Math.max(count, 1), requestedCount };
}

/**
 * Build a human-readable header for one context block.
 * Raw metadata JSON is deliberately not passed to the model — it used to leak
 * channel IDs and Unix timestamps straight into the answer.
 * @param {Object} row
 * @param {number} index
 * @returns {string}
 */
function buildContextHeader(row, index) {
  const parts = [row.source === 'slack' ? '💬 Slack' : '📋 ClickUp'];

  const channel = row.source === 'slack' ? channelRef(row.metadata?.channel || row.external_id) : null;
  if (channel) parts.push(channel);
  if (row.source === 'clickup' && row.metadata?.task_id) parts.push(`task ${row.metadata.task_id}`);

  const when = dateRef(rowEpoch(row));
  if (when) parts.push(when);
  if (row.metadata?.thread_ts && row.metadata.thread_ts !== row.metadata?.ts) parts.push('in thread');

  return `--- [${index + 1}] ${parts.join(' · ')} ---`;
}

/**
 * Build the context string from retrieved documents.
 * @param {Array} results - Search results from Supabase
 * @returns {string} Formatted context
 */
function buildContextString(results) {
  if (!results || results.length === 0) {
    return 'No relevant context found in the knowledge base.';
  }

  return results
    .map((r, i) => `${buildContextHeader(r, i)}\n${r.content}`)
    .join('\n\n');
}

/**
 * Run the full RAG pipeline: embed → search → generate.
 * @param {string} question - User's question
 * @returns {Promise<{answer: string, sources: Array}>} Answer with source references
 */
async function answerQuestion(question) {
  const intent = detectRecencyIntent(question);
  logger.info('RAG pipeline started', {
    question: question.substring(0, 100),
    mode: intent.isRecency ? 'recency+semantic' : 'semantic',
    requestedCount: intent.requestedCount,
  });

  // Step 1: Embed the question
  const queryEmbedding = await generateEmbedding(question);

  // Step 2: Retrieve context.
  // Semantic search alone cannot answer "the last 15 messages" — similarity
  // ranking has no notion of time. When the question is about recency, lead
  // with a time-ordered read and append any semantic hits it didn't already
  // cover, so "the latest decision on pricing" still finds the right thread.
  const semantic = await searchContext(queryEmbedding, SIMILARITY_THRESHOLD, MAX_RESULTS);

  let results = semantic;
  if (intent.isRecency) {
    const recent = await getRecentAcrossSources(intent.count);

    if (intent.requestedCount) {
      // An explicit count ("last 15 messages") is a request for exactly that
      // set. Padding it with semantic hits would make the source footer report
      // more items than were asked for — the very mismatch this fixes.
      results = recent;
    } else {
      // Open-ended recency ("catch me up", "latest on pricing") benefits from
      // topical hits the time window happened to miss.
      const seen = new Set(recent.map((r) => r.id));
      results = [...recent, ...semantic.filter((r) => !seen.has(r.id))];
    }
  }
  logger.info(`Retrieved ${results.length} context chunks`, {
    semantic: semantic.length,
    recencyLed: intent.isRecency,
  });

  // Step 3: Build the prompt
  const contextString = buildContextString(results);
  const countNote =
    intent.isRecency && intent.requestedCount && results.length < intent.requestedCount
      ? `\n\nNote: the knowledge base only holds ${results.length} item(s), fewer than the ${intent.requestedCount} requested. Answer with what is available and mention the shortfall in one short sentence.`
      : '';
  const orderNote = intent.isRecency
    ? '\n\nThe context blocks are ordered newest first.'
    : '';

  // State which sources are actually present. Without this the model will
  // answer "what are the last 10 tasks?" using Slack messages, because every
  // context block looks equally authoritative to it.
  const present = new Set(results.map((r) => r.source));
  const inventoryNote = `\n\nSources present in this context: ${
    present.size ? [...present].join(', ') : 'none'
  }. If the question asks about a source that is absent, say plainly that nothing from that source is indexed yet — do not answer it from the other source.`;

  const userPrompt = `Context:\n${contextString}${orderNote}${countNote}${inventoryNote}\n\n---\nQuestion: ${question}`;

  // Step 4: Generate the answer
  const { response, model, attempts } = await generateWithFallback({ userPrompt });

  const answer = response.text || 'I was unable to generate a response. Please try again.';
  const finishReason = response.candidates?.[0]?.finishReason;

  // A MAX_TOKENS finish means the reply was cut mid-sentence. Enumerating a
  // long recency window is the case that hits this.
  if (finishReason === 'MAX_TOKENS') {
    logger.warn('Answer truncated by output token limit', {
      answerLength: answer.length,
      sourcesUsed: results.length,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
  }

  logger.info('RAG pipeline completed', {
    answerLength: answer.length,
    sourcesUsed: results.length,
    finishReason,
    model,
    attempts,
    thoughtsTokens: response.usageMetadata?.thoughtsTokenCount,
  });

  return {
    answer,
    sources: results.map((r) => ({
      source: r.source,
      // The deployed match_context RPC doesn't return external_id, so prefer
      // metadata.channel — it's populated on every indexed Slack message.
      channelId: r.source === 'slack' ? r.metadata?.channel || r.external_id || null : null,
      taskId: r.source === 'clickup' ? r.metadata?.task_id || r.external_id || null : null,
      epoch: rowEpoch(r),
      similarity: typeof r.similarity === 'number' ? r.similarity : null,
    })),
  };
}

module.exports = {
  answerQuestion,
  detectRecencyIntent,
  generateWithFallback,
  errorStatus,
};
