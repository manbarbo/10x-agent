/**
 * Read Langfuse-related env vars the same way in all entrypoints.
 * Dotenv / shells sometimes leave surrounding quotes, which breaks Basic auth.
 */
export function readEnvTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) return undefined;
  let s = raw.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s.length > 0 ? s : undefined;
}

export function readLangfuseBaseUrl(): string | undefined {
  const s =
    readEnvTrimmed("LANGFUSE_BASE_URL") ?? readEnvTrimmed("LANGFUSE_BASEURL");
  if (!s) return undefined;
  return s.replace(/\/+$/, "");
}

export function langfuseKeysPresent(): boolean {
  return Boolean(
    readEnvTrimmed("LANGFUSE_SECRET_KEY") && readEnvTrimmed("LANGFUSE_PUBLIC_KEY")
  );
}
