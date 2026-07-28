const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { WebClient } = require('@slack/web-api');
const config = require('../config');
const { answerQuestion, briefChannel, analyzeCoherence } = require('../rag');
const { getChannelStats, countScope } = require('../supabase');
const logger = require('../utils/logger');

const slack = new WebClient(config.slack.botToken);

// Briefings cost a Gemini generation each, and the free tier is already tight.
// Selecting a channel twice in a row shouldn't spend two calls.
const BRIEFING_TTL_MS = 5 * 60 * 1000;
const briefingCache = new Map();
const coherenceCache = new Map();

// Channel membership changes rarely; the Slack call is the slow part of the list.
const CHANNEL_TTL_MS = 60 * 1000;
let channelCache = { at: 0, channels: null };

// Slack expands <@U…> into a display name client-side. A web page gets no such
// help, so the raw ID has to be resolved here or the UI shows gibberish.
const USER_TTL_MS = 30 * 60 * 1000;
let userCache = { at: 0, names: null };

async function getUserNames() {
  if (userCache.names && Date.now() - userCache.at < USER_TTL_MS) return userCache.names;

  const names = new Map();
  try {
    let cursor;
    do {
      const page = await slack.users.list({ limit: 200, cursor });
      for (const member of page.members || []) {
        names.set(member.id, member.profile?.display_name || member.profile?.real_name || member.name);
      }
      cursor = page.response_metadata?.next_cursor || '';
    } while (cursor);
    userCache = { at: Date.now(), names };
  } catch (error) {
    // Readable IDs are a nicety — never fail a briefing over them.
    logger.warn('Could not resolve user names', { error: error.message });
    return userCache.names || names;
  }
  return names;
}

/**
 * Rewrite Slack's rendering tokens into plain readable text.
 *
 * Slack expands <@U…>, <#C…> and <!date^…> in its own client. A browser gets
 * none of that, so leaving them raw shows the reader bare IDs — which is the
 * exact defect this dashboard exists to avoid.
 *
 * @param {string|null} text
 * @returns {Promise<string|null>}
 */
async function resolveSlackTokens(text) {
  if (!text) return text;

  let out = text;

  if (out.includes('<@')) {
    const names = await getUserNames();

    // users.list omits some accounts — Slack Connect members, guests, deactivated
    // users — so anything it missed is looked up individually. Without this the
    // reader sees a bare ID next to real names, which is worse than either.
    const missing = [...new Set([...out.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]))].filter(
      (id) => !names.has(id)
    );
    if (missing.length) {
      await Promise.all(
        missing.map(async (id) => {
          try {
            const { user } = await slack.users.info({ user: id });
            names.set(id, user.profile?.display_name || user.profile?.real_name || user.name || id);
          } catch (error) {
            // Cache the failure so one unknown ID isn't re-fetched every request.
            names.set(id, null);
            logger.warn('Could not resolve user id', { id, error: error.message });
          }
        })
      );
    }

    out = out.replace(/<@([A-Z0-9]+)>/g, (match, id) => {
      const name = names.get(id);
      return name ? `@${name}` : match;
    });
  }

  if (out.includes('<#')) {
    const channels = await listChannels().catch(() => []);
    const byId = new Map(channels.map((c) => [c.id, c.name]));
    out = out.replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (match, id, inline) => {
      const name = byId.get(id) || inline;
      return name ? `#${name}` : match;
    });
  }

  // <!date^1785035488^{…}|Jul 26, 2026 3:11 AM UTC> -> "Jul 26, 03:11"
  out = out.replace(/<!date\^(\d+)\^[^|>]*(?:\|([^>]*))?>/g, (match, epoch, fallback) => {
    const date = new Date(Number.parseInt(epoch, 10) * 1000);
    if (Number.isNaN(date.getTime())) return fallback || match;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC',
    });
  });

  return out;
}

/** Constant-time token comparison, tolerant of unequal lengths. */
function tokenMatches(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Bearer-token gate. Refuses to serve anything when DASHBOARD_TOKEN is unset —
 * these endpoints expose private client-channel content, so an unconfigured
 * deploy must be closed, not open.
 */
function requireAuth(req, res, next) {
  if (!config.dashboard.token) {
    logger.error('Dashboard request refused — DASHBOARD_TOKEN is not configured');
    return res.status(503).json({
      error: 'Dashboard is not configured. Set DASHBOARD_TOKEN to enable it.',
    });
  }

  const header = req.get('authorization') || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!provided || !tokenMatches(provided, config.dashboard.token)) {
    logger.warn('Dashboard auth failed', { ip: req.ip, path: req.path });
    return res.status(401).json({ error: 'Invalid or missing token.' });
  }
  return next();
}

