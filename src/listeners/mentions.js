const config = require('../config');
const { createAudience } = require('../slack/audience');
const { countScope } = require('../supabase');
const { answerQuestion, detectMetaIntent } = require('../rag');
const { toMrkdwn, channelRef, dateRef, truncateForSlack } = require('../utils/slack-format');
const logger = require('../utils/logger');

/**
 * Build the source attribution footer.
 * Reports where the context came from and when, rather than similarity scores
 * — those were developer diagnostics that meant nothing to the reader.
 * @param {Array<{source: string, channelId: ?string, taskId: ?string, epoch: ?number}>} sources
 * @returns {string} Footer text, or '' when there are no sources
 */
function buildSourceFooter(sources) {
  if (!sources || sources.length === 0) return '';

  const slack = sources.filter((s) => s.source === 'slack');
  const clickup = sources.filter((s) => s.source === 'clickup');

  const counts = [];
  if (slack.length) counts.push(`💬 ${slack.length} Slack message${slack.length === 1 ? '' : 's'}`);
  if (clickup.length) counts.push(`📋 ${clickup.length} ClickUp update${clickup.length === 1 ? '' : 's'}`);

  const parts = [counts.join(' · ')];

  // Distinct channels, capped so a wide sweep doesn't produce a wall of links.
  const channels = [...new Set(slack.map((s) => s.channelId).filter(Boolean))];
  const refs = channels.slice(0, 4).map(channelRef).filter(Boolean);
  if (refs.length) {
    const overflow = channels.length - refs.length;
    parts.push(`from ${refs.join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`);
  }

  // Time span of the evidence, rendered in each reader's own timezone.
  const epochs = sources.map((s) => s.epoch).filter((e) => Number.isFinite(e));
  if (epochs.length) {
    const oldest = dateRef(Math.min(...epochs), '{date_short_pretty}');
    const newest = dateRef(Math.max(...epochs), '{date_short_pretty}');
    if (oldest && newest) parts.push(oldest === newest ? oldest : `${oldest} – ${newest}`);
  }

  return `\n\n_${parts.filter(Boolean).join(' · ')}_`;
}

// Channels the bot can see, cached — used to resolve a channel named inside a
// question.
const CHANNEL_LIST_TTL_MS = 5 * 60 * 1000;
let channelList = { at: 0, channels: [] };

async function listVisibleChannels(client) {
  if (channelList.channels.length && Date.now() - channelList.at < CHANNEL_LIST_TTL_MS) {
    return channelList.channels;
  }
  try {
    const res = await client.users.conversations({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    });
    channelList = { at: Date.now(), channels: res.channels.map((c) => ({ id: c.id, name: c.name })) };
  } catch (error) {
    logger.warn('Could not list channels for name resolution', { error: error.message });
  }
  return channelList.channels;
}

/**
 * If the question names a channel, answer about THAT channel.
 *
 * Scoping to wherever the question happened to be typed is right for privacy but
 * obtuse in practice: "give me details about obsidiangenetics" asked from
 * another channel was refused even though that channel is fully indexed. Naming
 * a channel is an explicit request, and delivery is already restricted to the
 * asker, so honour it.
 *
 * @returns {Promise<{id: string, name: string}|null>}
 */
