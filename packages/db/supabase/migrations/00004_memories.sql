-- ============================================================
-- pgvector + long-term memories
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE public.memories (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('episodic', 'semantic', 'procedural')),
  content           text        NOT NULL,
  embedding         vector(1536) NOT NULL,
  retrieval_count   int         NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_retrieved_at timestamptz
);

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own memories"
  ON public.memories FOR SELECT
  USING (auth.uid() = user_id);

CREATE INDEX idx_memories_user_id ON public.memories (user_id);

-- RPC: cosine similarity via <=> operator (service role bypasses RLS)
CREATE OR REPLACE FUNCTION public.match_memories(
  query_embedding vector(1536),
  match_user_id   uuid,
  match_count     int DEFAULT 6
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
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION public.increment_memories_retrieval(memory_ids uuid[])
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.memories
  SET
    retrieval_count = retrieval_count + 1,
    last_retrieved_at = now()
  WHERE id = ANY(memory_ids);
END;
$$;