/** Channels the bot can see, joined with what's actually indexed. */
async function listChannels() {
  if (channelCache.channels && Date.now() - channelCache.at < CHANNEL_TTL_MS) {
    return channelCache.channels;
  }

  const [result, stats] = await Promise.all([
    slack.users.conversations({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
    }),
    getChannelStats(),
  ]);

  // Pilot scope: restrict the dashboard to the channels under test. Applied here
  // so it also governs the briefing/ask/coherence endpoints via isPilotChannel.
  const pilot = config.dashboard.pilotChannelIds;
  const visible = pilot.length
    ? result.channels.filter((c) => pilot.includes(c.id))
    : result.channels;

  const channels = visible
    .map((c) => {
      const stat = stats.get(c.id) || { rows: 0, lastActivity: null };
      return {
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        indexedMessages: stat.rows,
        lastActivity: stat.lastActivity,
      };
    })
    // Channels with activity first, then alphabetical.
    .sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '') || a.name.localeCompare(b.name));

  channelCache = { at: Date.now(), channels };
  return channels;
}

/**
 * Is this scope allowed in the dashboard? A pilot allowlist that only hid rows
 * from the sidebar would still serve any channel to anyone who guessed an id.
 */
function isAllowedScope(id) {
  const pilot = config.dashboard.pilotChannelIds;
  if (pilot.length === 0) return true;
  // ClickUp list ids are numeric and reached only through a pilot channel.
  return /^\d{6,}$/.test(id) || pilot.includes(id);
}

/**
 * Explain why a channel has nothing indexed.
 *
 * "No activity yet" is wrong for every real case: the channel may be full of
 * messages that were never backfilled, or full of bot notifications that can
 * never be indexed. Those need different actions, so they need different words.
 * Only called for empty channels, so it costs one Slack call on demand.
 *
 * @param {string} channelId
 * @returns {Promise<{kind: string, detail: string}>}
 */
async function diagnoseEmptyChannel(channelId) {
  try {
    const { messages = [] } = await slack.conversations.history({ channel: channelId, limit: 200 });
    if (messages.length === 0) {
      return { kind: 'truly-empty', detail: 'This channel has no messages at all.' };
    }

    const human = messages.filter(
      (m) => !m.subtype && !m.bot_id && (m.text || '').trim().length >= 10
    ).length;
    const bots = messages.filter((m) => m.bot_id).length;

    // Judge by ratio, not by "zero humans". A notification feed with a handful
    // of stray human messages is still a notification feed, and calling it
    // backfillable would promise usefulness that isn't there.
    if (bots / messages.length > 0.8) {
      return {
        kind: 'bot-only',
        detail:
          `${bots} of the last ${messages.length} messages here are app notifications` +
          (human > 0 ? `, with only ${human} from people` : '') +
          '. Notifications are skipped because they carry no context of their own — ' +
          'a status change with no task name cannot be attributed to anything. ' +
          'Board state comes from the ClickUp sync instead.',
      };
    }
    if (human === 0) {
      return { kind: 'no-substance', detail: 'Recent messages are all too short or system events to be useful.' };
    }
    return {
      kind: 'needs-backfill',
      detail:
        `About ${human} of the last ${messages.length} messages are indexable, but none have been imported yet. ` +
        'The bot only sees messages posted while it is running — run the Slack backfill to load the history.',
    };
  } catch (error) {
    logger.warn('Could not diagnose empty channel', { channelId, error: error.message });
    return { kind: 'unknown', detail: 'Nothing indexed yet for this channel.' };
  }
}

/**
 * Reject anything that isn't a scope we recognise, before it reaches the
 * database. A scope is either a Slack channel or a ClickUp list.
 */
function isScopeId(value) {
  return typeof value === 'string' && (/^[CG][A-Z0-9]{6,}$/.test(value) || /^\d{6,}$/.test(value));
}

/** ClickUp list ids are numeric; Slack channel ids are not. */
function scopeKind(value) {
  return /^\d{6,}$/.test(value) ? 'board' : 'channel';
}

/**
 * Create the dashboard router: static UI plus the JSON API.
 * @returns {express.Router}
 */
