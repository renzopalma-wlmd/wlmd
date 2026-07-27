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
  getRecentAcrossSources,
  getRecentContext,
};
