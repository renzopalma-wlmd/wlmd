const { answerQuestion } = require('../rag');
const logger = require('../utils/logger');

/**
 * Register the @mention listener.
 * When the bot is mentioned, it runs the RAG pipeline and responds in-thread.
 * @param {import('@slack/bolt').App} app - Slack Bolt app
 */
function registerMentionListener(app) {
  app.event('app_mention', async ({ event, say, client }) => {
    try {
      // Send immediate thinking feedback in-thread
      const thinkingMsg = await say({
        text: '🔍 Searching workspace context and thinking...',
        thread_ts: event.ts,
      });

      // Strip the bot mention from the question text
      // Bot mentions look like <@U1234567890>
      const question = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

      if (!question || question.length < 3) {
        await say({
          text: "👋 Hey! Ask me a question about your workspace — I'll search through Slack messages and ClickUp tasks to find the answer.",
          thread_ts: event.ts,
        });
        return;
      }

      // Run RAG pipeline
      const { answer, sources } = await answerQuestion(question);

      // Build source citation footer
      let sourceFooter = '';
      if (sources.length > 0) {
        const sourceIcons = sources.map((s) => 
          s.source === 'slack' ? '💬' : '📋'
        );
        const uniqueIcons = [...new Set(sourceIcons)];
        sourceFooter = `\n\n_Sources: ${uniqueIcons.join(' ')} ${sources.length} context chunks used (similarity range: ${sources[sources.length - 1].similarity.toFixed(2)}–${sources[0].similarity.toFixed(2)})_`;
      }

      // Update the thinking message with the actual answer
      try {
        await client.chat.update({
          channel: event.channel,
          ts: thinkingMsg.ts,
          text: `${answer}${sourceFooter}`,
        });
      } catch (updateError) {
        // If update fails, post as a new message
        logger.warn('Failed to update thinking message, posting new reply', { error: updateError.message });
        await say({
          text: `${answer}${sourceFooter}`,
          thread_ts: event.ts,
        });
      }

    } catch (error) {
      logger.error('Failed to handle @mention', {
        error: error.message,
        user: event.user,
        channel: event.channel,
      });

      await say({
        text: '❌ Sorry, I encountered an error while processing your question. Please try again.',
        thread_ts: event.ts,
      });
    }
  });

  logger.info('Mention listener registered');
}

module.exports = { registerMentionListener };
