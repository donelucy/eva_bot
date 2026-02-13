import { nanoid } from "nanoid";
import type {
  Config, Message, Session, ToolContext, IncomingMessage, CronJob, MemoryEntry,
} from "../types.js";
import { LLMClient, type ChatMessage, type ToolDefinition } from "./llm.js";
import type { Tool } from "../types.js";
import {
  upsertSession, getSession, getSessionByUser,
  saveMessage, getSessionMessages, getAllMemory,
} from "../memory/db.js";
import { logger } from "../utils/logger.js";

const SYSTEM_PROMPT = `You are a helpful personal AI assistant. You have access to tools for:
- Web search (use for current information)
- Memory (both simple key-value and Obsidian-style markdown notes)
- Bash (run commands safely in a sandboxed container)
- Scheduling (create/manage recurring tasks with cron)
- Agent swarms (delegate complex tasks to specialized sub-agents)
- Obsidian vault (save structured knowledge as markdown notes with wikilinks)

Guidelines:
- Be concise by default — this is a chat interface
- Use tools proactively when they would help
- For simple facts: use memory_remember
- For structured knowledge: use obsidian_save (supports [[wikilinks]], tags, organized folders)
- When asked to do something regularly, use cron_add
- Always use the sandbox bash tool for running code — never suggest the user run things themselves unless necessary

Memory Strategy:
- Quick facts/preferences → memory_remember
- Structured notes, research, conversations → obsidian_save
- Related topics → use [[wikilinks]] to connect notes

Current time: {{CURRENT_TIME}}
User memories:
{{MEMORIES}}`;

// Estimate tokens (rough approximation: 1 token ≈ 4 characters)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateTokens(msg.content), 0);
}

// ── Session Management ────────────────────────────────────────────────────────

function getOrCreateSession(
  userId: string,
  channel: Message["channel"],
  groupId: string | undefined,
  config: Config
): Session {
  // For group messages use group+user as session key, for DMs just user
  const existing = getSessionByUser(userId, channel);
  if (existing && !groupId) return existing;

  const session: Session = {
    id: nanoid(),
    userId,
    channel,
    groupId,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    model: config.defaultModel,
  };
  upsertSession(session);
  return session;
}

// ── Agent Loop ────────────────────────────────────────────────────────────────

export class AgentLoop {
  private llm: LLMClient;
  private tools: Map<string, Tool>;

  constructor(
    private config: Config,
    tools: Map<string, Tool>
  ) {
    this.llm = new LLMClient(config);
    this.tools = tools;
  }

