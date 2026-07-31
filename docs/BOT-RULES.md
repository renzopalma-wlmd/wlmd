# PM-Insight-Hub — Rules & Usage

What the bot will and won't do, and how to get the most out of it.

Written for the team, not for engineers. The technical counterpart is
[`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## 1. The one rule that matters

**The bot answers about one channel at a time, and only to the person who asked
when a client is in the room.**

Everything below follows from that.

---

## 2. Where to talk to it

| Surface | Use it for | Who sees the answer |
|---|---|---|
| **DM the bot** | Anything, across every channel it can see | **Only you** |
| **@mention in a client channel** | That channel's project | **Only you** (ephemeral) |
| **@mention in an internal channel** | That channel's project | Everyone in the thread |
| **Dashboard** `/dashboard` | Briefings, related tasks, board status | Anyone with the token |

**DM is the recommended way to use it.** It's private by construction, it can
answer across all channels, and there's no channel to open, no mention to type
and no thread to expand.

> Try: `what's blocking wlmd-obsidiangenetics?` · `catch me up on internal-mgmt`

---

## 3. Who it will talk to

The bot classifies everyone before it answers:

- **Internal** — a full member of the Whitelabel MD workspace
- **External** — a **guest** account (`is_restricted`), a Slack Connect member
  from another workspace, or anyone it cannot identify

**Clients are guests, and the bot will not answer them.** They get a short,
private note pointing them at their project contact. It never explains itself,
never mentions internal tooling, and nobody else sees the exchange.

If the bot can't identify someone, or can't read who is in a channel, it treats
them as external and keeps quiet. It fails closed on purpose.

---

## 4. Where its answers can appear

Decided per message, by who is in the channel:

```
Is it a DM?              → answer normally, cross-channel allowed
Any client in the room?  → ephemeral: only the asker sees it
All internal?            → normal threaded reply
Asker is a client?       → polite decline, privately
```

This exists because a briefing can legitimately say things like *"risk of losing
them"* or *"the client is unhappy with the direction"*. That is a correct
internal read and it must never appear in the client's own channel.

**Ephemeral replies vanish when you reload Slack.** That is Slack's behaviour,
not a bug. If you want to keep an answer, copy it or use the dashboard.

---

## 5. What it knows

**Slack.** Every message in a channel it has been invited to, except:

- messages from apps and bots
- joins, leaves, edits and other system events
- anything under 10 characters
- messages that @mention the bot — those are questions, not knowledge
- direct messages to the bot — same reason

**ClickUp.** Tasks from the internal *Whitelabel Tasks* space, with status,
priority, assignee, tags, due date and description. Excluded:

- placeholder tasks (`Test Task`, `ssf`, `rr`)
- duplicates of the same task name on the same board
- anything completed more than **60 days** ago

> **It only knows what was indexed.** The bot sees messages posted while it was
> running, plus whatever history has been backfilled. If it says it doesn't know
> something, the honest reading is "that isn't in my index", not "that never
> happened".

---

## 6. How to ask

The wording changes how it searches. Three modes:

| You write | It does | Good for |
|---|---|---|
| *"what's blocking the launch?"* | Finds the most relevant messages | Specific questions |
| *"catch me up"*, *"last 15 messages"*, *"latest on…"*, *"resumen"* | Reads in time order | What did I miss |
| *"list all…"*, *"every task"*, *"todos los pendientes"* | Reads the **whole** channel | Complete inventories |

Enumeration also works when the AI quota is exhausted, because it doesn't need
to search — worth remembering if the bot says it's out of capacity.

**Cross-channel is opt-in.** By default a question is answered from the current
channel only. To widen it, say so explicitly: *"across all channels"*, *"every
channel"*, *"todos los canales"*. In a DM it's cross-channel by default.

**It tells you what it saw.** Every answer knows how much of the channel it was
given, so it will say *"based on 8 of 31 items"* rather than implying it saw
everything. If you get a partial answer, narrow the question.

---

## 7. What it refuses

- **Its own implementation** — models, prompts, storage, infrastructure, which
  channels it can see. Restricted to the admins in `ADMIN_SLACK_USER_IDS`.
  Everyone else gets redirected back to the project.
- **Other channels' content** unless you explicitly ask to widen.
- **Anything it wasn't given.** It won't guess. If a question needs ClickUp and
  no tasks are indexed, it says so instead of answering from Slack.

---

## 8. When something looks wrong

| Symptom | What it means |
|---|---|
| *"I've hit today's AI usage limit"* | Free-tier quota spent. Resets daily. `list`-style questions still work. |
| *"The AI model is overloaded"* | Transient. It already retried across three models. Ask again shortly. |
| *"nothing from that source is indexed"* | Correct behaviour — that data hasn't been imported. |
| Channel shows **not indexed** | Never backfilled, or it's an app-notification feed. The dashboard says which. |
| Answer seems to miss things | Check the coverage note. Ask a narrower question, or widen with `all channels`. |

---

## 9. Limits worth knowing

| | |
|---|---|
| Answers per question | up to 8 relevant items, 60 when enumerating |
| Recency window | 15 items by default, 30 max |
| Reply length | trimmed at ~3,800 characters, on a clean break |
| Task retention | completed tasks dropped after 60 days |
| AI capacity | free tier — 1,000 embeddings/day, 100/minute |

---

## 10. Good habits

- **DM the bot** for anything you wouldn't say in front of a client.
- **Ask before you join a conversation**, not after — that's what the briefing is for.
- **Say "all channels"** when you genuinely want breadth; leave it off otherwise.
- **Treat "I don't know" as "not indexed"**, and check the dashboard's status line.
- **Don't paste secrets at it.** Everything it reads gets stored and embedded.
