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

// Texts per request. The quota counts requests, so a larger batch means a bulk
// import costs proportionally less of the daily allowance.
const EMBEDDING_BATCH_SIZE = Number.parseInt(process.env.EMBEDDING_BATCH_SIZE || '100', 10);

let windowStart = Date.now();
let windowCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Block until a request slot is free in the current minute. */
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    if (now - windowStart >= RATE_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount < RATE_LIMIT_PER_MIN) {
      windowCount++;
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
async function embedWithRetry(contents) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // One slot per REQUEST, not per text — the quota metric is
    // embed_content_free_tier_requests, so a batch costs the same as a single.
    await acquireSlot();
    try {
      const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents,
        config: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
        },
      });
      return (response.embeddings || []).map((e) => e.values);
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
  const [vector] = await embedWithRetry(text);
  if (!vector) throw new Error('Embedding response contained no vector');
  return vector;
}

/**
 * Embed many texts using as few API requests as possible.
 *
 * The SDK posts to :batchEmbedContents and `contents` accepts a list, so N texts
 * cost one request. The free-tier quota is counted in REQUESTS
 * (embed_content_free_tier_requests), which makes batching the difference
 * between a bulk import fitting inside a day's allowance or taking three days.
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
