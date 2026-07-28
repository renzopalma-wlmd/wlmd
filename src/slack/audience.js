const logger = require('../utils/logger');

// Who is in the room decides what the bot is allowed to say out loud.
//
// Email domains would be the obvious test, but the bot token does not hold
// users:read.email, and adding it means a reinstall. These signals need no new
// scope and are in fact more precise for this workspace:
//   - guests (is_restricted / is_ultra_restricted) are how clients are invited
//   - a different team_id means a Slack Connect member from another org
// Measured: wlmd-obsidiangenetics has 4 guests among 27 workspace members.
const USER_TTL_MS = 30 * 60 * 1000;
const CHANNEL_TTL_MS = 10 * 60 * 1000;

const userCache = new Map();
const channelCache = new Map();
let homeTeamId = null;

function createAudience(slack) {
  async function getHomeTeamId() {
    if (!homeTeamId) homeTeamId = (await slack.auth.test()).team_id;
    return homeTeamId;
  }

  /**
   * @param {string} userId
   * @returns {Promise<'internal'|'external'|'bot'|'unknown'>}
   */
  async function classifyUser(userId) {
    if (!userId) return 'unknown';

    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.at < USER_TTL_MS) return cached.kind;

    let kind = 'unknown';
    try {
      const [{ user }, teamId] = await Promise.all([slack.users.info({ user: userId }), getHomeTeamId()]);
      if (user.is_bot) kind = 'bot';
      else if (user.is_restricted || user.is_ultra_restricted || user.is_stranger) kind = 'external';
      else if (user.team_id && user.team_id !== teamId) kind = 'external';
      else kind = 'internal';
    } catch (error) {
      // Unknown must not be treated as internal: that would leak analysis to
      // whoever we failed to identify. Callers treat unknown as external.
      logger.warn('Could not classify user', { userId, error: error.message });
    }

    userCache.set(userId, { at: Date.now(), kind });
    return kind;
  }

  /**
   * Does this channel contain anyone outside the company?
   * @param {string} channelId
   * @returns {Promise<{hasExternals: boolean, externals: number, members: number}>}
   */
  async function inspectChannel(channelId) {
    const cached = channelCache.get(channelId);
    if (cached && Date.now() - cached.at < CHANNEL_TTL_MS) return cached.value;

    let value = { hasExternals: true, externals: 0, members: 0 };
    try {
      const { members = [] } = await slack.conversations.members({ channel: channelId, limit: 200 });
      const kinds = await Promise.all(members.map((id) => classifyUser(id)));
      const externals = kinds.filter((k) => k === 'external' || k === 'unknown').length;
      value = { hasExternals: externals > 0, externals, members: members.length };
    } catch (error) {
      // Fail closed: if membership cannot be read, assume clients are present
      // and keep the reply private.
      logger.warn('Could not inspect channel membership — assuming external present', {
        channelId,
        error: error.message,
      });
    }

    channelCache.set(channelId, { at: Date.now(), value });
    return value;
  }

  return { classifyUser, inspectChannel };
}

module.exports = { createAudience };
