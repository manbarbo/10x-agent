import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const extraAllowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? [];

// ngrok free tiers use `.ngrok-free.app` or `.ngrok-free.dev` depending on account/region.
const allowedDevOrigins = [
  "*.ngrok-free.app",
  "*.ngrok-free.dev",
  ...extraAllowedDevOrigins,
];

const nextConfig: NextConfig = {
  transpilePackages: ["@agents/agent", "@agents/db", "@agents/types"],
  serverExternalPackages: [
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
    // Una sola copia de OTEL en runtime (evita que Turbopack duplique el singleton de @opentelemetry/api;
    // sin esto, Langfuse puede loguear callbacks pero no exportar trazas al backend).
    "@opentelemetry/api",
    "@opentelemetry/core",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-trace-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@langfuse/core",
    "@langfuse/tracing",
    "@langfuse/otel",
    "@langfuse/langchain",
  ],
  allowedDevOrigins,
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "manuel-barona",

  project: "lab10-agent",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
