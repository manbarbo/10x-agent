import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import { getSessionMessages, insertMemories, type MemoryInsertRow, type MemoryType } from "@agents/db";
import type { AgentMessage } from "@agents/types";
import { createCompactionModel, createEmbeddingModel } from "./model";

const EXTRACTION_SYSTEM_PROMPT = `Extrae de esta conversación solo los hechos que seguirán siendo verdad en la próxima sesión.
Responde ÚNICAMENTE con JSON válido: un array de objetos con forma { "type": "episodic" | "semantic" | "procedural", "content": "string" }.
- episodic: qué hizo el usuario o el asistente y cuándo (hechos concretos de la sesión que importen después).
- semantic: preferencias del usuario o conocimiento durable sobre él o su contexto.
- procedural: cómo le gusta operar al usuario, rutinas o estilo de trabajo.

Si no hay nada relevante, responde exactamente con [].
No incluyas conversación trivial, ni saludos, ni preguntas pendientes de respuesta.
No uses markdown ni bloques de código; solo el JSON.`;

function formatSessionTranscript(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const label =
        m.role === "user"
          ? "Usuario"
          : m.role === "assistant"
            ? "Asistente"
            : m.role === "tool"
              ? "Herramienta"
              : "Sistema";
      return `[${label}]\n${m.content}`;
    })
    .join("\n\n---\n\n");
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(trimmed);
  if (fence) return fence[1].trim();
  return trimmed;
}

function parseMemoryJson(raw: string): { type: MemoryType; content: string }[] {
  const cleaned = stripJsonFence(raw);
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) return [];
  const out: { type: MemoryType; content: string }[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = o.type;
    const content = o.content;
    if (
      type !== "episodic" &&
      type !== "semantic" &&
      type !== "procedural"
    ) {
      continue;
    }
    if (typeof content !== "string" || content.trim().length === 0) continue;
    out.push({ type, content: content.trim() });
  }
  return out;
}

function extractTextFromMessage(msg: { content: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text?: string }).text ?? "");
        return JSON.stringify(b);
      })
      .join("");
  }
  return JSON.stringify(c);
}

export async function flushMemory(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
}): Promise<void> {
  const { db, userId, sessionId } = params;
  try {
    const messages = await getSessionMessages(db, sessionId, 200);
    if (messages.length < 3) return;

    const transcript = formatSessionTranscript(messages);
    const compactionModel = createCompactionModel();

    const out = await compactionModel.invoke([
      new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
      new HumanMessage(`Conversación de la sesión:\n\n${transcript}`),
    ]);

    const rawText = extractTextFromMessage(out);
    let memories: { type: MemoryType; content: string }[];
    try {
      memories = parseMemoryJson(rawText);
    } catch {
      console.error("[flushMemory] JSON parse failed:", rawText.slice(0, 500));
      return;
    }

    if (memories.length === 0) return;

    const embedder = createEmbeddingModel();
    const contents = memories.map((m) => m.content);
    const vectors = await embedder.embedDocuments(contents);

    const rows: MemoryInsertRow[] = memories.map((m, i) => ({
      user_id: userId,
      type: m.type,
      content: m.content,
      embedding: vectors[i]!,
    }));

    await insertMemories(db, rows);
  } catch (err) {
    console.error("[flushMemory]", err);
  }
}
