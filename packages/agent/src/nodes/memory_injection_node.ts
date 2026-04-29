import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import { incrementRetrievalCount, matchMemories } from "@agents/db";
import { GraphState } from "../state";
import { createEmbeddingModel } from "../model";

function lastHumanText(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) {
      const c = m.content;
      if (typeof c === "string") return c.trim() || null;
      if (Array.isArray(c)) {
        const joined = c
          .map((b) => {
            if (typeof b === "string") return b;
            if (b && typeof b === "object" && "text" in b) return String((b as { text?: string }).text ?? "");
            return "";
          })
          .join("");
        return joined.trim() || null;
      }
      return JSON.stringify(c).trim() || null;
    }
  }
  return null;
}

function formatMemoryBlock(
  items: Array<{ type: string; content: string; similarity: number }>
): string {
  const lines = items.map(
    (m, i) =>
      `${i + 1}. [${m.type}] ${m.content} (relevancia similitud: ${m.similarity.toFixed(3)})`
  );
  return `[MEMORIA DEL USUARIO]\nRecuerdos relevantes recuperados para este turno:\n${lines.join("\n")}\n[/MEMORIA DEL USUARIO]`;
}

export function buildMemoryInjectionNode(db: DbClient, userId: string) {
  return async (
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> => {
    try {
      const input = lastHumanText(state.messages);
      if (!input) return {};

      const embedder = createEmbeddingModel();
      const queryEmbedding = await embedder.embedQuery(input);

      const matches = await matchMemories(db, userId, queryEmbedding, 6);
      if (matches.length === 0) return {};

      const ids = matches.map((m) => m.id);
      void incrementRetrievalCount(db, ids).catch((err) =>
        console.error("[memory_injection] incrementRetrievalCount:", err)
      );

      const block = formatMemoryBlock(matches);
      const enriched = `${block}\n\n${state.systemPrompt}`;
      return { systemPrompt: enriched };
    } catch (err) {
      console.error("[memory_injection]", err);
      return {};
    }
  };
}
