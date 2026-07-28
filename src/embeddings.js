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
 * Generate a 1536-dimensional embedding for the given text.
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
async function generateEmbedding(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('Cannot generate embedding for empty text');
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireSlot();
    try {
      const response = await ai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: text,
        config: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
        },
      });
      return response.embeddings[0].values;
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


module.exports = {
  generateEmbedding,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
