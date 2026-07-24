const { generateEmbedding } = require('../embeddings');
const { insertContext } = require('../supabase');
const logger = require('../utils/logger');

/**
 * Register the Slack message listener.
 * Indexes all non-bot messages into the knowledge_context table.
 * @param {import('@slack/bolt').App} app - Slack Bolt app
 */
function registerMessageListener(app) {
  app.message(async ({ message }) => {
    // Ignore bot messages, system events, and message edits/deletes
    if (message.subtype || message.bot_id) return;

    // Ignore very short messages (less than 10 chars — likely not useful context)
    if (!message.text || message.text.trim().length < 10) return;

    try {
      // Generate embedding for the message
      const embedding = await generateEmbedding(message.text);

      // Store in Supabase
      await insertContext({
        source: 'slack',
        externalId: message.channel,
        authorId: message.user,
        content: message.text,
        metadata: {
          ts: message.ts,
          thread_ts: message.thread_ts || null,
          channel: message.channel,
        },
        embedding,
      });
    } catch (error) {
      logger.error('Failed to index Slack message', {
        error: error.message,
        channel: message.channel,
        user: message.user,
      });
    }
  });

  logger.info('Slack message listener registered');
}

module.exports = { registerMessageListener };
