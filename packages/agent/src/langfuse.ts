import { CallbackHandler } from "@langfuse/langchain";
import { readEnvTrimmed } from "./langfuse_env";

function langfuseDebug(): boolean {
  const v = process.env.LANGFUSE_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function isLangfuseConfigured(): boolean {
  return Boolean(
    readEnvTrimmed("LANGFUSE_SECRET_KEY") && readEnvTrimmed("LANGFUSE_PUBLIC_KEY")
  );
}

/**
 * Langfuse {@link CallbackHandler} for LangChain / LangGraph (see Langfuse LangChain integration).
 * Returns undefined when keys are unset so local runs work without Langfuse.
 */
export function createLangfuseCallbackHandler(options: {
  userId: string;
  sessionId: string;
  tags?: string[];
  traceMetadata?: Record<string, unknown>;
}): CallbackHandler | undefined {
  if (!isLangfuseConfigured()) return undefined;
  if (langfuseDebug()) {
    console.info("[Langfuse] CallbackHandler creado (sessionId presente en el trace).");
  }
  const tags = ["langgraph", ...(options.tags ?? [])];
  return new CallbackHandler({
    userId: options.userId,
    sessionId: options.sessionId,
    tags,
    ...(readEnvTrimmed("LANGFUSE_RELEASE")
      ? { version: readEnvTrimmed("LANGFUSE_RELEASE") }
      : {}),
    traceMetadata: options.traceMetadata,
  });
}
