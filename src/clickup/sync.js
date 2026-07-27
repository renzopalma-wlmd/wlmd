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
async function ingestList(list, tasks, { replace = true } = {}) {
  const stats = { inserted: 0, skipped: 0, duplicates: 0, failed: 0 };

  if (replace) {
    // A board is a snapshot, not an append-only log: statuses and assignees
    // change, so stale rows would keep answering with outdated state.
    const { error } = await supabase
      .from('knowledge_context')
      .delete()
      .eq('source', 'clickup')
      .eq('external_id', list.id);
    if (error) throw error;
  }

  const seen = new Set();

  for (const task of tasks) {
    const screen = screenTask(task);
    if (!screen.keep) {
      stats.skipped++;
      continue;
    }

    const key = dedupeKey(list.id, task.name);
    if (seen.has(key)) {
      stats.duplicates++;
      continue;
    }
    seen.add(key);

    const content = buildTaskText(task);
    try {
      const embedding = await generateEmbedding(content);
      await insertContext({
        source: 'clickup',
        externalId: list.id,
        authorId: task.assignees?.[0]?.id?.toString() || null,
        content,
        metadata: {
          task_id: task.id,
          custom_id: task.custom_id || null,
          list_id: list.id,
          list_name: list.name,
          folder_name: list.folderName || null,
          status: task.status?.status ?? task.status ?? null,
          priority: task.priority?.priority ?? task.priority ?? null,
          assignees: (task.assignees || []).map((a) => a.username).filter(Boolean),
          tags: (task.tags || []).map((t) => t.name).filter(Boolean),
          due_date: task.due_date || null,
          url: task.url || null,
        },
        embedding,
      });
      stats.inserted++;
    } catch (error) {
      stats.failed++;
      logger.error('Failed to ingest ClickUp task', {
        taskId: task.id,
        list: list.name,
        error: error.message,
      });
    }
  }

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
