import axios from "axios";
import type { Tool, ToolContext, Config, CronJob } from "../types.js";
import {
  setMemory, getMemory, getAllMemory, deleteMemory,
  saveCronJob, getCronJobs, deleteCronJob,
} from "../memory/db.js";
import { ContainerRunner } from "../security/gate.js";
import { nanoid } from "nanoid";
import { logger } from "../utils/logger.js";

// ── Web Search (Brave) ────────────────────────────────────────────────────────

function makeWebSearchTool(apiKey?: string): Tool {
  return {
    name: "web_search",
    description: "Search the web for current information. Use for news, facts, prices, anything that changes.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        count: { type: "number", description: "Number of results (1-10, default 5)" },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>) {
      const query = args["query"] as string;
      const count = Math.min((args["count"] as number) ?? 5, 10);

      if (!apiKey) {
        return "Web search is not configured. Set BRAVE_SEARCH_API_KEY in .env.";
      }

      try {
        // Enforce timeout for web requests
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const resp = await axios.get("https://api.search.brave.com/res/v1/web/search", {
          headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
          params: { q: query, count },
          timeout: 10000,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const results = resp.data.web?.results ?? [];
        if (results.length === 0) return "No results found.";

        return results
          .slice(0, count)
          .map((r: { title: string; url: string; description?: string }, i: number) =>
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ""}`
          )
          .join("\n\n");
      } catch (err) {
        if ((err as { code?: string }).code === "ECONNABORTED" || (err as Error).name === "AbortError") {
          return "Search timed out after 10 seconds. Please try again.";
        }
        logger.error("[Tool:web_search]", err);
        return `Search failed: ${(err as Error).message}`;
      }
    },
  };
}

// ── Memory Tools ──────────────────────────────────────────────────────────────

const memoryRememberTool: Tool = {
  name: "memory_remember",
  description: "Save something to long-term memory. Use to remember facts about the user, preferences, or important context.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Short key to identify this memory (e.g. 'user_name', 'preferred_language')" },
      value: { type: "string", description: "The information to remember" },
    },
    required: ["key", "value"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    setMemory(ctx.userId, args["key"] as string, args["value"] as string);
    return `Remembered: ${args["key"]} = ${args["value"]}`;
  },
};

const memoryRecallTool: Tool = {
  name: "memory_recall",
  description: "Recall something from long-term memory.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "The key to look up" },
    },
    required: ["key"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const val = getMemory(ctx.userId, args["key"] as string);
    return val ? `${args["key"]}: ${val}` : `No memory found for key: ${args["key"]}`;
  },
};

const memoryListTool: Tool = {
  name: "memory_list",
  description: "List all stored memories for this user.",
  parameters: { type: "object", properties: {} },
  async execute(_: Record<string, unknown>, ctx: ToolContext) {
    const entries = getAllMemory(ctx.userId);
    if (entries.length === 0) return "No memories stored yet.";
    return entries.map((e: { key: string; value: string }) => `• ${e.key}: ${e.value}`).join("\n");
  },
};

const memoryForgetTool: Tool = {
  name: "memory_forget",
  description: "Delete a memory by key.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "The key to delete" },
    },
    required: ["key"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    deleteMemory(ctx.userId, args["key"] as string);
    return `Forgot: ${args["key"]}`;
  },
};

// ── Bash Tool (sandboxed) ─────────────────────────────────────────────────────

function makeBashTool(runner: ContainerRunner): Tool {
  return {
    name: "bash",
    description: "Run a bash command. Executes inside a Docker sandbox with no network access and limited filesystem. Safe to use.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
        timeout: { type: "number", description: "Timeout in seconds (default 30)" },
      },
      required: ["command"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
      const command = args["command"] as string;
      const timeoutMs = ((args["timeout"] as number) ?? 30) * 1000;

      const workspace = ctx.containerWorkspace ?? `/tmp/mybot-${ctx.sessionId}`;
      const result = await runner.runInSandbox(command, workspace, timeoutMs);

      let output = "";
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += `\nSTDERR: ${result.stderr}`;
      if (result.exitCode !== 0) output += `\nExit code: ${result.exitCode}`;

      return output.trim() || "(no output)";
    },
  };
}

// ── Cron Tools ────────────────────────────────────────────────────────────────

function makeCronTools(
  sendMessage: (userId: string, channel: string, text: string) => Promise<void>
): Tool[] {
  const cronAddTool: Tool = {
    name: "cron_add",
    description: "Add a scheduled task that runs on a cron schedule.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable name for this task" },
        schedule: { type: "string", description: "Cron expression (e.g. '0 9 * * 1-5' for weekdays at 9am)" },
        message: { type: "string", description: "The message/prompt to send to the AI when this job runs" },
        timezone: { type: "string", description: "Optional IANA timezone (e.g. 'America/New_York', 'Europe/London'). Defaults to UTC." },
      },
      required: ["name", "schedule", "message"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext) {
      const job = {
        id: nanoid(),
        name: args["name"] as string,
        schedule: args["schedule"] as string,
        message: args["message"] as string,
        timezone: args["timezone"] as string | undefined,
        targetUserId: ctx.userId,
        targetChannel: ctx.channel as "whatsapp" | "telegram",
        enabled: true,
        createdAt: Date.now(),
      };
      saveCronJob(job);
      const tzInfo = job.timezone ? ` [${job.timezone}]` : " [UTC]";
      return `Scheduled task "${job.name}" created (ID: ${job.id})\nSchedule: ${job.schedule}${tzInfo}\nMessage: ${job.message}`;
    },
  };

  const cronListTool: Tool = {
    name: "cron_list",
    description: "List all scheduled tasks for this user.",
    parameters: { type: "object", properties: {} },
    async execute(_: Record<string, unknown>, ctx: ToolContext) {
      const jobs = getCronJobs(ctx.userId);
      if (jobs.length === 0) return "No scheduled tasks.";
      return jobs
        .map((j: CronJob) => {
          const tz = j.timezone ? ` [${j.timezone}]` : " [UTC]";
          return `• [${j.id.slice(0, 8)}] ${j.name}\n  Schedule: ${j.schedule}${tz}\n  Message: ${j.message}\n  Enabled: ${j.enabled}`;
        })
        .join("\n\n");
    },
  };

  const cronRemoveTool: Tool = {
    name: "cron_remove",
    description: "Remove a scheduled task by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task ID (from cron_list)" },
      },
      required: ["id"],
    },
    async execute(args: Record<string, unknown>) {
      deleteCronJob(args["id"] as string);
      return `Task ${args["id"]} removed.`;
    },
  };

  return [cronAddTool, cronListTool, cronRemoveTool];
}

// ── Tool Registry ─────────────────────────────────────────────────────────────

export function buildToolRegistry(
  config: Config,
  sendMessage: (userId: string, channel: string, text: string) => Promise<void>
): Map<string, Tool> {
  const runner = new ContainerRunner(config);
  const registry = new Map<string, Tool>();

  const allTools: Tool[] = [
    makeWebSearchTool(config.features.braveApiKey),
    memoryRememberTool,
    memoryRecallTool,
    memoryListTool,
    memoryForgetTool,
    makeBashTool(runner),
    ...makeCronTools(sendMessage),
  ];

  for (const tool of allTools) {
    registry.set(tool.name, tool);
  }

  return registry;
}
