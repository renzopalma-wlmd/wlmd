const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const logger = require('./utils/logger');

const ai = new GoogleGenAI({ apiKey: config.gemini.apiKey });

const EMBEDDING_MODEL = 'gemini-embedding-2';
const EMBEDDING_DIMENSIONS = 1536;

// The free tier allows 100 embed requests per MINUTE (not per day). Exceeding
// it returns 429 with a ~30s retryDelay. Every caller shares this limiter, so a
// bulk sync and live Slack indexing can't collectively overrun the quota.
// Free tier is 100/min. Paid tiers are far higher, so this is configurable —
// otherwise enabling billing changes nothing because our own limiter is the cap.
const RATE_LIMIT_PER_MIN = Number.parseInt(process.env.EMBEDDING_RATE_PER_MIN || '90', 10);
const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

// Texts per batch call. The API caps a batch at 100.
//
// MEASURED: the quota counts TEXTS, not HTTP requests. One batch of 100 consumed
// the entire 100/minute allowance and the next batch was refused with
// PerMinute limit: 100. Batching therefore buys latency (100 texts in ~3s
// instead of ~100s) but does NOT buy quota — 1000 texts/day is a hard ceiling.
const EMBEDDING_BATCH_SIZE = Math.min(100, Number.parseInt(process.env.EMBEDDING_BATCH_SIZE || '100', 10));

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

let windowStart = Date.now();
let windowCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Block until `count` texts can be embedded in the current minute.
 * Slots are per TEXT because that is what the quota counts — charging one slot
 * per batch would let a single call of 100 blow straight through the limit.
 */
async function acquireSlots(count = 1) {
  for (;;) {
    const now = Date.now();
    if (now - windowStart >= RATE_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount + count <= RATE_LIMIT_PER_MIN) {
      windowCount += count;
      return;
    }
    await sleep(windowStart + RATE_WINDOW_MS - now + 50);
  }
}

/** Seconds Gemini asked us to wait, if it said. */
function retryDelayMs(error) {
  const match = String(error?.message || '').match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return match ? (Number.parseInt(match[1], 10) + 1) * 1000 : null;
}

function isRateLimited(error) {
  return error?.status === 429 || /"code"\s*:\s*429/.test(String(error?.message || ''));
}

/**
 * The free tier enforces TWO embedding quotas: 100 per minute and 1000 per day.
 * A per-minute breach clears in ~30s and is worth retrying. A per-day breach
 * does not clear until tomorrow — Gemini still reports a ~60s retryDelay, which
 * is misleading, and retrying against it just burns minutes per task and still
 * fails. Distinguish them so a daily exhaustion stops immediately.
 */
function isDailyQuota(error) {
  return /PerDay|RequestsPerDay/i.test(String(error?.message || ''));
}

/**
 * One embed call with the shared limiter, retry, and daily-quota handling.
 * @param {string|string[]} contents
 * @returns {Promise<number[][]>} One vector per input, in order
 */
async function embedWithRetry(texts) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireSlots(texts.length);
    try {
      // The SDK's embedContent treats an array of strings as PARTS OF ONE
      // document and returns a single vector for the lot. The batch endpoint
      // has to be called directly to get one vector per text.
      const res = await fetch(
        `${API_BASE}/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${encodeURIComponent(config.gemini.apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: texts.map((text) => ({
              model: `models/${EMBEDDING_MODEL}`,
              content: { parts: [{ text }] },
              outputDimensionality: EMBEDDING_DIMENSIONS,
            })),
          }),
        }
      );

      const body = await res.json();
      if (!res.ok || body.error) {
        const error = new Error(JSON.stringify(body.error || body));
        error.status = res.status;
        throw error;
      }

      const vectors = (body.embeddings || []).map((e) => e.values);
      if (vectors.length !== texts.length) {
        throw new Error(`Batch returned ${vectors.length} vectors for ${texts.length} texts`);
      }
      return vectors;
    } catch (error) {
      lastError = error;

      if (isDailyQuota(error)) {
        const quotaError = new Error(
          'Gemini embedding DAILY quota exhausted (free tier: 1000/day). ' +
            'Indexing cannot continue until the quota resets or billing is enabled.'
        );
        quotaError.status = 429;
        quotaError.dailyQuotaExhausted = true;
        logger.error(quotaError.message, { attempt });
        throw quotaError;
      }

      if (!isRateLimited(error) || attempt === MAX_ATTEMPTS) throw error;

      // Honour Gemini's own retryDelay; it knows when the window resets.
      const delay = retryDelayMs(error) ?? 2000 * 2 ** (attempt - 1);
      logger.warn('Embedding rate limited — waiting', { attempt, delayMs: delay });

      // The window is exhausted, so stop granting slots until it resets too.
      windowStart = Date.now() + delay - RATE_WINDOW_MS;
      windowCount = RATE_LIMIT_PER_MIN;

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Generate a 1536-dimensional embedding for the given text.
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function generateEmbedding(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot generate embedding for empty text');
  }
  const [vector] = await embedWithRetry([text]);
  if (!vector) throw new Error('Embedding response contained no vector');
  return vector;
}

/**
 * Embed many texts using as few API requests as possible.
 *
 * MEASURED: the quota counts texts, not requests, so this does NOT reduce quota
 * consumption — 1000 texts/day is a hard ceiling either way. What it buys is
 * latency: 100 texts in roughly 3 seconds instead of 100 sequential calls. Use
 * it for bulk work; the ceiling has to be met by embedding fewer things.
 *
 * @param {string[]} texts
 * @param {Object} [options]
 * @param {number} [options.batchSize=100]
 * @returns {Promise<Array<number[]|null>>} A vector per input; null where a text was unusable
 */
async function generateEmbeddings(texts, { batchSize = EMBEDDING_BATCH_SIZE } = {}) {
  const results = new Array(texts.length).fill(null);

  // Empty strings are rejected by the API and would fail the whole batch.
  const usable = texts.map((t, i) => ({ t, i })).filter(({ t }) => t && t.trim().length > 0);

  for (let start = 0; start < usable.length; start += batchSize) {
    const slice = usable.slice(start, start + batchSize);
    const vectors = await embedWithRetry(slice.map(({ t }) => t));

    if (vectors.length !== slice.length) {
      logger.warn('Batch returned a different number of vectors than requested', {
        requested: slice.length,
        received: vectors.length,
      });
    }
    slice.forEach(({ i }, n) => {
      if (vectors[n]) results[i] = vectors[n];
    });
  }

  return results;
}

module.exports = {
  generateEmbedding,
  generateEmbeddings,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
