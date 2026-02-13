import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Config, ModelConfig, ToolCall, ToolResult } from "../types.js";
import { logger } from "../utils/logger.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  model: string;
  usage?: { input: number; output: number };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── Provider Client ───────────────────────────────────────────────────────────

export class LLMClient {
  private configs: Map<string, ModelConfig> = new Map();
  private defaultModel: string;

  constructor(config: Config) {
    for (const m of config.models) {
      this.configs.set(m.model, m);
      // Also register by provider/model format
      this.configs.set(`${m.provider}/${m.model}`, m);
    }
    this.defaultModel = config.defaultModel;
  }

  private resolveConfig(model?: string): ModelConfig {
    const key = model ?? this.defaultModel;
    // Try exact match first
    if (this.configs.has(key)) return this.configs.get(key)!;
    // Try matching by model name only
    for (const [, cfg] of this.configs) {
      if (cfg.model === key || `${cfg.provider}/${cfg.model}` === key) return cfg;
    }
    // Fallback to first available
    const first = this.configs.values().next().value;
    if (!first) throw new Error("No AI models configured");
    logger.warn(`[LLM] Model "${key}" not found, using ${first.model}`);
    return first;
  }

  async chat(
    messages: ChatMessage[],
    options?: {
      model?: string;
      tools?: ToolDefinition[];
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      retries?: number;
    }
  ): Promise<LLMResponse> {
    const cfg = this.resolveConfig(options?.model);
    const maxRetries = options?.retries ?? 2;
    let lastError: Error | null = null;

    // Retry logic with exponential backoff
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        switch (cfg.provider) {
          case "anthropic":
            return await this.chatAnthropic(cfg, messages, options);
          case "openai":
          case "openrouter":
            return await this.chatOpenAI(cfg, messages, options);
          case "google":
            return await this.chatGoogle(cfg, messages, options);
          default:
            throw new Error(`Unknown provider: ${(cfg as ModelConfig).provider}`);
        }
      } catch (err) {
        lastError = err as Error;
        logger.error(`[LLM] ${cfg.provider} error (attempt ${attempt + 1}/${maxRetries + 1}):`, err);
        
        // Don't retry on certain errors (auth, invalid request, etc.)
        const errorMessage = (err as Error).message.toLowerCase();
        if (
          errorMessage.includes("api key") ||
          errorMessage.includes("unauthorized") ||
          errorMessage.includes("invalid") ||
          errorMessage.includes("model not found")
        ) {
          logger.error(`[LLM] Non-retryable error, failing immediately`);
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 5000);
          logger.info(`[LLM] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    // All retries failed — try fallback model if available
    if (this.configs.size > 1 && options?.model !== this.defaultModel) {
      logger.warn(`[LLM] All retries failed for ${cfg.model}, trying fallback model ${this.defaultModel}`);
      try {
        return await this.chat(messages, { ...options, model: this.defaultModel, retries: 0 });
      } catch (fallbackErr) {
        logger.error(`[LLM] Fallback model also failed:`, fallbackErr);
      }
    }

    throw lastError ?? new Error("LLM request failed after all retries");
  }

  // ── Anthropic ──────────────────────────────────────────────────────────────

  private async chatAnthropic(
    cfg: ModelConfig,
    messages: ChatMessage[],
    options?: Parameters<LLMClient["chat"]>[1]
  ): Promise<LLMResponse> {
    const client = new Anthropic({ apiKey: cfg.apiKey });

    const anthropicMessages: Anthropic.MessageParam[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const systemMsg = options?.systemPrompt ?? messages.find((m) => m.role === "system")?.content;

    const tools: Anthropic.Tool[] | undefined = options?.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool["input_schema"],
    }));

    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: options?.maxTokens ?? 4096,
      system: systemMsg,
      messages: anthropicMessages,
      tools,
    });

    const textContent = resp.content.find((b: Anthropic.ContentBlock) => b.type === "text");
    const toolUseBlocks = resp.content.filter((b: Anthropic.ContentBlock) => b.type === "tool_use");

    const toolCalls: ToolCall[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((b: Anthropic.ContentBlock) => {
            const tu = b as Anthropic.ToolUseBlock;
            return {
              id: tu.id,
              name: tu.name,
              arguments: tu.input as Record<string, unknown>,
            };
          })
        : undefined;

    return {
      content: textContent?.type === "text" ? textContent.text : "",
      toolCalls,
      model: cfg.model,
      usage: resp.usage
        ? { input: resp.usage.input_tokens, output: resp.usage.output_tokens }
        : undefined,
    };
  }

  // ── OpenAI / OpenRouter ────────────────────────────────────────────────────

  private async chatOpenAI(
    cfg: ModelConfig,
    messages: ChatMessage[],
    options?: Parameters<LLMClient["chat"]>[1]
  ): Promise<LLMResponse> {
    const client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseUrl,
    });

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];
    if (options?.systemPrompt) {
      openaiMessages.push({ role: "system", content: options.systemPrompt });
    }
    for (const m of messages) {
      openaiMessages.push({ role: m.role, content: m.content });
    }

    const tools: OpenAI.ChatCompletionTool[] | undefined = options?.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const resp = await client.chat.completions.create({
      model: cfg.model,
      messages: openaiMessages,
      tools,
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0.7,
    });

    const choice = resp.choices[0];
    if (!choice) throw new Error("No completion choices returned");

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc: OpenAI.ChatCompletionMessageToolCall) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: choice.message.content ?? "",
      toolCalls,
      model: cfg.model,
      usage: resp.usage
        ? { input: resp.usage.prompt_tokens, output: resp.usage.completion_tokens }
        : undefined,
    };
  }

  // ── Google Gemini ─────────────────────────────────────────────────────────

  private async chatGoogle(
    cfg: ModelConfig,
    messages: ChatMessage[],
    options?: Parameters<LLMClient["chat"]>[1]
  ): Promise<LLMResponse> {
    // Dynamic import to avoid issues if not installed
    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(cfg.apiKey);
    const model = genAI.getGenerativeModel({ model: cfg.model });

    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) throw new Error("No messages provided");

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(lastMessage.content);
    const response = await result.response;

    return {
      content: response.text(),
      model: cfg.model,
    };
  }
}