async function resolveNamedChannel(question, client, currentChannelId) {
  const channels = await listVisibleChannels(client);
  if (!channels.length) return null;

  // Typing #channel in Slack sends <#C123|name>.
  const linked = question.match(/<#([A-Z0-9]+)(?:\|[^>]*)?>/);
  if (linked) {
    const hit = channels.find((c) => c.id === linked[1]);
    if (hit && hit.id !== currentChannelId) return hit;
  }

  // Otherwise match on the channel name as plain text. Longest name first so
  // "wlmd-internal-design-team" wins over a shorter partial.
  const haystack = question.toLowerCase();
  const byLength = [...channels].sort((a, b) => b.name.length - a.name.length);
  for (const channel of byLength) {
    if (channel.id === currentChannelId) continue;
    const name = channel.name.toLowerCase();
    // Require a distinctive name so a word like "testing" doesn't hijack a
    // question that merely happens to contain it.
    if (name.length < 6) continue;
    const stem = name.replace(/^wlmd-/, '');
    if (haystack.includes(name) || (stem.length >= 6 && haystack.includes(stem))) return channel;
  }
  return null;
}

/**
 * Decide where a reply may be shown.
 *
 * Clients are invited into the project channels as guests, so a public reply
 * puts an internal read of their project in front of them — a briefing saying
 * "risk of losing them" must never land in the client's own channel. The
 * delivery mode therefore depends on who is in the room, not on what was asked.
 *
 * @returns {Promise<{mode: 'public'|'ephemeral'|'refuse', reason: string}>}
 */
async function decideDelivery({ audience, channelId, userId, isDm }) {
  const asker = await audience.classifyUser(userId);

  // A DM is private by construction — nobody else can read it.
  if (isDm) {
    return asker === 'internal'
      ? { mode: 'public', reason: 'dm' }
      : { mode: 'refuse', reason: 'external asker' };
  }

  if (asker !== 'internal') return { mode: 'refuse', reason: 'external asker' };

  const { hasExternals, externals } = await audience.inspectChannel(channelId);
  return hasExternals
    ? { mode: 'ephemeral', reason: `${externals} external member(s) present` }
    : { mode: 'public', reason: 'all-internal channel' };
}

/**
 * Register the @mention listener and the DM handler.
 *
 * DMs are the recommended way to use this: private, no thread to open, and
 * cross-channel questions are safe because only one person can read the answer.
 *
 * @param {import('@slack/bolt').App} app - Slack Bolt app
 */
function registerMentionListener(app) {
  const audience = createAudience(app.client);

  async function handleQuestion({ event, client, isDm }) {
    const channelId = event.channel;
    const userId = event.user;
    const threadTs = isDm ? undefined : event.thread_ts || event.ts;

    // Ephemeral messages cannot be edited, so the placeholder-then-update
    // pattern only works where a real message can be posted.
    const post = async (text) => {
      if (delivery.mode === 'ephemeral') {
        return client.chat.postEphemeral({ channel: channelId, user: userId, text, thread_ts: threadTs });
      }
      return client.chat.postMessage({ channel: channelId, text, thread_ts: threadTs });
    };

    let delivery = { mode: 'ephemeral', reason: 'not yet decided' };
    let placeholder = null;

    try {
      delivery = await decideDelivery({ audience, channelId, userId, isDm });

      if (delivery.mode === 'refuse') {
        logger.warn('Declined to answer', { user: userId, channel: channelId, reason: delivery.reason });
        await client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: "👋 I'm an internal tool for the Whitelabel MD team, so I can't answer here. Your project contact can help with anything you need.",
          thread_ts: threadTs,
        });
        return;
      }

      logger.info('Answering question', { channel: channelId, mode: delivery.mode, reason: delivery.reason, isDm });

      if (delivery.mode === 'public') {
        placeholder = await client.chat.postMessage({
          channel: channelId,
          text: '🔍 Searching and thinking…',
          thread_ts: threadTs,
        });
      } else {
        // Ephemeral has no editable handle, so this is feedback only.
        await post('🔍 Searching and thinking… (only you will see my reply)');
      }

      const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      const reply = async (text) => {
        if (placeholder) {
          try {
            await client.chat.update({ channel: channelId, ts: placeholder.ts, text });
            return;
          } catch (error) {
            logger.warn('Could not update placeholder, posting fresh', { error: error.message });
          }
        }
        await post(text);
      };

      if (!question || question.length < 3) {
        await reply(
          isDm
            ? "👋 Ask me about any channel I'm in — try *what's blocking wlmd-obsidiangenetics?* or *catch me up on internal-mgmt*."
            : "👋 Ask me about this channel — status, blockers, decisions, or what you missed."
        );
        return;
      }

      if (detectMetaIntent(question) && !config.access.adminUserIds.includes(userId)) {
        logger.warn('Blocked technical question from non-admin', { user: userId, channel: channelId });
        await reply(
          "🔒 I don't discuss how I'm built or configured. Ask me about the project instead — status, blockers, decisions, or what you missed."
        );
        return;
      }

      // A DM has no project of its own, so it searches across everything the
      // bot can see. In a channel the answer stays scoped to that channel —
      // unless the question names a different one.
      const named = await resolveNamedChannel(question, client, channelId);
      const target = named ? named.id : isDm ? null : channelId;
      if (named) logger.info('Question retargeted to a named channel', { from: channelId, to: named.name });

      // An empty scope reads as "the bot is broken" unless it says otherwise.
      // Distinguish "nothing indexed here" from "indexed, but no match".
      if (target) {
        const indexed = await countScope({ externalId: target });
        if (indexed === 0) {
          const where = named ? `<#${named.id}>` : 'this channel';
          await reply(
            `📭 I have nothing indexed for ${where} yet, so I can't answer about it.\n\n` +
              'I only see messages posted while I\'m running, and this channel has never been imported. ' +
              'Ask me about a channel I already cover, or ask an admin to run the Slack backfill.'
          );
          return;
        }
      }

      const { answer, sources } = await answerQuestion(question, { channelId: target });

      const prefix = named ? `_Answering about <#${named.id}>._\n\n` : '';
      await reply(`${prefix}${truncateForSlack(toMrkdwn(answer))}${buildSourceFooter(sources)}`);
    } catch (error) {
      logger.error('Failed to handle question', { error: error.message, user: userId, channel: channelId });

      const status = typeof error?.status === 'number'
        ? error.status
        : Number.parseInt((String(error?.message || '').match(/"code"\s*:\s*(\d{3})/) || [])[1], 10);

      const text = error?.dailyQuotaExhausted
        ? "📉 I've hit today's AI usage limit, so I can't search right now. It resets tomorrow. Ask me to *list* the recent messages and I can still answer that without searching."
        : status === 503 || status === 429
          ? '⏳ The AI model is overloaded right now and did not recover after several retries. Please ask again in a moment.'
          : '❌ Sorry, I hit an error while processing your question. Please try again.';

      try {
        await post(text);
      } catch (postError) {
        logger.error('Could not deliver error message', { error: postError.message });
      }
    }
  }

  app.event('app_mention', async ({ event, client }) => {
    await handleQuestion({ event, client, isDm: false });
  });

  // Direct messages. Bolt delivers these as `message` events with channel_type
  // im; they are questions, never content to index.
  app.message(async ({ message, client, next }) => {
    if (message.channel_type !== 'im' || message.subtype || message.bot_id) {
      await next();
      return;
    }
    await handleQuestion({ event: message, client, isDm: true });
  });

  logger.info('Mention + DM listeners registered');
}

module.exports = { registerMentionListener, buildSourceFooter };
