import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getGoogleCalendarAccessToken, type DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "@agents/types";
import { TOOL_SCHEMAS } from "./schemas";
import { withTracking } from "./withTracking";
import { executeBash } from "./bashExec";
import { executeReadFile, executeWriteFile, executeEditFile } from "./fileTools";

const GITHUB_API = "https://api.github.com";
const GITHUB_UA = "10x-builders-agent/1.0";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Inclusive start and exclusive end of `dateStr` (YYYY-MM-DD) in `timeZone`, as UTC ISO strings for the Calendar API. */
function zonedDayRangeRFC3339(dateStr: string, timeZone: string): { timeMin: string; timeMax: string } {
  const [y, mo, d] = dateStr.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) {
    throw new Error("Invalid date format, use YYYY-MM-DD");
  }
  const dayFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const anchor = Date.UTC(y, mo - 1, d, 12, 0, 0);
  const lo = anchor - 48 * 3600 * 1000;
  const hi = anchor + 48 * 3600 * 1000;

  let first: number | null = null;
  for (let t = lo; t < hi; t += 60000) {
    if (dayFmt.format(new Date(t)) === dateStr) {
      first = t;
      break;
    }
  }
  if (first === null) {
    throw new Error(`Could not resolve local day ${dateStr} in ${timeZone}`);
  }
  while (first > lo && dayFmt.format(new Date(first - 1)) === dateStr) {
    first -= 1;
  }

  let lastExc: number | null = null;
  for (let t = first + 1; t < first + 48 * 3600 * 1000; t += 60000) {
    if (dayFmt.format(new Date(t)) !== dateStr) {
      lastExc = t;
      break;
    }
  }
  if (lastExc === null) {
    lastExc = first + 24 * 3600 * 1000;
  } else {
    while (lastExc > first && dayFmt.format(new Date(lastExc - 1)) === dateStr) {
      lastExc -= 1;
    }
  }

  return {
    timeMin: new Date(first).toISOString(),
    timeMax: new Date(lastExc).toISOString(),
  };
}

async function calFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${GOOGLE_CALENDAR_API}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Google Calendar API ${res.status}: ${text}`);
  }
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function parseEventInstant(ev: Record<string, unknown>, key: "start" | "end"): number {
  const seg = ev[key] as Record<string, unknown> | undefined;
  if (!seg) return NaN;
  if (typeof seg.dateTime === "string") return Date.parse(seg.dateTime);
  if (typeof seg.date === "string") return Date.parse(`${seg.date}T00:00:00Z`);
  return NaN;
}

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": GITHUB_UA,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function ghFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...ghHeaders(token), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.json();
}

export async function executeGitHubTool(
  toolName: string,
  args: Record<string, unknown>,
  token: string
): Promise<Record<string, unknown>> {
  switch (toolName) {
    case "github_list_repos": {
      const perPage = (args.per_page as number) || 10;
      const repos = await ghFetch(token, `/user/repos?per_page=${perPage}&sort=updated`);
      return {
        repos: (repos as Array<Record<string, unknown>>).map((r) => ({
          full_name: r.full_name,
          description: r.description,
          html_url: r.html_url,
          private: r.private,
          language: r.language,
          updated_at: r.updated_at,
        })),
      };
    }
    case "github_list_issues": {
      const state = (args.state as string) || "open";
      const issues = await ghFetch(
        token,
        `/repos/${args.owner}/${args.repo}/issues?state=${state}`
      );
      return {
        issues: (issues as Array<Record<string, unknown>>).map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          html_url: i.html_url,
          created_at: i.created_at,
          user: (i.user as Record<string, unknown>)?.login,
        })),
      };
    }
    case "github_create_issue": {
      const issue = await ghFetch(
        token,
        `/repos/${args.owner}/${args.repo}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: args.title, body: args.body ?? "" }),
        }
      );
      return {
        message: "Issue created",
        issue_number: (issue as Record<string, unknown>).number,
        issue_url: (issue as Record<string, unknown>).html_url,
      };
    }
    case "github_create_repo": {
      const repo = await ghFetch(token, "/user/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: args.name,
          description: args.description ?? "",
          private: args.isPrivate ?? false,
        }),
      });
      return {
        message: "Repository created",
        full_name: (repo as Record<string, unknown>).full_name,
        html_url: (repo as Record<string, unknown>).html_url,
      };
    }
    default:
      throw new Error(`Unknown GitHub tool: ${toolName}`);
  }
}

