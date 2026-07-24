require('dotenv').config();

const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'GEMINI_API_KEY',
];

const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`\n❌ Missing required environment variables:\n${missing.map(v => `   - ${v}`).join('\n')}\n`);
  console.error('Copy .env.example to .env and fill in all required values.\n');
  process.exit(1);
}

module.exports = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN || '',
    socketMode: process.env.SOCKET_MODE === 'true',
  },
  supabase: {
    url: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
  clickup: {
    webhookSecret: process.env.CLICKUP_WEBHOOK_SECRET || '',
    apiToken: process.env.CLICKUP_API_TOKEN || '',
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
};
