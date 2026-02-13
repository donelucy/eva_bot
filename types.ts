// ============================================================
// Core Types — MyBot
// ============================================================

export type Provider = "anthropic" | "openai" | "openrouter" | "google";

export interface ModelConfig {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface Config {
  models: ModelConfig[];
  defaultModel: string;
  channels: {
    telegram?: {
      enabled: boolean;
      token: string;
      allowedUserIds: string[];
    };
    whatsapp?: {
      enabled: boolean;
      allowedNumbers: string[];
    };
  };
  security: {
    dmPolicy: "strict" | "pairing";
    pairingCodeLength: number;
    container: {
      runtime: "docker" | "none";
      image: string;
      memoryLimit: string;
      cpuLimit: string;
      sandboxWorkspace: string;
    };
  };
  features: {
    webSearch: boolean;
    braveApiKey?: string;
  };
  db: {
    path: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
    file?: string;
  };
  gateway: {
    port: number;
    triggerWord: string;
  };
}

export interface Message {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  channel: "whatsapp" | "telegram" | "cli";
  userId: string;
  groupId?: string;
}

export interface Session {
  id: string;
  userId: string;
  channel: "whatsapp" | "telegram" | "cli";
  groupId?: string;
  createdAt: number;
  lastActiveAt: number;
  model: string;
  systemPrompt?: string;
}

export interface MemoryEntry {
  id: string;
  userId: string;
  key: string;
  value: string;
  embedding?: number[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  sessionId: string;
  userId: string;
  channel: string;
  sandboxed: boolean;
  containerWorkspace?: string;
}

export interface IncomingMessage {
  id: string;
  from: string;           // user ID
  fromNumber?: string;    // phone number for WhatsApp
  groupId?: string;       // group ID if in a group
  groupName?: string;
  text: string;
  channel: "whatsapp" | "telegram";
  timestamp: number;
  replyTo?: string;
}

export interface OutgoingMessage {
  to: string;
  groupId?: string;
  text: string;
  channel: "whatsapp" | "telegram";
  replyToId?: string;
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;         // cron expression
  message: string;          // message to send to the agent
  targetUserId: string;
  targetChannel: "whatsapp" | "telegram";
  enabled: boolean;
  timezone?: string;        // IANA timezone (e.g., 'America/New_York', default: UTC)
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

export interface SwarmAgent {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  model: string;
  tools: string[];
}

export interface SwarmTask {
  id: string;
  orchestratorId: string;
  agents: SwarmAgent[];
  objective: string;
  status: "pending" | "running" | "completed" | "failed";
  results: Record<string, string>;
  createdAt: number;
  completedAt?: number;
}

export interface SecurityEvent {
  id: string;
  type: "blocked" | "pairing_attempt" | "pairing_approved" | "allowlist_hit" | "rate_limit";
  userId: string;
  channel: string;
  details: string;
  timestamp: number;
}

export interface PairingCode {
  code: string;
  userId: string;
  channel: string;
  expiresAt: number;
  used: boolean;
}
