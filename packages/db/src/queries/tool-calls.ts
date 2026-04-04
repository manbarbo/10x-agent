import type { DbClient } from "../client";
import type { ToolCall } from "@agents/types";

export async function createToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  requiresConfirmation: boolean
) {
  const { data, error } = await db
    .from("tool_calls")
    .insert({
      session_id: sessionId,
      tool_name: toolName,
      arguments_json: args,
      status: requiresConfirmation ? "pending_confirmation" : "approved",
      requires_confirmation: requiresConfirmation,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ToolCall;
}

export async function updateToolCallStatus(
  db: DbClient,
  toolCallId: string,
  status: ToolCall["status"],
  resultJson?: Record<string, unknown>
) {
  const update: Record<string, unknown> = { status };
  if (resultJson) update.result_json = resultJson;
  if (status === "executed" || status === "failed") {
    update.finished_at = new Date().toISOString();
  }
  const { error } = await db
    .from("tool_calls")
    .update(update)
    .eq("id", toolCallId);
  if (error) throw error;
}

export async function getPendingToolCall(db: DbClient, toolCallId: string) {
  const { data } = await db
    .from("tool_calls")
    .select("*")
    .eq("id", toolCallId)
    .eq("status", "pending_confirmation")
    .single();
  return data as ToolCall | null;
}

/**
 * Finds an existing pending tool call for the given session + tool name.
 * Used to make toolExecutorNode idempotent when the node replays after resume.
 */
export async function findExistingPendingToolCall(
  db: DbClient,
  sessionId: string,
  toolName: string
): Promise<ToolCall | null> {
  const { data } = await db
    .from("tool_calls")
    .select("*")
    .eq("session_id", sessionId)
    .eq("tool_name", toolName)
    .eq("status", "pending_confirmation")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return data as ToolCall | null;
}
