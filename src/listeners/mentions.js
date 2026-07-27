const { answerQuestion } = require('../rag');
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
        // Reuse the thinking message instead of leaving it orphaned in-thread
        await client.chat.update({
          channel: event.channel,
          ts: thinkingMsg.ts,
          text: "👋 Hey! Ask me a question about your workspace — I'll search through Slack messages and ClickUp tasks to find the answer.",
        });
        return;
      }

      // Run RAG pipeline
      const { answer, sources } = await answerQuestion(question);

      // Gemini emits Markdown regardless of prompting, so normalize to mrkdwn
      // before it reaches Slack — otherwise **bold** shows its asterisks.
      const reply = `${truncateForSlack(toMrkdwn(answer))}${buildSourceFooter(sources)}`;

      // Update the thinking message with the actual answer
      try {
        await client.chat.update({
          channel: event.channel,
          ts: thinkingMsg.ts,
          text: reply,
        });
      } catch (updateError) {
        // If update fails, post as a new message
        logger.warn('Failed to update thinking message, posting new reply', { error: updateError.message });
        await say({
          text: reply,
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

module.exports = { registerMentionListener, buildSourceFooter };
