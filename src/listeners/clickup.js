const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { generateEmbedding } = require('../embeddings');
const { insertContext } = require('../supabase');
const logger = require('../utils/logger');

/**
 * Verify ClickUp webhook signature.
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - X-Signature header value
 * @returns {boolean}
 */
function verifySignature(rawBody, signature) {
  if (!config.clickup.webhookSecret) {
    logger.warn('ClickUp webhook secret not configured — skipping signature verification');
    return true;
  }

  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', config.clickup.webhookSecret);
  const computedDigest = hmac.update(rawBody).digest('hex');

  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const digestBuffer = Buffer.from(computedDigest, 'hex');
    return (
      sigBuffer.length === digestBuffer.length &&
      crypto.timingSafeEqual(sigBuffer, digestBuffer)
    );
  } catch {
    return false;
  }
}

/**
 * Extract meaningful content from a ClickUp webhook payload.
 * @param {Object} payload - Parsed webhook payload
 * @returns {{content: string, metadata: Object}|null}
 */
function extractTaskContent(payload) {
  const { event, task_id, history_items = [] } = payload;

  if (!task_id || history_items.length === 0) return null;

  const metadata = {
    event,
    task_id,
  };

  let content = '';

  for (const item of history_items) {
    const user = item.user ? item.user.username : 'Unknown';

    switch (event) {
      case 'taskCreated':
        content = `[Task Created] ${item.after?.name || 'Untitled task'} (by ${user})`;
        metadata.task_name = item.after?.name;
        break;

      case 'taskUpdated':
        content = `[Task Updated] Field "${item.field}" changed from "${item.before || 'none'}" to "${item.after || 'none'}" (by ${user})`;
        metadata.field = item.field;
        metadata.before = item.before;
        metadata.after = item.after;
        break;

      case 'taskCommentPosted':
        content = `[Task Comment] ${item.comment?.text_content || item.after || ''} (by ${user})`;
        metadata.comment_id = item.comment?.id;
        break;

      case 'taskStatusUpdated':
        content = `[Status Change] Status changed from "${item.before?.status || 'none'}" to "${item.after?.status || 'none'}" (by ${user})`;
        metadata.old_status = item.before?.status;
        metadata.new_status = item.after?.status;
        break;

      default:
        content = `[${event}] ${JSON.stringify(item.after || {})} (by ${user})`;
        break;
    }
  }

  if (!content) return null;

  return { content, metadata };
}

/**
 * Create an Express router for ClickUp webhooks.
 * @returns {express.Router}
 */
function createClickUpRouter() {
  const router = express.Router();

  // Use raw body parser for signature verification
  router.use(express.raw({ type: 'application/json' }));

  router.post('/clickup/webhook', async (req, res) => {
    try {
      // Verify signature
      const signature = req.headers['x-signature'];
      if (!verifySignature(req.body, signature)) {
        logger.warn('Invalid ClickUp webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }

      // Parse the payload
      const payload = JSON.parse(req.body.toString('utf8'));
      logger.info('ClickUp webhook received', { event: payload.event, taskId: payload.task_id });

      // Extract content
      const extracted = extractTaskContent(payload);
      if (!extracted) {
        logger.info('No indexable content in ClickUp webhook payload');
        return res.status(200).json({ status: 'skipped' });
      }

      // Generate embedding and store in Supabase (async, don't block response)
      res.status(200).json({ status: 'accepted' });

      // Process in background after responding
      const embedding = await generateEmbedding(extracted.content);
      await insertContext({
        source: 'clickup',
        externalId: payload.task_id,
        authorId: payload.history_items?.[0]?.user?.id?.toString() || null,
        content: extracted.content,
        metadata: extracted.metadata,
        embedding,
      });

      logger.info('ClickUp task context indexed', { taskId: payload.task_id, event: payload.event });

    } catch (error) {
      logger.error('ClickUp webhook processing error', { error: error.message });
      // Only send error response if headers haven't been sent
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  logger.info('ClickUp webhook router created');
  return router;
}

module.exports = { createClickUpRouter };
