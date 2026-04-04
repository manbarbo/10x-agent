import { createToolCall, updateToolCallStatus } from "@agents/db";
import type { ToolContext } from "./adapters";

export function withTracking<T extends Record<string, unknown>>(
  toolId: string,
  handler: (input: T, ctx: ToolContext) => Promise<Record<string, unknown>>,
  ctx: ToolContext
): (input: T) => Promise<string> {
  return async (input) => {
    const record = await createToolCall(ctx.db, ctx.sessionId, toolId, input, false);

    try {
      const result = await handler(input, ctx);
      await updateToolCallStatus(ctx.db, record.id, "executed", result);
      return JSON.stringify(result);
    } catch (err) {
      const errResult = { error: String(err) };
      await updateToolCallStatus(ctx.db, record.id, "failed", errResult);
      return JSON.stringify(errResult);
    }
  };
}
