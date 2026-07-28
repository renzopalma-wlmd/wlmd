const crypto = require('crypto');
const config = require('../config');
const { generateEmbedding } = require('../embeddings');
const { supabase, insertContext } = require('../supabase');
const logger = require('../utils/logger');

const CLICKUP_API = 'https://api.clickup.com/api/v2';

// Tasks whose whole name is placeholder junk. These exist in the real board
// ("Test Task", "ssf", "rr") and would otherwise be embedded as knowledge.
const JUNK_NAME_RE = /^(test task|test|tests?|todo|asdf?|ssf|rr+|xx+|aa+|n\/a|-+|\.+)$/i;
const MIN_NAME_LENGTH = 4;

/** Slack-side helper equivalent: turn a ClickUp task into embeddable text. */
function buildTaskText(task) {
  const lines = [];
  const ref = task.custom_id || task.id;

  // The REST API nests these as objects; other callers pass plain strings.
  const status = task.status?.status ?? task.status;
  const priority = task.priority?.priority ?? task.priority;

  lines.push(`[${ref}] ${task.name}`);
  lines.push(`Status: ${status || 'unknown'}`);

  if (priority) lines.push(`Priority: ${priority}`);

  const assignees = (task.assignees || []).map((a) => a.username || a.email).filter(Boolean);
  lines.push(`Assignee: ${assignees.length ? assignees.join(', ') : 'unassigned'}`);

  const tags = (task.tags || []).map((t) => t.name).filter(Boolean);
  if (tags.length) lines.push(`Tags: ${tags.join(', ')}`);

  if (task.due_date) {
    lines.push(`Due: ${new Date(Number(task.due_date)).toISOString().slice(0, 10)}`);
  }

  // Descriptions carry the actual requirements. Trim hard — a few very long
  // descriptions would otherwise dominate every retrieved context window.
  const description = (task.description || task.text_content || '').trim();
  if (description) lines.push(`\n${description.slice(0, 1500)}`);

  return lines.join('\n');
}

