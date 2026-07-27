const { createClient } = require('@supabase/supabase-js');
const config = require('./config');
const logger = require('./utils/logger');

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey);

/**
 * Insert a context entry into the knowledge_context table.
 * @param {Object} params
 * @param {'slack'|'clickup'} params.source
 * @param {string} params.externalId - Channel ID or Task ID
 * @param {string} [params.authorId] - User ID
 * @param {string} params.content - Text content
 * @param {Object} [params.metadata] - Additional metadata
 * @param {number[]} [params.embedding] - 1536-dim embedding vector
 * @returns {Promise<Object>} Inserted row
 */
async function insertContext({ source, externalId, authorId, content, metadata = {}, embedding = null }) {
  const row = {
    source,
    external_id: externalId,
    author_id: authorId,
    content,
    metadata,
  };

  if (embedding) {
    row.embedding = embedding;
  }

  const { data, error } = await supabase
    .from('knowledge_context')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error('Failed to insert context', { error: error.message, source, externalId });
    throw error;
  }

  logger.info('Context inserted', { id: data.id, source, externalId });
  return data;
}

/**
 * Search for similar context using the match_context RPC function.
 * @param {number[]} queryEmbedding - 1536-dim query embedding
 * @param {number} [threshold=0.5] - Minimum similarity threshold
 * @param {number} [count=5] - Maximum number of results
 * @returns {Promise<Array>} Matching context entries
 */
async function searchContext(queryEmbedding, threshold = 0.5, count = 5) {
  const { data, error } = await supabase.rpc('match_context', {
    query_embedding: queryEmbedding,
    match_threshold: threshold,
    match_count: count,
  });

  if (error) {
    logger.error('Context search failed', { error: error.message });
    throw error;
  }

  logger.info(`Context search returned ${data.length} results`);
  return data;
}

/**
 * Per-channel indexing stats, for the dashboard channel list.
 * @returns {Promise<Map<string, {rows: number, lastActivity: string|null}>>}
 */
async function getChannelStats() {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('external_id, created_at, metadata')
    .eq('source', 'slack');

  if (error) {
    logger.error('Failed to load channel stats', { error: error.message });
    throw error;
  }

  const stats = new Map();
  for (const row of data) {
    const channel = row.metadata?.channel || row.external_id;
    if (!channel) continue;
    const entry = stats.get(channel) || { rows: 0, lastActivity: null };
    entry.rows++;
    if (!entry.lastActivity || row.created_at > entry.lastActivity) {
      entry.lastActivity = row.created_at;
    }
    stats.set(channel, entry);
  }
  return stats;
}

/**
 * Indexed ClickUp boards (lists), for the dashboard sidebar. Derived from what
 * has actually been synced rather than from ClickUp, so the UI never offers a
 * board with nothing behind it.
 * @returns {Promise<Array<{id: string, name: string, folderName: ?string, indexedTasks: number, lastActivity: ?string}>>}
 */