  /**
   * Process an incoming message and return the response text
   */
  async process(
    incoming: IncomingMessage,
    sessionId?: string
  ): Promise<string> {
    const session = sessionId
      ? (getSession(sessionId) ?? getOrCreateSession(incoming.from, incoming.channel, incoming.groupId, this.config))
      : getOrCreateSession(incoming.from, incoming.channel, incoming.groupId, this.config);

    // Update last active
    session.lastActiveAt = Date.now();
    upsertSession(session);

    // Save user message
    const userMsg: Message = {
      id: nanoid(),
      sessionId: session.id,
      role: "user",
      content: incoming.text,
      timestamp: incoming.timestamp,
      channel: incoming.channel,
      userId: incoming.from,
      groupId: incoming.groupId,
    };
    saveMessage(userMsg);

    // Build context
    const history = getSessionMessages(session.id, 40);
    const memories = getAllMemory(incoming.from);
    const memorySummary = memories.length > 0
      ? memories.map((m: MemoryEntry) => `  ${m.key}: ${m.value}`).join("\n")
      : "  (none yet)";

    const systemPrompt = SYSTEM_PROMPT
      .replace("{{CURRENT_TIME}}", new Date().toISOString())
      .replace("{{MEMORIES}}", memorySummary);

    // Convert history to chat messages
    const chatMessages: ChatMessage[] = history
      .filter((m: Message) => m.role === "user" || m.role === "assistant")
      .map((m: Message) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Ensure last message is the current user message
    if (chatMessages[chatMessages.length - 1]?.content !== incoming.text) {
      chatMessages.push({ role: "user", content: incoming.text });
    }

    // Memory overflow protection: keep only messages that fit in token budget
    const MAX_HISTORY_TOKENS = 8000; // Reserve tokens for response
    const systemTokens = estimateTokens(systemPrompt);
    let historyTokens = estimateMessagesTokens(chatMessages);

    if (systemTokens + historyTokens > MAX_HISTORY_TOKENS) {
      logger.warn(`[Agent] History too long (${historyTokens} tokens), truncating...`);
      // Keep most recent messages, remove from start
      while (chatMessages.length > 2 && systemTokens + historyTokens > MAX_HISTORY_TOKENS) {
        const removed = chatMessages.shift();
        if (removed) {
          historyTokens -= estimateTokens(removed.content);
        }
      }
      logger.info(`[Agent] Kept ${chatMessages.length} messages (${historyTokens} tokens)`);
    }

    // Build tool definitions
    const toolDefs: ToolDefinition[] = Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: (t.parameters as { properties?: Record<string, unknown> }).properties ?? {},
        required: (t.parameters as { required?: string[] }).required,
      },
    }));

    // Tool context
    const toolCtx: ToolContext = {
      sessionId: session.id,
      userId: incoming.from,
      channel: incoming.channel,
      sandboxed: this.config.security.container.runtime !== "none",
      containerWorkspace: `${this.config.security.container.sandboxWorkspace}/${session.id}`,
    };

    // Agentic loop — keep running until no more tool calls
    let finalResponse = "";
    let iterations = 0;
    const MAX_ITERATIONS = 10;

    const currentMessages = [...chatMessages];

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      const response = await this.llm.chat(currentMessages, {
        model: session.model,
        systemPrompt,
        tools: toolDefs,
        maxTokens: 4096,
      });

      // If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        finalResponse = response.content;
        break;
      }

      // Add assistant message with tool calls
      currentMessages.push({
        role: "assistant",
        content: response.content || "(using tools...)",
      });

      // Execute tools
      const toolResultParts: string[] = [];

      for (const tc of response.toolCalls) {
        logger.debug(`[Agent] Calling tool: ${tc.name}`, tc.arguments);
        const tool = this.tools.get(tc.name);

        if (!tool) {
          toolResultParts.push(`Tool "${tc.name}" not found.`);
          continue;
        }

        try {
          // Add timeout protection for all tool executions
          const TOOL_TIMEOUT = 120000; // 120 seconds
          const result = await Promise.race([
            tool.execute(tc.arguments, toolCtx),
            new Promise<string>((_, reject) =>
              setTimeout(() => reject(new Error("Tool execution timeout")), TOOL_TIMEOUT)
            ),
          ]);
          toolResultParts.push(`[${tc.name} result]: ${result}`);
        } catch (err) {
          const errMsg = (err as Error).message;
          if (errMsg === "Tool execution timeout") {
            toolResultParts.push(`[${tc.name} error]: Tool timed out after 120 seconds`);
            logger.error(`[Agent] Tool ${tc.name} timed out`);
          } else {
            toolResultParts.push(`[${tc.name} error]: ${errMsg}`);
            logger.error(`[Agent] Tool ${tc.name} failed:`, err);
          }
        }
      }

      // Add tool results as user message for next iteration
      currentMessages.push({
        role: "user",
        content: toolResultParts.join("\n\n"),
      });
    }

    if (!finalResponse) {
      finalResponse = "(I ran into an issue processing your request. Please try again.)";
    }

    // Save assistant response
    const assistantMsg: Message = {
      id: nanoid(),
      sessionId: session.id,
      role: "assistant",
      content: finalResponse,
      timestamp: Date.now(),
      channel: incoming.channel,
      userId: incoming.from,
      groupId: incoming.groupId,
    };
    saveMessage(assistantMsg);

    return finalResponse;
  }

  /**
   * Process a scheduled cron job — runs the job's message and returns response
   */
  async processCron(job: CronJob): Promise<string> {
    const fakeIncoming: IncomingMessage = {
      id: nanoid(),
      from: job.targetUserId,
      channel: job.targetChannel,
      text: `[Scheduled task: ${job.name}]\n${job.message}`,
      timestamp: Date.now(),
    };
    return this.process(fakeIncoming);
  }
}
