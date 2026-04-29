import type { DbClient } from "../client";

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface Memory {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
}

export interface MemoryInsertRow {
  user_id: string;
  type: MemoryType;
  content: string;
  embedding: number[];
}

export interface MatchedMemory {
  id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  similarity: number;
}

export async function insertMemories(db: DbClient, rows: MemoryInsertRow[]): Promise<void> {
  if (rows.length === 0) return;

  const payload = rows.map((r) => ({
    user_id: r.user_id,
    type: r.type,
    content: r.content,
    embedding: r.embedding,
  }));

  const { error } = await db.from("memories").insert(payload);
  if (error) throw error;
}

export async function matchMemories(
  db: DbClient,
  userId: string,
  queryEmbedding: number[],
  limit = 6
): Promise<MatchedMemory[]> {
  const { data, error } = await db.rpc("match_memories", {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    match_count: limit,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    type: string;
    content: string;
    retrieval_count: number;
    similarity: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    retrieval_count: r.retrieval_count,
    similarity: r.similarity,
  }));
}

export async function incrementRetrievalCount(db: DbClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.rpc("increment_memories_retrieval", {
    memory_ids: ids,
  });
  if (error) throw error;
}

/** Same-type neighbors for merge/dedup (cosine via pgvector). */
export async function matchMemoriesForMerge(
  db: DbClient,
  userId: string,
  memoryType: MemoryType,
  queryEmbedding: number[],
  matchCount = 5
): Promise<MatchedMemory[]> {
  const { data, error } = await db.rpc("match_memories_for_merge", {
    query_embedding: queryEmbedding,
    match_user_id: userId,
    memory_type: memoryType,
    match_count: matchCount,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    type: string;
    content: string;
    retrieval_count: number;
    similarity: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type as MemoryType,
    content: r.content,
    retrieval_count: r.retrieval_count,
    similarity: r.similarity,
  }));
}

export async function updateMemoryContentEmbedding(
  db: DbClient,
  memoryId: string,
  content: string,
  embedding: number[]
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("memories")
    .update({
      content,
      embedding,
      updated_at: now,
    })
    .eq("id", memoryId);
  if (error) throw error;
}
