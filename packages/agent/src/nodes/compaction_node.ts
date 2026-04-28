import { randomUUID } from "node:crypto";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { GraphState } from "../state";
import {
  appendCompactionLogBlock,
  formatMessagesDigest,
  getCompactionLogPath,
} from "./compaction_log";

const TOOL_RESULT_PLACEHOLDER = "[tool result cleared]";
/** ToolMessage results to keep verbatim (most recent in thread order). */
const TOOL_RESULTS_TO_KEEP = 5;
/** Raw messages kept after LLM compaction (recent tool/assistant context). */
const TAIL_MESSAGES_AFTER_LLM = 10;
const COMPACTION_THRESHOLD_RATIO = 0.8;
const MAX_LLM_FAILURE_STREAK = 3;

const DEFAULT_CONTEXT_WINDOW = 128_000;

function getContextWindowTokens(): number {
  const raw = process.env.AGENT_CONTEXT_WINDOW_TOKENS;
  if (raw == null || raw === "") return DEFAULT_CONTEXT_WINDOW;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXT_WINDOW;
}

function estimateMessageTokens(messages: BaseMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") chars += c.length;
    else chars += JSON.stringify(c).length;
    if (m instanceof AIMessage && m.tool_calls?.length) {
      chars += JSON.stringify(m.tool_calls).length;
    }
  }
  return Math.ceil(chars / 4);
}

function messageLabel(m: BaseMessage): string {
  if (m instanceof HumanMessage) return "Human";
  if (m instanceof AIMessage) return "AI";
  if (m instanceof ToolMessage) return `Tool(${m.name ?? "?"})`;
  if (m instanceof SystemMessage) return "System";
  return m._getType();
}

function transcriptForCompaction(messages: BaseMessage[]): string {
  return messages
    .map((m) => {
      const head = `[${messageLabel(m)}]`;
      let body: string;
      const c = m.content;
      if (typeof c === "string") body = c;
      else body = JSON.stringify(c);
      if (m instanceof AIMessage && m.tool_calls?.length) {
        body += `\n[tool_calls]: ${JSON.stringify(m.tool_calls)}`;
      }
      return `${head}\n${body}`;
    })
    .join("\n\n---\n\n");
}

function stripAnalysisBlock(text: string): string {
  return text.replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "").trim();
}

const COMPACTION_SYSTEM_PROMPT = `Eres un compactador de historial de conversación. Tu salida será guardada como contexto para un agente posterior.
Resume la conversación siguiente en EXACTAMENTE estas 9 secciones, en este orden, usando estos encabezados literales (markdown ##):

## 1. Objetivo del usuario
## 2. Decisiones y restricciones
## 3. Estado actual de la tarea
## 4. Entidades nombradas (repos, archivos, fechas, IDs)
## 5. Resultados de herramientas relevantes
## 6. Errores o bloqueos
## 7. Preguntas pendientes
## 8. Próximos pasos sugeridos
## 9. Advertencias para el agente

Sé fiel al texto; no inventes hechos. Omite ruido redundante. Escribe en español.
Opcionalmente puedes añadir un bloque <analysis>...</analysis> con razonamiento breve; ese bloque será descartado y no debe contener información que no esté repetida en las 9 secciones.`;

