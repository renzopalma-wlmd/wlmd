# PM-Insight-Hub

> RAG-powered workspace intelligence bot — connects Slack conversations and ClickUp tasks through AI-powered semantic search.

## Architecture

```
Slack Messages ──→ Bolt Listener ──→ Gemini Embed ──→ Supabase (pgvector)
ClickUp Events ──→ Express Webhook ──→ Gemini Embed ──→ Supabase (pgvector)
                                                           │
@mention Question ──→ Embed Query ──→ Vector Search ──→ RAG Pipeline ──→ Gemini Answer ──→ Slack Reply
```

> **Architecture deep-dive:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the read
> and reply paths actually work, diagrams, the data model, known limitations, and a map of
> the docs still to be written.

## Tech Stack

- **Slack Integration**: [Slack Bolt for JavaScript](https://slack.dev/bolt-js) (Socket Mode + HTTP)
- **Database**: [Supabase](https://supabase.com) with [pgvector](https://github.com/pgvector/pgvector)
- **AI/ML**: [Google Gemini](https://ai.google.dev) (embeddings + generation)
- **ClickUp**: Webhook integration for task context

## Prerequisites

- Node.js 22+
- A [Supabase](https://supabase.com) project — grab the **service_role** key (Settings → API), not the anon key; the app runs server-side only and the `knowledge_context` table has RLS enabled with no anon-accessible policies
- A [Slack App](https://api.slack.com/apps) with the following:
  - Bot Token Scopes: `app_mentions:read`, `channels:history`, `chat:write`, `groups:history`, `channels:read`, `groups:read`, `users:read`
  - Event Subscriptions: `app_mention`, `message.channels`, `message.groups`
  - Socket Mode enabled (for local development)
- A [Google AI Studio](https://aistudio.google.com) API key
- A [ClickUp](https://clickup.com) workspace (optional, for task integration)

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd pm-insight-hub
npm install
```

### 2. Set Up Database

Run the SQL schema in your Supabase SQL Editor:

```bash
# Copy the contents of sql/schema.sql into the Supabase SQL Editor and execute
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

### 4. Run Locally (Socket Mode)

Make sure `SOCKET_MODE=true` in your `.env` file.

```bash
npm run dev
```

### 5. Enable the dashboard

Generate a token and set it, or the dashboard stays disabled (it returns `503`
rather than serving private channel content openly):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Put it in `DASHBOARD_TOKEN`, then open `/dashboard`.

### 6. Load history and tasks

Both jobs are **dry-run by default** — they print what they would do and write
nothing until you pass `--write`:

```bash
npm run backfill:slack            # dry run: counts per channel
npm run backfill:slack -- --write # index the last 30 days incl. thread replies
npm run sync:clickup              # reconcile CLICKUP_SPACE_IDS
npm run prune:tasks               # dry run: tasks completed past the window
```

> **Gemini free tier is the practical limit here:** 1000 embeddings/day and
> 100/minute. A full backfill of a busy workspace exceeds a day's allowance, and
> live indexing competes for the same bucket. Enable billing before a large
> import.

### 7. Test It

1. Add the bot to a Slack channel
2. Send a few messages in the channel
3. @mention the bot with a question: `@PM-Insight-Hub what were we discussing about the Q3 roadmap?`

## Production Deployment

In production (`SOCKET_MODE=false`), Slack events and the ClickUp webhook are both served from a single Express app on `PORT` — this is required for single-port PaaS platforms like Railway/Render.

### Railway

1. Push your code to GitHub
2. On [Railway](https://railway.app), create a new project → "Deploy from GitHub repo" → select this repo
3. Set all environment variables from `.env.example` (Railway auto-provides `PORT`, don't override it)
4. Set `SOCKET_MODE=false`
5. Once deployed, Railway gives you a public URL like `https://your-app.up.railway.app`
6. Set your Slack Event Subscription URL to: `https://your-app.up.railway.app/slack/events`
7. Set your ClickUp Webhook URL to: `https://your-app.up.railway.app/clickup/webhook`

### Render

Same steps as above, using [Render](https://render.com) instead — note the free tier sleeps after inactivity, which breaks real-time Slack event delivery.

### ClickUp Webhook Registration

Use the ClickUp API to register a webhook:

```bash
curl -X POST 'https://api.clickup.com/api/v2/team/{team_id}/webhook' \
  -H 'Authorization: {your_api_token}' \
  -H 'Content-Type: application/json' \
  -d '{
    "endpoint": "https://your-app.up.railway.app/clickup/webhook",
    "events": ["taskCreated", "taskUpdated", "taskCommentPosted", "taskStatusUpdated"]
  }'
```

## Project Structure

```
pm-insight-hub/
├── app.js                     # Main entry point
├── package.json
├── .env.example
├── docs/
│   └── ARCHITECTURE.md        # Read/reply paths, diagrams, limitations, doc map
├── sql/
│   └── schema.sql             # Supabase schema + vector search
└── src/
    ├── config.js              # Environment config & validation
    ├── supabase.js            # Database client & helpers
    ├── embeddings.js          # Gemini embedding generation
    ├── rag.js                 # RAG pipeline (embed → search → generate)
    ├── listeners/
    │   ├── messages.js        # Slack message indexing
    │   ├── mentions.js        # @mention RAG handler
    │   └── clickup.js         # ClickUp webhook receiver
    └── utils/
        ├── logger.js          # Structured logging
        └── slack-format.js    # Markdown → Slack mrkdwn, channel/date tokens
```

## License

MIT