/** Normalized key for collapsing the board's duplicate tasks. */
function dedupeKey(listId, name) {
  return `${listId}::${String(name).toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

/**
 * Fingerprint of the embedded text. Re-embedding a task whose text has not
 * changed is pure waste — at 100 clients on a daily sync that would be the
 * dominant cost of the whole system.
 */
function contentHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Run an async fn over items with bounded concurrency, preserving order. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Decide whether a task is worth indexing.
 * @returns {{keep: boolean, reason?: string}}
 */
function screenTask(task) {
  const name = String(task.name || '').trim();
  if (!name) return { keep: false, reason: 'empty name' };
  if (JUNK_NAME_RE.test(name)) return { keep: false, reason: 'placeholder name' };
  if (name.length < MIN_NAME_LENGTH && !task.description) return { keep: false, reason: 'too short' };
  return { keep: true };
}

async function clickupFetch(path) {
  if (!config.clickup.apiToken) {
    throw new Error('CLICKUP_API_TOKEN is not set — cannot sync ClickUp.');
  }
  const res = await fetch(`${CLICKUP_API}${path}`, {
    headers: { Authorization: config.clickup.apiToken },
  });
  if (!res.ok) {
    throw new Error(`ClickUp ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** Lists belonging to a space, including those nested in folders. */
async function fetchSpaceLists(spaceId) {
  const lists = [];

  const { lists: folderless = [] } = await clickupFetch(`/space/${spaceId}/list?archived=false`);
  lists.push(...folderless);

  const { folders = [] } = await clickupFetch(`/space/${spaceId}/folder?archived=false`);
  for (const folder of folders) {
    for (const list of folder.lists || []) {
      lists.push({ ...list, folderName: folder.name });
    }
  }
  return lists;
}

/** All non-archived tasks in a list, paginated. Descriptions included. */
async function fetchListTasks(listId) {
  const tasks = [];
  for (let page = 0; page < 20; page++) {
    const data = await clickupFetch(
      `/list/${listId}/task?archived=false&include_closed=true&subtasks=true&page=${page}`
    );
    const batch = data.tasks || [];
    tasks.push(...batch);
    if (batch.length === 0 || data.last_page) break;
  }
  return tasks;
}

/**
 * Ingest tasks for one list into knowledge_context.
 *
 * external_id is the LIST id, not the task id. The retrieval layer scopes by
 * external_id, so storing the task id there would make every task its own
 * island and no board could ever be queried as a whole. The task's own
 * identifiers live in metadata.
 *
 * @param {{id: string, name: string, folderName?: string}} list
 * @param {Array} tasks
 * @param {Object} [options]
 * @param {boolean} [options.replace=true] - Clear the list's existing rows first
 * @returns {Promise<{inserted: number, skipped: number, duplicates: number, failed: number}>}
 */
async function ingestList(list, tasks, { concurrency = 4, closedWithinDays = config.clickup.retentionDays } = {}) {
  const stats = { unchanged: 0, inserted: 0, updated: 0, removed: 0, skipped: 0, duplicates: 0, failed: 0 };

  // Existing rows for this board, keyed by task so we can tell what changed.
  const { data: existingRows, error: readError } = await supabase
    .from('knowledge_context')
    .select('id, metadata')
    .eq('source', 'clickup')
    .eq('external_id', list.id);
  if (readError) throw readError;

  const existing = new Map();
  for (const row of existingRows) {
    if (row.metadata?.task_id) existing.set(row.metadata.task_id, row);
  }

  const closedCutoff = Date.now() - closedWithinDays * 86400000;
  const seenNames = new Set();
  const keep = [];

  for (const task of tasks) {
    if (!screenTask(task).keep) {
      stats.skipped++;
      continue;
    }
    // Long-closed work is history, not status. Keeping all of it buries the
    // open items that a briefing is actually about.
    if (task.date_closed && Number(task.date_closed) < closedCutoff) {
      stats.skipped++;
      continue;
    }
    const key = dedupeKey(list.id, task.name);
    if (seenNames.has(key)) {
      stats.duplicates++;
      continue;
    }
    seenNames.add(key);
    keep.push({ task, content: buildTaskText(task) });
  }

  // Decide per task: unchanged, changed, or new.
  const stale = [];
  const work = [];
  for (const item of keep) {
    item.hash = contentHash(item.content);
    const prior = existing.get(item.task.id);
    if (prior && prior.metadata?.content_hash === item.hash) {
      stats.unchanged++;
      existing.delete(item.task.id);
      continue;
    }
    if (prior) {
      stale.push(prior.id);
      existing.delete(item.task.id);
      item.isUpdate = true;
    }
    work.push(item);
  }

  // Anything still in `existing` is gone from the board, or was closed long
  // enough ago to drop. Either way it must not keep answering questions.
  const orphaned = [...existing.values()].map((row) => row.id);
  const toDelete = [...stale, ...orphaned];
  if (toDelete.length) {
    const { error } = await supabase.from('knowledge_context').delete().in('id', toDelete);
    if (error) throw error;
    stats.removed = orphaned.length;
  }

  await mapPool(work, concurrency, async (item) => {
    try {
      const embedding = await generateEmbedding(item.content);
      await insertContext({
        source: 'clickup',
        externalId: list.id,
        authorId: item.task.assignees?.[0]?.id?.toString() || null,
        content: item.content,
        metadata: {
          task_id: item.task.id,
          custom_id: item.task.custom_id || null,
          content_hash: item.hash,
          list_id: list.id,
          list_name: list.name,
          folder_name: list.folderName || null,
          status: item.task.status?.status ?? item.task.status ?? null,
          priority: item.task.priority?.priority ?? item.task.priority ?? null,
          assignees: (item.task.assignees || []).map((a) => a.username).filter(Boolean),
          tags: (item.task.tags || []).map((t) => t.name).filter(Boolean),
          due_date: item.task.due_date || null,
          date_closed: item.task.date_closed || null,
          url: item.task.url || null,
        },
        embedding,
      });
      if (item.isUpdate) stats.updated++;
      else stats.inserted++;
    } catch (error) {
      stats.failed++;
      logger.error('Failed to ingest ClickUp task', {
        taskId: item.task.id,
        list: list.name,
        error: error.message,
      });
    }
  });

  return stats;
}

/**
 * Sync every list in a ClickUp space.
 * @param {string} spaceId
 * @returns {Promise<Array>} Per-list results
 */
async function syncSpace(spaceId) {
  const lists = await fetchSpaceLists(spaceId);
  logger.info(`ClickUp sync starting`, { spaceId, lists: lists.length });

  const results = [];
  for (const list of lists) {
    const tasks = await fetchListTasks(list.id);
    const stats = await ingestList(list, tasks);
    logger.info(`Synced list "${list.name}"`, { fetched: tasks.length, ...stats });
    results.push({ list: list.name, listId: list.id, fetched: tasks.length, ...stats });
  }
  return results;
}

module.exports = {
  syncSpace,
  ingestList,
  fetchSpaceLists,
  fetchListTasks,
  buildTaskText,
  screenTask,
  dedupeKey,
};
