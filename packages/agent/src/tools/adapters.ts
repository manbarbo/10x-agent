import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG, toolRequiresConfirmation } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";

const GITHUB_API = "https://api.github.com";
const GITHUB_UA = "10x-builders-agent/1.0";

export interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

function isToolAvailable(
  toolId: string,
  ctx: ToolContext
): boolean {
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

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description: "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_repos", input, false
          );
          try {
            const result = await executeGitHubTool("github_list_repos", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(ctx.db, record.id, "failed", errResult);
            return JSON.stringify(errResult);
          }
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_list_issues", input, false
          );
          try {
            const result = await executeGitHubTool("github_list_issues", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(ctx.db, record.id, "failed", errResult);
            return JSON.stringify(errResult);
          }
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z.enum(["open", "closed", "all"]).optional().default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_issue");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_issue", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              tool_name: "github_create_issue",
              message: `Se requiere confirmación para crear el issue "${input.title}" en ${input.owner}/${input.repo}.`,
              args: input,
            });
          }
          try {
            const result = await executeGitHubTool("github_create_issue", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(ctx.db, record.id, "failed", errResult);
            return JSON.stringify(errResult);
          }
        },
        {
          name: "github_create_issue",
          description: "Creates a new issue in a GitHub repository. Requires confirmation.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const needsConfirm = toolRequiresConfirmation("github_create_repo");
          const record = await createToolCall(
            ctx.db, ctx.sessionId, "github_create_repo", input, needsConfirm
          );
          if (needsConfirm) {
            return JSON.stringify({
              pending_confirmation: true,
              tool_call_id: record.id,
              tool_name: "github_create_repo",
              message: `Se requiere confirmación para crear el repositorio "${input.name}"${input.isPrivate ? " (privado)" : ""}.`,
              args: input,
            });
          }
          try {
            const result = await executeGitHubTool("github_create_repo", input, ctx.githubToken!);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const errResult = { error: String(err) };
            await updateToolCallStatus(ctx.db, record.id, "failed", errResult);
            return JSON.stringify(errResult);
          }
        },
        {
          name: "github_create_repo",
          description: "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            isPrivate: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  return tools;
}
