// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { prepareLangfuseOpenTelemetryForSentry } from "@agents/agent/langfuse-otel";

const langfuseSpanProcessors = prepareLangfuseOpenTelemetryForSentry();

Sentry.init({
  dsn: "https://c2a60941a83a98d8d40a752e43249e76@o4511306952081408.ingest.us.sentry.io/4511306980524032",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  ...(langfuseSpanProcessors.length > 0
    ? { openTelemetrySpanProcessors: langfuseSpanProcessors }
    : {}),
});
