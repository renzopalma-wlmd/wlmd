require('dotenv').config();

const REQUIRED_VARS = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
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
    // service_role bypasses RLS — this must never be sent to a client/browser,
    // only used from this server. knowledge_context has RLS enabled with no
    // policies, so the anon key has zero access even if it leaks.
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
  },
  clickup: {
    webhookSecret: process.env.CLICKUP_WEBHOOK_SECRET || '',
    apiToken: process.env.CLICKUP_API_TOKEN || '',
    // Spaces to sync. Deliberately an allowlist rather than "everything":
    // the Whitelabel Clients space holds ~170 template-seeded client folders
    // whose near-identical onboarding tasks would swamp the vector index.
    // Tasks completed longer ago than this are dropped: this is a task
    // sanitizer for pushing open work, not an archive of past work.
    retentionDays: Number.parseInt(process.env.CLICKUP_RETENTION_DAYS || '60', 10),
    spaceIds: (process.env.CLICKUP_SPACE_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  },
  dashboard: {
    // Pilot scope. When set, the dashboard lists ONLY these channels — the
    // Slack bot is unaffected and still answers wherever it is mentioned.
    // Unset means list every channel the bot can see.
    pilotChannelIds: (process.env.PILOT_CHANNEL_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    // Shared secret for the web dashboard. It serves private client-channel
    // content over the internet, so the API refuses to run without it rather
    // than defaulting to open.
    token: process.env.DASHBOARD_TOKEN || '',
  },
  access: {
    // Slack user IDs allowed to ask about how the bot itself works — its logic,
    // models, prompts, storage. Everyone else gets a decline. Unset means
    // nobody is trusted, which fails closed on purpose.
    adminUserIds: (process.env.ADMIN_SLACK_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
  },
};
