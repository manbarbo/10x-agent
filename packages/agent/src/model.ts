import { ChatOpenAI } from "@langchain/openai";

const openRouterConfig = {
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": "https://agents.local",
  },
} as const;

export function createChatModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: "openai/gpt-4o-mini",
    temperature: 0.3,
    configuration: { ...openRouterConfig },
    apiKey,
  });
}

/** Haiku (or override via COMPACTION_MODEL_NAME) for history compaction only. */
export function createCompactionModel() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName:
      process.env.COMPACTION_MODEL_NAME ?? "anthropic/claude-3-5-haiku-20241022",
    temperature: 0.1,
    configuration: { ...openRouterConfig },
    apiKey,
  });
}
