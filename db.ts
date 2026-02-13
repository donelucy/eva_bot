import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type {
  Message, Session, MemoryEntry, CronJob,
  SwarmTask, SecurityEvent, PairingCode
} from "../types.js";
import { logger } from "../utils/logger.js";

let db: Database.Database;

export function initDb(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      group_id TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      timestamp INTEGER NOT NULL,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      group_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, key)
    );

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      message TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_channel TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT,
      last_run INTEGER,
      next_run INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id TEXT PRIMARY KEY,
      orchestrator_id TEXT NOT NULL,
      agents TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      results TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      details TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS allowlist (
      user_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);
    CREATE INDEX IF NOT EXISTS idx_security_user ON security_events(user_id);
  `);
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export function upsertSession(session: Session): void {
  db.prepare(`
    INSERT INTO sessions (id, user_id, channel, group_id, created_at, last_active_at, model, system_prompt)
    VALUES (@id, @userId, @channel, @groupId, @createdAt, @lastActiveAt, @model, @systemPrompt)
    ON CONFLICT(id) DO UPDATE SET
      last_active_at = excluded.last_active_at,
      model = excluded.model,
      system_prompt = excluded.system_prompt
  `).run({
    id: session.id,
    userId: session.userId,
    channel: session.channel,
    groupId: session.groupId ?? null,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    model: session.model,
    systemPrompt: session.systemPrompt ?? null,
  });
}

export function getSession(id: string): Session | undefined {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToSession(row);
}

export function getSessionByUser(userId: string, channel: string): Session | undefined {
  const row = db
    .prepare("SELECT * FROM sessions WHERE user_id = ? AND channel = ? AND group_id IS NULL ORDER BY last_active_at DESC LIMIT 1")
    .get(userId, channel) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToSession(row);
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row["id"] as string,
    userId: row["user_id"] as string,
    channel: row["channel"] as Session["channel"],
    groupId: row["group_id"] as string | undefined,
    createdAt: row["created_at"] as number,
    lastActiveAt: row["last_active_at"] as number,
    model: row["model"] as string,
    systemPrompt: row["system_prompt"] as string | undefined,
  };
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function saveMessage(msg: Message): void {
  db.prepare(`
    INSERT OR REPLACE INTO messages (id, session_id, role, content, tool_calls, tool_results, timestamp, channel, user_id, group_id)
    VALUES (@id, @sessionId, @role, @content, @toolCalls, @toolResults, @timestamp, @channel, @userId, @groupId)
  `).run({
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    toolResults: msg.toolResults ? JSON.stringify(msg.toolResults) : null,
    timestamp: msg.timestamp,
    channel: msg.channel,
    userId: msg.userId,
    groupId: msg.groupId ?? null,
  });
}

export function getSessionMessages(sessionId: string, limit = 50): Message[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?")
    .all(sessionId, limit) as Record<string, unknown>[];
  return rows.reverse().map(rowToMessage);
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row["id"] as string,
    sessionId: row["session_id"] as string,
    role: row["role"] as Message["role"],
    content: row["content"] as string,
    toolCalls: row["tool_calls"] ? JSON.parse(row["tool_calls"] as string) : undefined,
    toolResults: row["tool_results"] ? JSON.parse(row["tool_results"] as string) : undefined,
    timestamp: row["timestamp"] as number,
    channel: row["channel"] as Message["channel"],
    userId: row["user_id"] as string,
    groupId: row["group_id"] as string | undefined,
  };
}

// ── Memory ────────────────────────────────────────────────────────────────────

export function setMemory(userId: string, key: string, value: string): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO memory (id, user_id, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(`${userId}:${key}`, userId, key, value, now, now);
}

export function getMemory(userId: string, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM memory WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | undefined;
  return row?.value;
}

export function getAllMemory(userId: string): MemoryEntry[] {
  const rows = db.prepare("SELECT * FROM memory WHERE user_id = ?").all(userId) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r["id"] as string,
    userId: r["user_id"] as string,
    key: r["key"] as string,
    value: r["value"] as string,
    createdAt: r["created_at"] as number,
    updatedAt: r["updated_at"] as number,
  }));
}

export function deleteMemory(userId: string, key: string): void {
  db.prepare("DELETE FROM memory WHERE user_id = ? AND key = ?").run(userId, key);
}

// ── Cron Jobs ─────────────────────────────────────────────────────────────────

export function saveCronJob(job: CronJob): void {
  db.prepare(`
    INSERT OR REPLACE INTO cron_jobs (id, name, schedule, message, target_user_id, target_channel, enabled, timezone, last_run, next_run, created_at)
    VALUES (@id, @name, @schedule, @message, @targetUserId, @targetChannel, @enabled, @timezone, @lastRun, @nextRun, @createdAt)
  `).run({
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    message: job.message,
    targetUserId: job.targetUserId,
    targetChannel: job.targetChannel,
    enabled: job.enabled ? 1 : 0,
    timezone: job.timezone ?? null,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    createdAt: job.createdAt,
  });
}

export function getCronJobs(userId?: string): CronJob[] {
  const rows = userId
    ? db.prepare("SELECT * FROM cron_jobs WHERE target_user_id = ?").all(userId) as Record<string, unknown>[]
    : db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as Record<string, unknown>[];
  return rows.map(rowToCronJob);
}

export function deleteCronJob(id: string): void {
  db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
}

function rowToCronJob(row: Record<string, unknown>): CronJob {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    schedule: row["schedule"] as string,
    message: row["message"] as string,
    targetUserId: row["target_user_id"] as string,
    targetChannel: row["target_channel"] as CronJob["targetChannel"],
    enabled: (row["enabled"] as number) === 1,
    timezone: row["timezone"] as string | undefined,
    lastRun: row["last_run"] as number | undefined,
    nextRun: row["next_run"] as number | undefined,
    createdAt: row["created_at"] as number,
  };
}

// ── Security ──────────────────────────────────────────────────────────────────

export function logSecurityEvent(event: SecurityEvent): void {
  db.prepare(`
    INSERT INTO security_events (id, type, user_id, channel, details, timestamp)
    VALUES (@id, @type, @userId, @channel, @details, @timestamp)
  `).run(event);
}

export function isAllowlisted(userId: string, channel: string): boolean {
  const row = db.prepare("SELECT 1 FROM allowlist WHERE user_id = ? AND channel = ?").get(userId, channel);
  return !!row;
}

export function addToAllowlist(userId: string, channel: string): void {
  db.prepare("INSERT OR IGNORE INTO allowlist (user_id, channel, added_at) VALUES (?, ?, ?)").run(userId, channel, Date.now());
}

export function savePairingCode(code: PairingCode): void {
  db.prepare(`
    INSERT INTO pairing_codes (code, user_id, channel, expires_at, used)
    VALUES (@code, @userId, @channel, @expiresAt, 0)
  `).run({ code: code.code, userId: code.userId, channel: code.channel, expiresAt: code.expiresAt });
}

export function getPairingCode(code: string): PairingCode | undefined {
  const row = db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND used = 0 AND expires_at > ?").get(code, Date.now()) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    code: row["code"] as string,
    userId: row["user_id"] as string,
    channel: row["channel"] as string,
    expiresAt: row["expires_at"] as number,
    used: false,
  };
}

export function consumePairingCode(code: string): boolean {
  const result = db.prepare("UPDATE pairing_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at > ?").run(code, Date.now());
  return result.changes > 0;
}

// ── Database Maintenance ──────────────────────────────────────────────────────

/**
 * Optimize database performance by running VACUUM and ANALYZE
 * Should be called periodically (e.g., daily) to maintain performance
 */
export function optimizeDatabase(): void {
  try {
    // VACUUM reclaims space and defragments the database
    db.exec("VACUUM");
    // ANALYZE updates query optimizer statistics
    db.exec("ANALYZE");
    logger.info("[DB] Database optimization completed");
  } catch (err) {
    logger.error("[DB] Optimization failed:", err);
  }
}

/**
 * Clean up old data to prevent database bloat
 */
export function cleanupOldData(options?: {
  messageRetentionDays?: number;
  securityEventRetentionDays?: number;
  expiredPairingCodes?: boolean;
}): void {
  const {
    messageRetentionDays = 90,
    securityEventRetentionDays = 30,
    expiredPairingCodes = true,
  } = options ?? {};

  const now = Date.now();
  const messageThreshold = now - messageRetentionDays * 24 * 60 * 60 * 1000;
  const securityThreshold = now - securityEventRetentionDays * 24 * 60 * 60 * 1000;

  try {
    // Clean up old messages (keep most recent ones per session)
    const msgResult = db.prepare(`
      DELETE FROM messages 
      WHERE timestamp < ? 
      AND id NOT IN (
        SELECT id FROM messages 
        WHERE session_id IN (SELECT DISTINCT session_id FROM messages)
        ORDER BY timestamp DESC 
        LIMIT 1000
      )
    `).run(messageThreshold);

    // Clean up old security events
    const secResult = db.prepare("DELETE FROM security_events WHERE timestamp < ?").run(securityThreshold);

    // Clean up expired and used pairing codes
    let pairingResult = { changes: 0 };
    if (expiredPairingCodes) {
      pairingResult = db.prepare("DELETE FROM pairing_codes WHERE used = 1 OR expires_at < ?").run(now);
    }

    logger.info(`[DB] Cleanup: ${msgResult.changes} old messages, ${secResult.changes} security events, ${pairingResult.changes} pairing codes removed`);
  } catch (err) {
    logger.error("[DB] Cleanup failed:", err);
  }
}

/**
 * Get database statistics
 */
export function getDatabaseStats(): {
  size: number;
  sessions: number;
  messages: number;
  memories: number;
  cronJobs: number;
} {
  const size = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
  const sessions = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
  const messages = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
  const memories = db.prepare("SELECT COUNT(*) as count FROM memory").get() as { count: number };
  const cronJobs = db.prepare("SELECT COUNT(*) as count FROM cron_jobs").get() as { count: number };

  return {
    size: size.size,
    sessions: sessions.count,
    messages: messages.count,
    memories: memories.count,
    cronJobs: cronJobs.count,
  };
}
