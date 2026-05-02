import { configureGlobalLogger, LogLevel } from "@langfuse/core";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  langfuseKeysPresent,
  readEnvTrimmed,
  readLangfuseBaseUrl,
} from "./langfuse_env";

const GLOBAL_KEY = Symbol.for("agents.langfuse_otel");
const DEBUG_LOGGER_KEY = Symbol.for("agents.langfuse_debug_logger");
const OTEL_DIAG_KEY = Symbol.for("agents.langfuse_otel_diag");

type LangfuseOtelStore = { processor: LangfuseSpanProcessor };

function getStore(): LangfuseOtelStore | undefined {
  return (globalThis as Record<symbol, LangfuseOtelStore | undefined>)[GLOBAL_KEY];
}

function setStore(store: LangfuseOtelStore): void {
  (globalThis as Record<symbol, LangfuseOtelStore>)[GLOBAL_KEY] = store;
}

function isLangfuseDebugEnabled(): boolean {
  const v = process.env.LANGFUSE_DEBUG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Verbose Langfuse SDK logs + our console lines (see LANGFUSE_DEBUG in .env). */
function ensureLangfuseDebugLoggerOnce(): void {
  const g = globalThis as typeof globalThis & { [DEBUG_LOGGER_KEY]?: boolean };
  if (g[DEBUG_LOGGER_KEY]) return;
  g[DEBUG_LOGGER_KEY] = true;
  if (isLangfuseDebugEnabled()) {
    configureGlobalLogger({ level: LogLevel.DEBUG, prefix: "[Langfuse]" });
  }
}

function ensureOtelDiagOnce(): void {
  const g = globalThis as typeof globalThis & { [OTEL_DIAG_KEY]?: boolean };
  if (g[OTEL_DIAG_KEY]) return;
  g[OTEL_DIAG_KEY] = true;
  if (!isLangfuseDebugEnabled()) return;
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

function exportAllSpans(): boolean {
  const v = readEnvTrimmed("LANGFUSE_EXPORT_ALL_SPANS")?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function otelImmediateMode(): boolean {
  const v = readEnvTrimmed("LANGFUSE_OTEL_IMMEDIATE")?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function otelForceBatched(): boolean {
  const v = readEnvTrimmed("LANGFUSE_OTEL_BATCHED")?.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Export inmediato: serverless, desarrollo y Docker suelen cortar el proceso antes del batch.
 * En producción Node de larga duración, fuerza batch con LANGFUSE_OTEL_BATCHED=1.
 */
function otelDefaultImmediateForPlatform(): boolean {
  if (otelForceBatched()) return false;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function buildLangfuseSpanProcessor(): LangfuseSpanProcessor {
  const publicKey = readEnvTrimmed("LANGFUSE_PUBLIC_KEY")!;
  const secretKey = readEnvTrimmed("LANGFUSE_SECRET_KEY")!;
  const baseUrl = readLangfuseBaseUrl() ?? "https://cloud.langfuse.com";

  const tracingEnv = readEnvTrimmed("LANGFUSE_TRACING_ENVIRONMENT");
  const release = readEnvTrimmed("LANGFUSE_RELEASE");

  const useImmediate =
    otelImmediateMode() || (otelDefaultImmediateForPlatform() && !otelForceBatched());

  return new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    ...(tracingEnv ? { environment: tracingEnv } : {}),
    ...(release ? { release } : {}),
    additionalHeaders: {
      "x-langfuse-ingestion-version": "4",
    },
    ...(exportAllSpans() ? { shouldExportSpan: () => true } : {}),
    ...(useImmediate ? { exportMode: "immediate" as const } : {}),
  });
}

/**
 * Crea el {@link LangfuseSpanProcessor}, lo guarda para {@link flushLangfuseTelemetry}
 * y devuelve la lista para pasar a `Sentry.init({ openTelemetrySpanProcessors })`.
 *
 * **Importante:** no uses `NodeSDK` en la misma app que `@sentry/nextjs`: Sentry ya registra
 * la API global de OpenTelemetry; un segundo `NodeSDK.start()` provoca
 * "Attempted duplicate registration of API: trace/context/propagation".
 */
export function prepareLangfuseOpenTelemetryForSentry(): SpanProcessor[] {
  ensureLangfuseDebugLoggerOnce();
  ensureOtelDiagOnce();

  if (!langfuseKeysPresent()) {
    return [];
  }
  if (getStore()) {
    return [getStore()!.processor];
  }

  const processor = buildLangfuseSpanProcessor();
  setStore({ processor });

  if (isLangfuseDebugEnabled()) {
    const publicKey = readEnvTrimmed("LANGFUSE_PUBLIC_KEY")!;
    const baseUrl = readLangfuseBaseUrl() ?? "https://cloud.langfuse.com";
    const otlp = `${baseUrl}/api/public/otel/v1/traces`;
    console.info("[Langfuse] SpanProcessor registrado junto a Sentry (openTelemetrySpanProcessors).");
    console.info("[Langfuse] OTLP URL:", otlp);
    console.info("[Langfuse] publicKey prefix:", publicKey.slice(0, 12) + "…");
  }

  return [processor];
}

/**
 * Asegura logs de depuración; el export OTEL lo monta Sentry vía {@link prepareLangfuseOpenTelemetryForSentry}.
 */
export function ensureLangfuseOtelStarted(): void {
  ensureLangfuseDebugLoggerOnce();
  ensureOtelDiagOnce();

  if (!langfuseKeysPresent()) {
    if (isLangfuseDebugEnabled()) {
      console.info(
        "[Langfuse] OTEL omitido: faltan LANGFUSE_SECRET_KEY o LANGFUSE_PUBLIC_KEY en el entorno del servidor."
      );
    }
    return;
  }
  if (getStore()?.processor) return;

  if (isLangfuseDebugEnabled()) {
    console.info(
      "[Langfuse] Claves presentes pero el SpanProcessor aún no está registrado. " +
        "Debe llamarse prepareLangfuseOpenTelemetryForSentry() dentro de Sentry.init (ver sentry.server.config.ts)."
    );
  }
}

/** Fuerza el envío de spans pendientes antes de que termine la petición. */
export async function flushLangfuseTelemetry(): Promise<void> {
  const store = getStore();
  if (!store) return;
  try {
    await store.processor.forceFlush();
    if (isLangfuseDebugEnabled()) {
      console.info("[Langfuse] forceFlush completado.");
    }
  } catch (err) {
    console.error("[Langfuse] forceFlush falló (revisa BASE_URL, claves y que Langfuse esté arriba):", err);
  }
}
