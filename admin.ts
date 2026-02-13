import type { Tool, ToolContext, Config } from "../types.js";
import { getDatabaseStats, optimizeDatabase, cleanupOldData } from "../memory/db.js";
import { logger } from "../utils/logger.js";

/**
 * Admin commands - only available to configured admin users
 */
export function makeAdminTools(config: Config, rateLimiter?: { getAll: () => unknown; reset: (userId: string) => void }): Tool[] {
  const adminUserIds = new Set([
    ...(config.channels.telegram?.allowedUserIds ?? []),
    ...(config.channels.whatsapp?.allowedNumbers ?? []),
  ]);

  const isAdmin = (userId: string): boolean => adminUserIds.has(userId);

  const dbStatsTool: Tool = {
    name: "admin_db_stats",
    description: "Get database statistics (admin only). Shows size, number of sessions, messages, memories, etc.",
    parameters: { type: "object", properties: {} },
    async execute(_: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      const stats = getDatabaseStats();
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

      return `📊 **Database Statistics**

**Size:** ${sizeMB} MB
**Sessions:** ${stats.sessions}
**Messages:** ${stats.messages}
**Memories:** ${stats.memories}
**Cron Jobs:** ${stats.cronJobs}`;
    },
  };

  const dbOptimizeTool: Tool = {
    name: "admin_db_optimize",
    description: "Optimize database (VACUUM + ANALYZE) - admin only. Improves performance and reclaims disk space.",
    parameters: { type: "object", properties: {} },
    async execute(_: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      try {
        const beforeStats = getDatabaseStats();
        optimizeDatabase();
        const afterStats = getDatabaseStats();
        const beforeMB = (beforeStats.size / 1024 / 1024).toFixed(2);
        const afterMB = (afterStats.size / 1024 / 1024).toFixed(2);
        const saved = (beforeStats.size - afterStats.size) / 1024 / 1024;

        return `✅ Database optimized!\n\nBefore: ${beforeMB} MB\nAfter: ${afterMB} MB\nReclaimed: ${saved > 0 ? saved.toFixed(2) + " MB" : "0 MB"}`;
      } catch (err) {
        logger.error("[Admin] DB optimize failed:", err);
        return `❌ Optimization failed: ${(err as Error).message}`;
      }
    },
  };

  const dbCleanupTool: Tool = {
    name: "admin_db_cleanup",
    description: "Clean up old data from database - admin only. Removes old messages and security events.",
    parameters: {
      type: "object",
      properties: {
        messageRetentionDays: { type: "number", description: "Keep messages from last N days (default 90)" },
        securityRetentionDays: { type: "number", description: "Keep security events from last N days (default 30)" },
      },
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      try {
        cleanupOldData({
          messageRetentionDays: (args["messageRetentionDays"] as number) ?? 90,
          securityEventRetentionDays: (args["securityRetentionDays"] as number) ?? 30,
          expiredPairingCodes: true,
        });
        return "✅ Database cleanup completed. Check logs for details.";
      } catch (err) {
        logger.error("[Admin] DB cleanup failed:", err);
        return `❌ Cleanup failed: ${(err as Error).message}`;
      }
    },
  };

  const rateLimitStatsTool: Tool = {
    name: "admin_ratelimit_stats",
    description: "View current rate limit status for all users - admin only.",
    parameters: { type: "object", properties: {} },
    async execute(_: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      if (!rateLimiter) {
        return "Rate limiter not configured.";
      }

      const limits = rateLimiter.getAll() as Array<{ userId: string; count: number; resetAt: number }>;
      if (limits.length === 0) {
        return "No active rate limits.";
      }

      const now = Date.now();
      const lines = limits.map((l) => {
        const resetIn = Math.ceil((l.resetAt - now) / 1000);
        return `• ${l.userId}: ${l.count} requests (resets in ${resetIn}s)`;
      });

      return `⏱️ **Active Rate Limits**\n\n${lines.join("\n")}`;
    },
  };

  const rateLimitResetTool: Tool = {
    name: "admin_ratelimit_reset",
    description: "Reset rate limit for a specific user - admin only.",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID to reset" },
      },
      required: ["userId"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      if (!rateLimiter) {
        return "Rate limiter not configured.";
      }

      const targetUserId = args["userId"] as string;
      rateLimiter.reset(targetUserId);
      return `✅ Rate limit reset for user: ${targetUserId}`;
    },
  };

  const systemInfoTool: Tool = {
    name: "admin_system_info",
    description: "Get system information and health status - admin only.",
    parameters: { type: "object", properties: {} },
    async execute(_: Record<string, unknown>, ctx: ToolContext): Promise<string> {
      if (!isAdmin(ctx.userId)) {
        return "⛔ Admin access required.";
      }

      const uptime = process.uptime();
      const uptimeHours = Math.floor(uptime / 3600);
      const uptimeMinutes = Math.floor((uptime % 3600) / 60);
      const memoryUsage = process.memoryUsage();
      const memoryMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);

      return `🖥️ **System Information**

**Uptime:** ${uptimeHours}h ${uptimeMinutes}m
**Memory:** ${memoryMB} MB (heap used)
**Node Version:** ${process.version}
**Platform:** ${process.platform}
**AI Provider:** ${config.models[0]?.provider ?? "none"}
**Model:** ${config.defaultModel}
**Channels:** ${[
        config.channels.telegram?.enabled ? "Telegram" : null,
        config.channels.whatsapp?.enabled ? "WhatsApp" : null,
      ]
        .filter(Boolean)
        .join(", ")}
**Container Runtime:** ${config.security.container.runtime}`;
    },
  };

  return [
    dbStatsTool,
    dbOptimizeTool,
    dbCleanupTool,
    rateLimitStatsTool,
    rateLimitResetTool,
    systemInfoTool,
  ];
}