function createDashboardRouter() {
  const router = express.Router();

  router.use('/dashboard', express.static(path.join(__dirname, '../../public')));
  router.use('/api', express.json({ limit: '32kb' }), requireAuth);

  // Lets the UI verify a token before rendering anything.
  router.get('/api/session', (req, res) => res.json({ ok: true }));

  router.get('/api/channels', async (req, res) => {
    try {
      // Boards are deliberately not listed. ClickUp is reached through a
      // channel's related tasks, so the unit of navigation is the project.
      const [channels, clickupRows] = await Promise.all([
        listChannels(),
        countScope({ source: 'clickup' }).catch(() => 0),
      ]);
      // The UI must be able to say "this index is partial". Trusting a partial
      // index as complete is the failure mode this whole system keeps hitting.
      res.json({
        channels,
        index: {
          slackRows: channels.reduce((n, c) => n + c.indexedMessages, 0),
          clickupRows,
          channelsWithData: channels.filter((c) => c.indexedMessages > 0).length,
          channelsTotal: channels.length,
        },
      });
    } catch (error) {
      logger.error('Failed to list channels', { error: error.message });
      res.status(502).json({ error: 'Could not load channels from Slack.' });
    }
  });

  router.get('/api/channels/:id/briefing', async (req, res) => {
    const { id } = req.params;
    if (!isScopeId(id)) return res.status(400).json({ error: 'Invalid channel or board id.' });
    if (!isAllowedScope(id)) return res.status(404).json({ error: 'Channel is not in the current pilot scope.' });

    const fresh = req.query.refresh === '1';
    const cached = briefingCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < BRIEFING_TTL_MS) {
      return res.json({ ...cached.payload, cached: true });
    }

    try {
      const result = await briefChannel(id, { kind: scopeKind(id) });
      // An empty scope is the case most likely to be misread as "broken", so
      // say precisely why rather than leaving the reader to guess.
      if (result.empty && scopeKind(id) === 'channel') {
        result.diagnosis = await diagnoseEmptyChannel(id);
      }
      const payload = {
        ...result,
        briefing: await resolveSlackTokens(result.briefing),
        generatedAt: new Date().toISOString(),
      };
      briefingCache.set(id, { at: Date.now(), payload });
      res.json({ ...payload, cached: false });
    } catch (error) {
      logger.error('Briefing failed', { channelId: id, error: error.message });
      res.status(502).json({
        error: error?.dailyQuotaExhausted
          ? "Today's AI quota is used up (resets tomorrow)."
          : 'Could not generate a briefing right now.',
      });
    }
  });

  router.get('/api/channels/:id/coherence', async (req, res) => {
    const { id } = req.params;
    if (!isScopeId(id)) return res.status(400).json({ error: 'Invalid channel or board id.' });
    if (!isAllowedScope(id)) return res.status(404).json({ error: 'Channel is not in the current pilot scope.' });

    const fresh = req.query.refresh === '1';
    const cached = coherenceCache.get(id);
    if (!fresh && cached && Date.now() - cached.at < BRIEFING_TTL_MS) {
      return res.json({ ...cached.payload, cached: true });
    }

    try {
      const result = await analyzeCoherence(id);
      const payload = {
        empty: result.empty,
        reason: result.reason || null,
        messageCount: result.messageCount,
        analysis: await resolveSlackTokens(result.analysis),
        related: await Promise.all(
          result.related.map(async (task) => ({
            ref: (task.content.match(/^\[([^\]]+)\]/) || [])[1] || null,
            title: task.content.split('\n')[0].replace(/^\[[^\]]+\]\s*/, ''),
            status: task.metadata?.status || null,
            priority: task.metadata?.priority || null,
            assignees: task.metadata?.assignees || [],
            dueDate: task.metadata?.due_date || null,
            url: task.metadata?.url || null,
            board: task.metadata?.list_name || null,
            similarity: task.similarity,
            matchedVia: await resolveSlackTokens(task.matchedVia || ''),
          }))
        ),
      };
      coherenceCache.set(id, { at: Date.now(), payload });
      res.json({ ...payload, cached: false });
    } catch (error) {
      logger.error('Coherence analysis failed', { channelId: id, error: error.message });
      res.status(502).json({
        error: error?.dailyQuotaExhausted
          ? "Today's AI quota is used up (resets tomorrow)."
          : 'Could not analyse alignment right now.',
      });
    }
  });

  router.post('/api/channels/:id/ask', async (req, res) => {
    const { id } = req.params;
    if (!isScopeId(id)) return res.status(400).json({ error: 'Invalid channel or board id.' });
    if (!isAllowedScope(id)) return res.status(404).json({ error: 'Channel is not in the current pilot scope.' });

    const question = String(req.body?.question || '').trim();
    if (question.length < 3) return res.status(400).json({ error: 'Ask a longer question.' });
    if (question.length > 1000) return res.status(400).json({ error: 'Question is too long.' });

    try {
      // Same pipeline the Slack bot uses, scoped to the selected channel.
      const { answer, sources, scope } = await answerQuestion(question, { channelId: id });
      res.json({ answer: await resolveSlackTokens(answer), scope, sourceCount: sources.length });
    } catch (error) {
      logger.error('Dashboard question failed', { channelId: id, error: error.message });
      // Distinguish "out of quota until tomorrow" from a transient fault, and
      // point at the one thing that still works without an embedding call.
      res.status(502).json({
        error: error?.dailyQuotaExhausted
          ? "Today's AI search quota is used up (resets tomorrow). Questions starting with \"list\" still work — they read the channel directly instead of searching."
          : 'Could not answer that right now.',
      });
    }
  });

  logger.info('Dashboard router created at /dashboard');
  return router;
}

module.exports = { createDashboardRouter };
