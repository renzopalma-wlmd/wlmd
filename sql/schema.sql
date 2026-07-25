-- =============================================
-- PM-Insight-Hub Database Schema
-- Supabase SQL Editor
-- =============================================

-- 1. Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the unified knowledge context table
-- Stores Slack messages and ClickUp task context alongside vector embeddings
CREATE TABLE IF NOT EXISTS knowledge_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,                  -- 'slack' or 'clickup'
  external_id TEXT NOT NULL,             -- Channel ID or Task ID
  author_id TEXT,                        -- Slack User ID or ClickUp User ID
  content TEXT NOT NULL,                 -- Message body or task description/comment
  metadata JSONB DEFAULT '{}'::jsonb,    -- Extra metadata (thread_ts, task_status, priority, etc.)
  embedding VECTOR(1536),                -- Gemini gemini-embedding-2 (1536 dimensions)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_context(source);
CREATE INDEX IF NOT EXISTS idx_knowledge_external_id ON knowledge_context(external_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_created_at ON knowledge_context(created_at DESC);

-- 4. Create HNSW index for fast approximate nearest neighbor search
-- Using cosine distance operator class
CREATE INDEX IF NOT EXISTS idx_knowledge_embedding ON knowledge_context
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 5. Lock the table down by default.
-- The app connects with the service_role key (bypasses RLS), so no
-- policies are defined here on purpose: anon/authenticated clients
-- (e.g. if the anon key ever leaks) get zero access to this table.
ALTER TABLE knowledge_context ENABLE ROW LEVEL SECURITY;

-- 6. Create the similarity search function (RAG Engine)
-- Called via supabase.rpc('match_context', { query_embedding, match_threshold, match_count })
CREATE OR REPLACE FUNCTION match_context (
  query_embedding VECTOR(1536),
  match_threshold FLOAT,
  match_count INT
)
RETURNS TABLE (
  id UUID,
  source TEXT,
  external_id TEXT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.source,
    kc.external_id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_context kc
  WHERE 1 - (kc.embedding <=> query_embedding) > match_threshold
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
