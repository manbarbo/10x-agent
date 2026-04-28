import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";

const PREVIEW_CHARS = 220;
const MAX_LINES_DIGEST = 100;

function truncateOneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function contentPreview(m: BaseMessage): string {
  const c = m.content;
  const raw = typeof c === "string" ? c : JSON.stringify(c);
  return truncateOneLine(raw, PREVIEW_CHARS);
}

/** Ruta del archivo .log: `COMPACTION_LOG_PATH` o `logs/compaction.log` bajo cwd. Desactivar: `COMPACTION_LOG=0`. */
export function getCompactionLogPath(): string | null {
  if (process.env.COMPACTION_LOG === "0") return null;
  const explicit = process.env.COMPACTION_LOG_PATH?.trim();
  if (explicit) return explicit;
  return join(process.cwd(), "logs", "compaction.log");
}

export function formatMessagesDigest(messages: BaseMessage[], label: string): string {
  const lines: string[] = [`--- ${label} (${messages.length} mensajes) ---`];
  const limit = Math.min(messages.length, MAX_LINES_DIGEST);
  for (let i = 0; i < limit; i++) {
    const m = messages[i];
    let kind = m._getType();
    if (m instanceof ToolMessage) {
      kind = `tool name=${m.name ?? "?"} tool_call_id=${m.tool_call_id}`;
    }
    const len =
      typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
    lines.push(`  [${i}] ${kind} id=${m.id ?? "(sin id)"} len=${len}`);
    lines.push(`      preview: ${contentPreview(m)}`);
  }
  if (messages.length > limit) {
    lines.push(`  … (${messages.length - limit} mensajes omitidos del digest)`);
  }
  return lines.join("\n");
}

export async function appendCompactionLogBlock(lines: string[]): Promise<void> {
  const filePath = getCompactionLogPath();
  if (!filePath) return;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    const stamp = new Date().toISOString();
    const header = `\n${"=".repeat(88)}\n[${stamp}] compaction\n${"=".repeat(88)}\n`;
    await appendFile(filePath, header + lines.join("\n") + "\n", "utf8");
  } catch (err) {
    console.error("[compaction-log] escritura fallida:", err);
  }
}
