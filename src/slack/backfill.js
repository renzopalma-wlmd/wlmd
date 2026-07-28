const { WebClient } = require('@slack/web-api');
const config = require('../config');
const { generateEmbedding } = require('../embeddings');
const { supabase, insertContext } = require('../supabase');
const logger = require('../utils/logger');

const slack = new WebClient(config.slack.botToken);

// Must match the live indexer in listeners/messages.js, or backfilled history
// obeys different rules than anything indexed going forward.
const MIN_LENGTH = 10;

/** Same screening the live message listener applies. */
function shouldIndex(message, botUserId) {
  if (message.subtype || message.bot_id) return false;
  if (!message.text || message.text.trim().length < MIN_LENGTH) return false;
  if (botUserId && message.text.includes(`<@${botUserId}>`)) return false;
  return true;
}

/** Timestamps already indexed for a channel, so a re-run doesn't duplicate. */
async function existingTimestamps(channelId) {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('metadata')
    .eq('source', 'slack')
    .eq('external_id', channelId);

  if (error) throw error;
  return new Set(data.map((row) => row.metadata?.ts).filter(Boolean));
}

/**
 * Collect indexable messages from a channel's history, including thread replies.
 * Thread replies do not appear in conversations.history, so threads are fetched
 * separately — most of the substance in these channels lives in threads.
 *
 * @param {string} channelId
 * @param {Object} options
 * @param {number} options.oldest - Epoch seconds cutoff
 * @param {string} [options.botUserId]
 * @param {boolean} [options.includeThreads=true]
 * @returns {Promise<{messages: Array, scanned: number, threads: number}>}
 */
async function collectMessages(channelId, { oldest, botUserId, includeThreads = true }) {
  const messages = [];
  const threadParents = [];
  let scanned = 0;
  let cursor;

  do {
    const page = await slack.conversations.history({
      channel: channelId,
      oldest: String(oldest),
      limit: 200,
      cursor,
    });

    for (const message of page.messages || []) {
      scanned++;
      if (message.reply_count > 0 && message.thread_ts) threadParents.push(message.thread_ts);
      if (shouldIndex(message, botUserId)) messages.push({ ...message, channel: channelId });
    }
    cursor = page.response_metadata?.next_cursor || '';
  } while (cursor);

  if (includeThreads) {
    for (const threadTs of threadParents) {
      const replies = await slack.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
      });
      for (const reply of replies.messages || []) {
        // The parent is returned again by this endpoint; history already had it.
        if (reply.ts === threadTs) continue;
        scanned++;
        if (shouldIndex(reply, botUserId)) messages.push({ ...reply, channel: channelId });
      }
    }
  }

  return { messages, scanned, threads: threadParents.length };
}

/**
 * Backfill one channel.
 * @param {string} channelId
 * @param {Object} options
 * @param {number} options.oldest
 * @param {string} [options.botUserId]
 * @param {boolean} [options.dryRun=false]
 * @returns {Promise<{scanned: number, indexable: number, alreadyIndexed: number, inserted: number, failed: number, threads: number}>}
 */
async function backfillChannel(channelId, { oldest, botUserId, dryRun = false, limit = Infinity }) {
  const [{ messages, scanned, threads }, seen] = await Promise.all([
    collectMessages(channelId, { oldest, botUserId }),
    existingTimestamps(channelId),
  ]);

  // Respect the caller's remaining budget so a run can stop deliberately at the
  // daily allowance instead of failing partway with a quota error.
  const fresh = messages.filter((m) => !seen.has(m.ts)).slice(0, limit);
  const stats = {
    scanned,
    threads,
    indexable: messages.length,
    alreadyIndexed: messages.length - fresh.length,
    inserted: 0,
    failed: 0,
  };

  if (dryRun) return stats;

  for (const message of fresh) {
    try {
      const embedding = await generateEmbedding(message.text);
      await insertContext({
        source: 'slack',
        externalId: message.channel,
        authorId: message.user,
        content: message.text,
        metadata: {
          ts: message.ts,
          thread_ts: message.thread_ts || null,
          channel: message.channel,
          backfilled: true,
        },
        embedding,
      });
      stats.inserted++;
    } catch (error) {
      stats.failed++;
      logger.error('Backfill insert failed', { channel: channelId, ts: message.ts, error: error.message });
      if (error.dailyQuotaExhausted) throw error;
    }
  }

  return stats;
}

/** Channels the bot is a member of. */
async function listChannels() {
  const result = await slack.users.conversations({
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  });
  return result.channels.map((c) => ({ id: c.id, name: c.name }));
}

async function getBotUserId() {
  const auth = await slack.auth.test();
  return auth.user_id;
}

module.exports = { backfillChannel, listChannels, getBotUserId, shouldIndex };