async function getBoardStats() {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('external_id, created_at, metadata')
    .eq('source', 'clickup');

  if (error) {
    logger.error('Failed to load board stats', { error: error.message });
    throw error;
  }

  const boards = new Map();
  for (const row of data) {
    const id = row.metadata?.list_id || row.external_id;
    if (!id) continue;
    const entry = boards.get(id) || {
      id,
      name: row.metadata?.list_name || id,
      folderName: row.metadata?.folder_name || null,
      indexedTasks: 0,
      lastActivity: null,
    };
    entry.indexedTasks++;
    if (!entry.lastActivity || row.created_at > entry.lastActivity) entry.lastActivity = row.created_at;
    boards.set(id, entry);
  }

  return [...boards.values()].sort((a, b) => b.indexedTasks - a.indexedTasks);
}

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** pgvector columns arrive as a JSON-ish string over the REST API. */
function parseEmbedding(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

let scopedRpcMissing = false;

/**
 * Similarity search restricted to one source/channel.
 *
 * Filtering has to happen inside the query — taking a global top-N and
 * filtering afterwards can legitimately return nothing for a quiet channel.
 * Falls back to scoring in JS when the match_context_scoped migration has not
 * been applied yet, so a deploy is never broken while waiting on the DDL.
 *
 * @param {number[]} queryEmbedding
 * @param {Object} [options]
 * @param {number} [options.threshold=0.4]
 * @param {number} [options.count=8]
 * @param {string} [options.source] - Restrict to 'slack' | 'clickup'
 * @param {string} [options.externalId] - Restrict to a channel ID or task ID
 * @returns {Promise<Array>}
 */
async function searchContextScoped(queryEmbedding, { threshold = 0.4, count = 8, source = null, externalId = null } = {}) {
  if (!scopedRpcMissing) {
    const { data, error } = await supabase.rpc('match_context_scoped', {
      query_embedding: queryEmbedding,
      match_threshold: threshold,
      match_count: count,
      filter_source: source,
      filter_external_id: externalId,
    });

    if (!error) {
      logger.info(`Scoped search returned ${data.length} results`, { source, externalId });
      return data;
    }

    // PGRST202 / 42883 both mean "no such function" — anything else is real.
    const missing = error.code === 'PGRST202' || error.code === '42883' || /does not exist|Could not find the function/i.test(error.message);
    if (!missing) {
      logger.error('Scoped search failed', { error: error.message, code: error.code });
      throw error;
    }
    scopedRpcMissing = true;
    logger.warn('match_context_scoped not found — using in-process scoring. Apply sql/schema.sql to restore indexed search.');
  }

  // Fallback: pull the candidate rows for this scope and rank them here.
  let query = supabase.from('knowledge_context').select('id, source, external_id, content, metadata, created_at, embedding');
  if (source) query = query.eq('source', source);
  if (externalId) query = query.eq('external_id', externalId);

  const FALLBACK_SCAN_LIMIT = 500;
  const { data, error } = await query.order('created_at', { ascending: false }).limit(FALLBACK_SCAN_LIMIT);
  if (error) {
    logger.error('Fallback scoped search failed', { error: error.message });
    throw error;
  }

  // Past the cap this silently stops considering older rows, which looks like
  // "the bot forgot" rather than a missing migration. Say so loudly.
  if (data.length === FALLBACK_SCAN_LIMIT) {
    logger.error('Fallback scan hit its row cap — older context is being ignored. Apply the match_context_scoped migration.', {
      externalId,
      cap: FALLBACK_SCAN_LIMIT,
    });
  }

  const ranked = data
    .map((row) => {
      const vector = parseEmbedding(row.embedding);
      if (!vector || vector.length !== queryEmbedding.length) return null;
      const { embedding, ...rest } = row;
      return { ...rest, similarity: cosineSimilarity(queryEmbedding, vector) };
    })
    .filter((row) => row && row.similarity > threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, count);

  logger.info(`Scoped search (fallback) returned ${ranked.length} results`, { source, externalId, scanned: data.length });
  return ranked;
}

/**
 * Fetch the newest context entries for one channel, newest first.
 * Powers "what's the status here?" style briefings.
 * @param {string} externalId - Channel ID
 * @param {number} [limit=15]
 * @returns {Promise<Array>}
 */
async function getRecentInChannel(externalId, limit = 15) {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('id, source, external_id, content, metadata, created_at')
    .eq('external_id', externalId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to fetch recent context for channel', { error: error.message, externalId });
    throw error;
  }

  logger.info(`Channel recency search returned ${data.length} results`, { externalId, limit });
  return data;
}

/**
 * Fetch the newest context entries across every source and channel.
 * Vector search can only rank by semantic similarity, so questions about
 * recency ("the last 15 messages", "catch me up") need a time-ordered read
 * instead — no embedding is involved.
 * @param {number} [limit=15] - Max entries to return, newest first
 * @returns {Promise<Array>}
 */
async function getRecentAcrossSources(limit = 15) {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('id, source, external_id, content, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to fetch recent context across sources', { error: error.message });
    throw error;
  }

  logger.info(`Recency search returned ${data.length} results`, { limit });
  return data;
}

/**
 * Fetch recent context entries for a specific source and external ID.
 * @param {string} source - 'slack' or 'clickup'
 * @param {string} externalId - Channel ID or Task ID
 * @param {number} [limit=20] - Max entries to return
 * @returns {Promise<Array>}
 */
async function getRecentContext(source, externalId, limit = 20) {
  const { data, error } = await supabase
    .from('knowledge_context')
    .select('id, content, metadata, created_at')
    .eq('source', source)
    .eq('external_id', externalId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Failed to fetch recent context', { error: error.message, source, externalId });
    throw error;
  }

  return data;
}

module.exports = {
  supabase,
  insertContext,
  searchContext,
  searchContextScoped,
  getChannelStats,
  getBoardStats,
  getRecentInChannel,
  getRecentAcrossSources,
  getRecentContext,
};
