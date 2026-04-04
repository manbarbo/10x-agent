import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "@agents/types";
import { TOOL_SCHEMAS } from "./schemas";
import { withTracking } from "./withTracking";

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

const TOOL_HANDLERS: ToolHandlers = {
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