function cloneMessageForList(m: BaseMessage): BaseMessage {
  const id = m.id ?? randomUUID();
  if (m instanceof HumanMessage) {
    return new HumanMessage({ content: m.content, id, name: m.name });
  }
  if (m instanceof AIMessage) {
    return new AIMessage({
      content: m.content,
      id,
      name: m.name,
      tool_calls: m.tool_calls,
      invalid_tool_calls: m.invalid_tool_calls,
      usage_metadata: m.usage_metadata,
    });
  }
  if (m instanceof ToolMessage) {
    return new ToolMessage({
      content: m.content,
      tool_call_id: m.tool_call_id,
      id,
      name: m.name,
    });
  }
  if (m instanceof SystemMessage) {
    return new SystemMessage({ content: m.content, id, name: m.name });
  }
  return new HumanMessage({
    content: `[mensaje tipo ${m._getType()}]\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
    id,
  });
}

export type ClearedToolLog = {
  index: number;
  tool_call_id: string;
  messageId: string;
  name?: string;
  /** Extracto del contenido antes de ofuscar (una línea). */
  contentBeforePreview: string;
};

function applyMicrocompact(messages: BaseMessage[]): {
  list: BaseMessage[];
  changed: boolean;
  clearedTools: ClearedToolLog[];
} {
  const list = messages.map(cloneMessageForList);
  const toolIndices: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] instanceof ToolMessage) toolIndices.push(i);
  }
  const clearCount = Math.max(0, toolIndices.length - TOOL_RESULTS_TO_KEEP);
  const toClear = new Set(toolIndices.slice(0, clearCount));
  let changed = false;
  const clearedTools: ClearedToolLog[] = [];
  for (const i of toClear) {
    const tm = list[i] as ToolMessage;
    if (tm.content !== TOOL_RESULT_PLACEHOLDER) {
      const raw =
        typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
      const contentBeforePreview =
        raw.replace(/\s+/g, " ").trim().slice(0, 400) + (raw.length > 400 ? "…" : "");
      clearedTools.push({
        index: i,
        tool_call_id: tm.tool_call_id,
        messageId: String(tm.id),
        name: tm.name,
        contentBeforePreview,
      });
      list[i] = new ToolMessage({
        content: TOOL_RESULT_PLACEHOLDER,
        tool_call_id: tm.tool_call_id,
        id: tm.id,
        name: tm.name,
      });
      changed = true;
    }
  }
  return { list, changed, clearedTools };
}

function extractTextFromInvoke(res: BaseMessage): string {
  const c = res.content;
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

export function buildCompactionNode(
  compactionModel: BaseChatModel
): (state: typeof GraphState.State) => Promise<Partial<typeof GraphState.State>> {
  return async (state: typeof GraphState.State): Promise<Partial<typeof GraphState.State>> => {
    const logPath = getCompactionLogPath();
    const log: string[] = [];
    const L = (...lines: string[]) => {
      for (const line of lines) log.push(line);
    };

    const windowTokens = getContextWindowTokens();
    const threshold = Math.floor(COMPACTION_THRESHOLD_RATIO * windowTokens);
    const prevCount = state.compactionCount ?? 0;
    let failureStreak = state.compactionFailureStreak ?? 0;
    const tokensBefore = estimateMessageTokens(state.messages);

    L(`sessionId=${state.sessionId}`, `userId=${state.userId}`);
    L(
      `tokens_estimados_antes_micro=${tokensBefore} ventana=${windowTokens} umbral_80pct=${threshold} failureStreak=${failureStreak} compactionCount=${prevCount}`
    );
    if (logPath) {
      L(`log_file=${logPath}`);
    } else {
      L("log_file=(desactivado: COMPACTION_LOG=0)");
    }
    L(formatMessagesDigest(state.messages, "ANTES (mensajes en estado al entrar al nodo)"));

    const { list: microList, changed: microChanged, clearedTools } = applyMicrocompact(
      state.messages
    );
    const tokensAfterMicro = estimateMessageTokens(microList);
    const underThreshold = tokensAfterMicro <= threshold;

    const removeAll = new RemoveMessage({ id: REMOVE_ALL_MESSAGES });

    if (clearedTools.length > 0) {
      L(
        `[microcompact] Ofuscados ${clearedTools.length} ToolMessage(s) (se conservan íntegros los últimos ${TOOL_RESULTS_TO_KEEP} por orden de hilo).`
      );
      for (const c of clearedTools) {
        L(
          `  · índice=${c.index} tool_call_id=${c.tool_call_id} msg_id=${c.messageId} name=${c.name ?? ""}`
        );
        L(`    contenido_antes: ${c.contentBeforePreview}`);
        L(`    contenido_después: ${TOOL_RESULT_PLACEHOLDER}`);
      }
    } else {
      L("[microcompact] Sin cambios (ningún tool result antiguo que limpiar).");
    }
    L(`tokens_estimados_tras_micro=${tokensAfterMicro}`);

    let result: Partial<typeof GraphState.State>;

    if (underThreshold && !microChanged) {
      L(
        "[decisión] bajo_umbral sin_cambios_micro → no_op (solo reset failureStreak si aplica)"
      );
      result = failureStreak !== 0 ? { compactionFailureStreak: 0 } : {};
      L(formatMessagesDigest(state.messages, "DESPUÉS (sin mutación de mensajes)"));
      await appendCompactionLogBlock(log);
      return result;
    }

    if (underThreshold && microChanged) {
      L("[decisión] bajo_umbral con_microcompact → reemplazar historial solo con lista microcompactada (sin LLM).");
      result = {
        messages: [removeAll, ...microList],
        compactionFailureStreak: 0,
      };
      L(formatMessagesDigest(microList, "DESPUÉS (historial tras microcompact)"));
      await appendCompactionLogBlock(log);
      return result;
    }

    if (failureStreak >= MAX_LLM_FAILURE_STREAK) {
      L(
        `[decisión] circuit_breaker (failureStreak>=${MAX_LLM_FAILURE_STREAK}) → sin LLM, solo historial microcompactado`
      );
      result = {
        messages: [removeAll, ...microList],
      };
      L(formatMessagesDigest(microList, "DESPUÉS (solo micro; LLM omitido por breaker)"));
      await appendCompactionLogBlock(log);
      return result;
    }

    const transcript = transcriptForCompaction(microList);
    const transcriptChars = transcript.length;
    L(
      `[llm_compaction] Invocando modelo de compactación. transcript_chars=${transcriptChars} (entrada al LLM = system prompt + conversación en texto)`
    );

    let summaryText: string;
    try {
      const out = await compactionModel.invoke([
        new SystemMessage(COMPACTION_SYSTEM_PROMPT),
        new HumanMessage(
          `Conversación a compactar (después de limpiar resultados de herramientas antiguos):\n\n${transcript}`
        ),
      ]);
      summaryText = stripAnalysisBlock(extractTextFromInvoke(out));
      if (!summaryText) {
        throw new Error("Empty compaction summary");
      }
      const preview = summaryText.replace(/\s+/g, " ").trim().slice(0, 500);
      L(
        `[llm_compaction] OK. resumen_chars=${summaryText.length} resumen_preview: ${preview}${summaryText.length > 500 ? "…" : ""}`
      );
    } catch (err) {
      failureStreak += 1;
      L(`[llm_compaction] ERROR → ${String(err)}. failureStreak_nuevo=${failureStreak}`);
      result = {
        messages: [removeAll, ...microList],
        compactionFailureStreak: failureStreak,
      };
      L(formatMessagesDigest(microList, "DESPUÉS (fallo LLM; historial = solo microcompact)"));
      await appendCompactionLogBlock(log);
      return result;
    }

    const tail = microList.slice(-TAIL_MESSAGES_AFTER_LLM);
    const summaryMsg = new SystemMessage({
      content: `Contexto compactado de la conversación anterior (no repetir acciones ya ejecutadas salvo que el usuario lo pida):\n\n${summaryText}`,
    });
    const finalMessages: BaseMessage[] = [summaryMsg, ...tail];
    L(
      `[decisión] sobre_umbral + LLM OK → RemoveAll + SystemMessage(resumen) + tail de ${tail.length} mensajes`
    );
    L(
      formatMessagesDigest(
        finalMessages,
        `DESPUÉS (mensajes finales: 1 system compactado + ${tail.length} del tail)`
      )
    );

    result = {
      messages: [removeAll, ...finalMessages],
      compactionFailureStreak: 0,
      compactionCount: prevCount + 1,
    };
    await appendCompactionLogBlock(log);
    return result;
  };
}