type ToolHandlers = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in string]: (input: any, ctx: ToolContext) => Promise<Record<string, unknown>>;
};

export const TOOL_HANDLERS: ToolHandlers = {
  get_user_preferences: async (_input, ctx) => {
    const { getProfile } = await import("@agents/db");
    const profile = await getProfile(ctx.db, ctx.userId);
    return {
      name: profile.name,
      timezone: profile.timezone,
      language: profile.language,
      agent_name: profile.agent_name,
    };
  },

  list_enabled_tools: async (_input, ctx) => {
    const enabled = ctx.enabledTools.filter((t) => t.enabled).map((t) => t.tool_id);
    return { enabled };
  },

  github_list_repos: async (input, ctx) =>
    executeGitHubTool("github_list_repos", input, ctx.githubToken!),

  github_list_issues: async (input, ctx) =>
    executeGitHubTool("github_list_issues", input, ctx.githubToken!),

  github_create_issue: async (input, ctx) =>
    executeGitHubTool("github_create_issue", input, ctx.githubToken!),

  github_create_repo: async (input, ctx) =>
    executeGitHubTool("github_create_repo", input, ctx.githubToken!),

  read_file: async (input: { path: string; offset?: number; limit?: number }) => {
    const result = await executeReadFile(input);
    return result as unknown as Record<string, unknown>;
  },

  write_file: async (input: { path: string; content: string }) => {
    const result = await executeWriteFile(input);
    return result as unknown as Record<string, unknown>;
  },

  edit_file: async (input: { path: string; old_string: string; new_string: string }) => {
    const result = await executeEditFile(input);
    return result as unknown as Record<string, unknown>;
  },

  bash: async (input: { terminal: string; prompt: string }) => {
    const result = await executeBash(input.terminal, input.prompt);
    return result as unknown as Record<string, unknown>;
  },

  schedule_task: async (
    input: {
      prompt: string;
      schedule_type: "one_time" | "recurring";
      run_at?: string;
      cron_expr?: string;
      timezone?: string;
    },
    ctx: ToolContext
  ) => {
    const { Cron } = await import("croner");
    const { createScheduledTask } = await import("@agents/db");
    const { getProfile } = await import("@agents/db");

    const profile = await getProfile(ctx.db, ctx.userId);
    const tz = input.timezone ?? profile.timezone ?? "UTC";

    let nextRunAt: string;

    if (input.schedule_type === "one_time") {
      if (!input.run_at) throw new Error("run_at is required for one_time tasks");
      nextRunAt = new Date(input.run_at).toISOString();
    } else {
      if (!input.cron_expr) throw new Error("cron_expr is required for recurring tasks");
      const job = new Cron(input.cron_expr, { timezone: tz });
      const next = job.nextRun();
      if (!next) throw new Error("Could not compute next run from cron expression");
      nextRunAt = next.toISOString();
    }

    const task = await createScheduledTask(ctx.db, {
      userId: ctx.userId,
      prompt: input.prompt,
      scheduleType: input.schedule_type,
      runAt: input.run_at,
      cronExpr: input.cron_expr,
      timezone: tz,
      nextRunAt,
    });

    const readableTime = new Date(nextRunAt).toLocaleString("es", {
      timeZone: tz,
      dateStyle: "full",
      timeStyle: "short",
    });

    return {
      ok: true,
      task_id: task.id,
      schedule_type: task.schedule_type,
      next_run_at: nextRunAt,
      message:
        input.schedule_type === "one_time"
          ? `Tarea programada para el ${readableTime} (${tz}). Recibirás el resultado por Telegram.`
          : `Tarea recurrente creada con expresión "${input.cron_expr}". Próxima ejecución: ${readableTime} (${tz}).`,
    };
  },

  calendar_list_events: async (
    input: { date: string; timezone?: string },
    ctx: ToolContext
  ) => {
    const token = await getGoogleCalendarAccessToken(ctx.db, ctx.userId);
    if (!token) throw new Error("Google Calendar no conectado");
    const { getProfile } = await import("@agents/db");
    const profile = await getProfile(ctx.db, ctx.userId);
    const tz = input.timezone ?? profile.timezone ?? "UTC";
    const { timeMin, timeMax } = zonedDayRangeRFC3339(input.date, tz);
    const path = `calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(
      timeMin
    )}&timeMax=${encodeURIComponent(timeMax)}`;
    const data = (await calFetch(token, path)) as { items?: Array<Record<string, unknown>> };
    const items = data.items ?? [];
    return {
      date: input.date,
      timezone: tz,
      events: items.map((e) => ({
        id: e.id,
        summary: e.summary ?? "(sin título)",
        start: e.start,
        end: e.end,
        htmlLink: e.htmlLink,
        status: e.status,
      })),
    };
  },

  calendar_create_event: async (
    input: {
      title: string;
      start: string;
      duration_minutes: number;
      timezone?: string;
      description?: string;
      attendees?: string[];
    },
    ctx: ToolContext
  ) => {
    const token = await getGoogleCalendarAccessToken(ctx.db, ctx.userId);
    if (!token) throw new Error("Google Calendar no conectado");
    const startMs = Date.parse(input.start);
    if (Number.isNaN(startMs)) {
      throw new Error(
        "Fecha de inicio inválida; usa ISO 8601 con zona u offset (ej. 2026-04-12T15:00:00-05:00)"
      );
    }
    const endMs = startMs + input.duration_minutes * 60 * 1000;
    const body: Record<string, unknown> = {
      summary: input.title,
      description: input.description ?? "",
      start: { dateTime: new Date(startMs).toISOString() },
      end: { dateTime: new Date(endMs).toISOString() },
    };
    if (input.attendees?.length) {
      body.attendees = input.attendees.map((email: string) => ({ email }));
    }
    const created = (await calFetch(token, "calendars/primary/events", {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, unknown>;
    return {
      message: "Evento creado",
      event_id: created.id,
      html_link: created.htmlLink,
      start: created.start,
      end: created.end,
    };
  },

  calendar_cancel_event: async (input: { event_id: string }, ctx: ToolContext) => {
    const token = await getGoogleCalendarAccessToken(ctx.db, ctx.userId);
    if (!token) throw new Error("Google Calendar no conectado");
    const path = `calendars/primary/events/${encodeURIComponent(input.event_id)}`;
    const res = await fetch(`${GOOGLE_CALENDAR_API}/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new Error(`Google Calendar API ${res.status}: ${text}`);
    }
    return { message: "Evento eliminado", event_id: input.event_id };
  },

  calendar_reschedule_event: async (
    input: { event_id: string; new_start: string; duration_minutes?: number; timezone?: string }, // timezone reserved for future all-day / local parsing
    ctx: ToolContext
  ) => {
    const token = await getGoogleCalendarAccessToken(ctx.db, ctx.userId);
    if (!token) throw new Error("Google Calendar no conectado");
    const evPath = `calendars/primary/events/${encodeURIComponent(input.event_id)}`;
    const existing = (await calFetch(token, evPath)) as Record<string, unknown>;
    const startMsExisting = parseEventInstant(existing, "start");
    const endMsExisting = parseEventInstant(existing, "end");
    if (Number.isNaN(startMsExisting) || Number.isNaN(endMsExisting)) {
      throw new Error("No se pudo interpretar el evento existente (¿evento de día completo?)");
    }
    const durMs =
      input.duration_minutes != null
        ? input.duration_minutes * 60 * 1000
        : endMsExisting - startMsExisting;
    const newStartMs = Date.parse(input.new_start);
    if (Number.isNaN(newStartMs)) {
      throw new Error("new_start inválido; usa ISO 8601 con offset o Z");
    }
    const newEndMs = newStartMs + durMs;
    const updated = (await calFetch(token, evPath, {
      method: "PATCH",
      body: JSON.stringify({
        start: { dateTime: new Date(newStartMs).toISOString() },
        end: { dateTime: new Date(newEndMs).toISOString() },
      }),
    })) as Record<string, unknown>;
    return {
      message: "Evento reagendado",
      event_id: updated.id,
      start: updated.start,
      end: updated.end,
      html_link: updated.htmlLink,
    };
  },
};

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  for (const def of TOOL_CATALOG) {
    if (!isToolAvailable(def.id, ctx)) continue;

    const schema = TOOL_SCHEMAS[def.id as keyof typeof TOOL_SCHEMAS];
    const handler = TOOL_HANDLERS[def.id];
    if (!schema || !handler) continue;

    const trackedHandler = withTracking(def.id, handler, ctx);

    tools.push(
      tool(trackedHandler, {
        name: def.name,
        description: def.description,
        schema: schema as z.ZodTypeAny,
      })
    );
  }

  return tools;
}
