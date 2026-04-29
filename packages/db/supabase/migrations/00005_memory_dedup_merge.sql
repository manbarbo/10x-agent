-- ============================================================
-- Per-user merge threshold + merge-time vector search + memories.updated_at
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS memory_merge_similarity_threshold double precision
    NOT NULL DEFAULT 0.88
    CHECK (
      memory_merge_similarity_threshold >= 0::double precision
      AND memory_merge_similarity_threshold <= 1::double precision
    );

ALTER TABLE public.memories
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Top-K neighbors same user + same memory type (for dedup / merge before insert)
CREATE OR REPLACE FUNCTION public.match_memories_for_merge(
  query_embedding vector(1536),
  match_user_id   uuid,
  memory_type       text,
  match_count       int DEFAULT 5
)
RETURNS TABLE (
  id uuid,
  type text,
  content text,
  retrieval_count int,
  similarity float
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    m.id,
    m.type,
    m.content,
    m.retrieval_count,
    (1 - (m.embedding <=> query_embedding))::float AS similarity
  FROM public.memories m
  WHERE m.user_id = match_user_id
    AND m.type = memory_type
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;
