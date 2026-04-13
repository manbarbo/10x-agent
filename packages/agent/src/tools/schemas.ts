import { z } from "zod";

export const TOOL_SCHEMAS = {
  get_user_preferences: z.object({}),
  list_enabled_tools: z.object({}),
  github_list_repos: z.object({
    per_page: z.number().max(30).optional().default(10),
  }),
  github_list_issues: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional().default("open"),
  }),
  github_create_issue: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional().default(""),
  }),
  github_create_repo: z.object({
    name: z.string(),
    description: z.string().optional().default(""),
    isPrivate: z.boolean().optional().default(false),
  }),
  calendar_list_events: z.object({
    date: z.string().describe("Calendar date YYYY-MM-DD"),
    timezone: z.string().optional().describe("IANA timezone (e.g. America/Bogota). Defaults to user profile timezone or UTC."),
  }),
  calendar_create_event: z.object({
    title: z.string(),
    start: z
      .string()
      .describe("ISO 8601 start datetime (include timezone offset or Z, e.g. 2026-04-12T15:00:00-05:00)"),
    duration_minutes: z.number().int().positive().max(24 * 60),
    timezone: z.string().optional().describe("Unused if start includes offset; reserved for future use"),
    description: z.string().optional().default(""),
    attendees: z.array(z.string().email()).optional().default([]),
  }),
  calendar_cancel_event: z.object({
    event_id: z.string().min(1),
  }),
  calendar_reschedule_event: z.object({
    event_id: z.string().min(1),
    new_start: z
      .string()
      .describe("ISO 8601 new start datetime (include timezone offset or Z)"),
    duration_minutes: z.number().int().positive().max(24 * 60).optional(),
    timezone: z.string().optional(),
  }),
  read_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory."),
    offset: z.number().int().min(1).optional().describe("1-based line number to start reading from. Defaults to 1."),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to return starting at offset."),
  }),
  write_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory. The file must NOT exist yet."),
    content: z.string().max(500_000).describe("Full UTF-8 content to write into the new file."),
  }),
  edit_file: z.object({
    path: z.string().describe("Absolute path or path relative to the server process working directory. The file must already exist."),
    old_string: z.string().describe("Literal substring to find. Must appear exactly once in the file."),
    new_string: z.string().describe("Literal string that replaces the single occurrence of old_string."),
  }),
  bash: z.object({
    terminal: z.string().describe("Terminal identifier for correlation and logging"),
    prompt: z.string().max(4096).describe("Bash command to execute"),
  }),
  schedule_task: z
    .object({
      prompt: z.string().min(1).describe("The instruction the agent will run when the task fires."),
      schedule_type: z
        .enum(["one_time", "recurring"])
        .describe("Whether this is a single execution or a recurring one."),
      run_at: z
        .string()
        .optional()
        .describe("ISO 8601 datetime for one_time tasks (e.g. '2026-04-10T09:00:00Z')."),
      cron_expr: z
        .string()
        .optional()
        .describe(
          "5-field cron expression for recurring tasks (e.g. '0 9 * * 1' = every Monday 9 AM)."
        ),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone name (e.g. 'America/Bogota'). Defaults to user timezone."),
    })
    .refine(
      (data) => {
        if (data.schedule_type === "one_time") return !!data.run_at;
        if (data.schedule_type === "recurring") return !!data.cron_expr;
        return false;
      },
      {
        message:
          "one_time tasks require run_at; recurring tasks require cron_expr.",
      }
    ),
} as const;

export type ToolSchemas = typeof TOOL_SCHEMAS;
export type ToolId = keyof ToolSchemas;
