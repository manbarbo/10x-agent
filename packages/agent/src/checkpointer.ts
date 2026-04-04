import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let _saver: PostgresSaver | null = null;

/**
 * Returns a singleton PostgresSaver backed by DATABASE_URL.
 * On first call, creates the LangGraph checkpoint tables (idempotent).
 *
 * Requires a direct (non-pooler) Postgres connection because LangGraph
 * checkpoint operations use advisory locks.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (!_saver) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL environment variable is required for LangGraph checkpointing");
    }
    _saver = PostgresSaver.fromConnString(url);
    await _saver.setup();
  }
  return _saver;
}
