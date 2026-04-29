import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Embeddings } from "@langchain/core/embeddings";
import type { DbClient } from "@agents/db";
import {
  getSessionMessages,
  getProfile,
  insertMemories,
  matchMemoriesForMerge,
  updateMemoryContentEmbedding,
  type MemoryInsertRow,
  type MemoryType,
} from "@agents/db";
import type { AgentMessage } from "@agents/types";
import { createCompactionModel, createEmbeddingModel } from "./model";

const DEFAULT_MERGE_THRESHOLD = 0.88;
const INTRA_BATCH_HIGH_SIM = 0.97;

const EXTRACTION_SYSTEM_PROMPT = `Extrae de esta conversación solo los hechos que seguirán siendo verdad en la próxima sesión.
Responde ÚNICAMENTE con JSON válido: un array de objetos con forma { "type": "episodic" | "semantic" | "procedural", "content": "string" }.
- episodic: qué hizo el usuario o el asistente y cuándo (hechos concretos de la sesión que importen después).
- semantic: preferencias del usuario o conocimiento durable sobre él o su contexto.
- procedural: cómo le gusta operar al usuario, rutinas o estilo de trabajo.

Si no hay nada relevante, responde exactamente con [].
No incluyas conversación trivial, ni saludos, ni preguntas pendientes de respuesta.
No uses markdown ni bloques de código; solo el JSON.`;

const RECONCILE_SYSTEM_PROMPT = `Eres un conservador de memoria a largo plazo. Comparas un recuerdo EXISTENTE con un CANDIDATO nuevo (misma sesión o misma categoría). La similitud semántica entre ambos es alta (posible duplicado).

Responde SOLO con JSON válido de una sola línea o compacto:
{ "action": "keep_existing" | "replace_with_new" | "merge", "final_content": "string" }

Reglas:
- keep_existing: el existente ya basta o el candidato no aporta nada durable; final_content puede ser "".
- replace_with_new: el candidato corrige o sustituye mejor al existente; final_content debe ser el texto definitivo (sin inventar hechos).
- merge: un solo texto claro que combine ambos sin contradicciones; final_content obligatorio.

Si hay contradicción, prefiere keep_existing o replace_with_new con el dato más fiable. No uses markdown ni bloques de código.`;

type CandidateRow = { type: MemoryType; content: string; embedding: number[] };

type ReconcileAction = "keep_existing" | "replace_with_new" | "merge";

function clampMergeThreshold(raw: number | undefined | null): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_MERGE_THRESHOLD;
  return Math.min(1, Math.max(0, raw));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

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

function parseReconcileJson(raw: string): { action: ReconcileAction; final_content: string } {
  const cleaned = stripJsonFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { action: "keep_existing", final_content: "" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { action: "keep_existing", final_content: "" };
  }
  const o = parsed as Record<string, unknown>;
  const action = o.action;
  const final_content = o.final_content;
  if (
    action !== "keep_existing" &&
    action !== "replace_with_new" &&
    action !== "merge"
  ) {
    return { action: "keep_existing", final_content: "" };
  }
  const fc = typeof final_content === "string" ? final_content.trim() : "";
  return { action, final_content: fc };
}

async function invokeReconcile(
  model: BaseChatModel,
  existingContent: string,
  candidateContent: string,
  memoryType: MemoryType,
  similarity: number
): Promise<{ action: ReconcileAction; final_content: string }> {
  const human = `tipo: ${memoryType}
similitud_cosine: ${similarity.toFixed(4)}

EXISTENTE:
${existingContent}

CANDIDATO:
${candidateContent}`;

  const out = await model.invoke([
    new SystemMessage(RECONCILE_SYSTEM_PROMPT),
    new HumanMessage(human),
  ]);
  const rawText = extractTextFromMessage(out as { content: unknown });
  return parseReconcileJson(rawText);
}

/** Reduce near-duplicates inside the same flush (same type + cosine ≥ threshold). */
async function dedupeIntraBatch(
  items: CandidateRow[],
  threshold: number,
  model: BaseChatModel,
  embedder: Embeddings
): Promise<CandidateRow[]> {
  const out: CandidateRow[] = [];

  for (const c of items) {
    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.type !== c.type) continue;
      const sim = cosineSimilarity(c.embedding, out[i]!.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx < 0 || bestSim < threshold) {
      out.push({ ...c });
      continue;
    }

    const existing = out[bestIdx]!;

    if (bestSim >= INTRA_BATCH_HIGH_SIM) {
      const chosen =
        existing.content.length >= c.content.length ? existing.content : c.content;
      const emb = await embedder.embedQuery(chosen);
      out[bestIdx] = { type: c.type, content: chosen, embedding: emb };
      continue;
    }

    const decision = await invokeReconcile(
      model,
      existing.content,
      c.content,
      c.type,
      bestSim
    );

    if (decision.action === "keep_existing") {
      continue;
    }

    if (decision.action === "replace_with_new") {
      const fc = decision.final_content || c.content;
      const emb = await embedder.embedQuery(fc);
      out[bestIdx] = { type: c.type, content: fc.trim(), embedding: emb };
      continue;
    }

    const fc = decision.final_content || `${existing.content}\n\n${c.content}`;
    const emb = await embedder.embedQuery(fc.trim());
    out[bestIdx] = { type: c.type, content: fc.trim(), embedding: emb };
  }

  return out;
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

    let threshold = DEFAULT_MERGE_THRESHOLD;
    try {
      const profile = await getProfile(db, userId);
      threshold = clampMergeThreshold(profile.memory_merge_similarity_threshold);
    } catch {
      /* perfil ausente o columna vieja: default */
    }

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

    let candidates: CandidateRow[] = memories.map((m, i) => ({
      type: m.type,
      content: m.content,
      embedding: vectors[i]!,
    }));

    candidates = await dedupeIntraBatch(candidates, threshold, compactionModel, embedder);

    const toInsert: MemoryInsertRow[] = [];

    for (const row of candidates) {
      const neighbors = await matchMemoriesForMerge(db, userId, row.type, row.embedding, 5);
      const top = neighbors[0];

      if (!top || top.similarity < threshold) {
        toInsert.push({
          user_id: userId,
          type: row.type,
          content: row.content,
          embedding: row.embedding,
        });
        continue;
      }

      const decision = await invokeReconcile(
        compactionModel,
        top.content,
        row.content,
        row.type,
        top.similarity
      );

      if (decision.action === "keep_existing") {
        continue;
      }

      const fc =
        decision.action === "replace_with_new"
          ? decision.final_content || row.content
          : decision.final_content || `${top.content}\n\n${row.content}`;

      const trimmed = fc.trim();
      if (!trimmed) continue;

      const newEmb = await embedder.embedQuery(trimmed);
      await updateMemoryContentEmbedding(db, top.id, trimmed, newEmb);
    }

    if (toInsert.length > 0) {
      await insertMemories(db, toInsert);
    }
  } catch (err) {
    console.error("[flushMemory]", err);
  }
}
