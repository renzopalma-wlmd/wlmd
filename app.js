const config = require('./src/config');
const { App, ExpressReceiver } = require('@slack/bolt');
const logger = require('./src/utils/logger');
const { registerMessageListener } = require('./src/listeners/messages');
const { registerMentionListener } = require('./src/listeners/mentions');
const { createClickUpRouter } = require('./src/listeners/clickup');

// ==========================================================
// Initialize Slack Bolt App
// Supports both Socket Mode (dev) and HTTP Mode (production).
// In HTTP mode, a custom ExpressReceiver is used so the ClickUp
// webhook can share the same port/process — PaaS platforms like
// Railway/Render only expose a single port per service.
// ==========================================================
let slackApp;
let receiver;

if (config.slack.socketMode) {
  slackApp = new App({
    token: config.slack.botToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
    appToken: config.slack.appToken,
  });
  logger.info('Slack app configured for Socket Mode (development)');
} else {
  receiver = new ExpressReceiver({
    signingSecret: config.slack.signingSecret,
  });

  receiver.router.use(createClickUpRouter());
  receiver.router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  slackApp = new App({
    token: config.slack.botToken,
    receiver,
  });
  logger.info(`Slack app configured for HTTP Mode on port ${config.server.port}`);
}

// ==========================================================
// Register Slack Listeners
// ==========================================================
registerMessageListener(slackApp);
registerMentionListener(slackApp);

// ==========================================================
// Start Server
// ==========================================================
async function start() {
  try {
    await slackApp.start(config.slack.socketMode ? undefined : config.server.port);
    logger.info('⚡️ PM-Insight-Hub Slack bot is running!');
    if (!config.slack.socketMode) {
      logger.info(`📋 ClickUp webhook available at /clickup/webhook on port ${config.server.port}`);
    }
    logger.info('🚀 All services started successfully');
  } catch (error) {
    logger.error('Failed to start application', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully...');
  await slackApp.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down gracefully...');
  await slackApp.stop();
  process.exit(0);
});

start();
