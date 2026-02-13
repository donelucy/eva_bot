import { loadConfig } from "./config/loader.js";
import { initDb, optimizeDatabase, cleanupOldData, getDatabaseStats } from "./memory/db.js";
import { AgentLoop } from "./agent/loop.js";
import { buildToolRegistry } from "./tools/registry.js";
import { makeSwarmTool } from "./swarm/orchestrator.js";
import { Scheduler } from "./scheduler/cron.js";
import { TelegramChannel } from "./channels/telegram.js";
import { WhatsAppChannel } from "./channels/whatsapp.js";
import { ContainerRunner } from "./security/gate.js";
import { RateLimiter } from "./security/ratelimit.js";
import { logger } from "./utils/logger.js";
import type { IncomingMessage, OutgoingMessage } from "./types.js";

async function main() {
  console.log("\n🤖 MyBot — Personal AI Assistant\n");

  // ── Load config ──────────────────────────────────────────────────────────
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error("❌ Configuration error:", (err as Error).message);
    console.error("   Copy .env.example to .env and fill in your keys.");
    process.exit(1);
  }

  // ── Setup logger ─────────────────────────────────────────────────────────
  logger.configure(config.logging.level, config.logging.file);
  logger.info("Starting MyBot...");

  // ── Init database ─────────────────────────────────────────────────────────
  initDb(config.db.path);
  logger.info(`[DB] Initialized at ${config.db.path}`);

  // ── Check container runtime ───────────────────────────────────────────────
  const containerRunner = new ContainerRunner(config);
  const containerReady = await containerRunner.isReady();
  if (containerReady && config.security.container.runtime === "docker") {
    logger.info("[Security] Docker available — sandbox isolation ENABLED ✓");
    await containerRunner.ensureImage();
  } else if (config.security.container.runtime === "docker") {
    logger.warn("[Security] Docker NOT available — sandbox isolation DISABLED ⚠️");
    const platform = process.platform;
    if (platform === "win32") {
      logger.warn("           Install Docker Desktop with WSL2 integration for full security");
    } else {
      logger.warn("           Install Docker (see README for installation instructions)");
    }
  }

  // ── Channel send function (used by tools and scheduler) ──────────────────
  let telegram: TelegramChannel | undefined;
  let whatsapp: WhatsAppChannel | undefined;

  const sendMessage = async (userId: string, channel: string, text: string): Promise<void> => {
    const outgoing: OutgoingMessage = { to: userId, text, channel: channel as OutgoingMessage["channel"] };
    if (channel === "telegram" && telegram) {
      await telegram.send(outgoing);
    } else if (channel === "whatsapp" && whatsapp) {
      await whatsapp.send(outgoing);
    } else {
      logger.warn(`[Gateway] Cannot send to ${channel}:${userId} — channel not active`);
    }
  };

  // ── Build tool registry ───────────────────────────────────────────────────
  const tools = buildToolRegistry(config, sendMessage);

  // Add swarm tool
  const swarmTool = makeSwarmTool(config);
  tools.set(swarmTool.name, swarmTool);

  // ── Rate limiter ──────────────────────────────────────────────────────────
  const rateLimiter = new RateLimiter(20, 60000); // 20 requests per minute per user

  // Add admin tools
  const { makeAdminTools } = await import("./tools/admin.js");
  const adminTools = makeAdminTools(config, rateLimiter);
  for (const tool of adminTools) {
    tools.set(tool.name, tool);
  }

  // Add Obsidian memory tools
  const { makeObsidianTools } = await import("./tools/obsidian.js");
  const obsidianTools = makeObsidianTools();
  for (const tool of obsidianTools) {
    tools.set(tool.name, tool);
  }

  logger.info(`[Tools] Registered: ${Array.from(tools.keys()).join(", ")}`);

  // ── Create agent loop ─────────────────────────────────────────────────────
  const agent = new AgentLoop(config, tools);

  // ── Message handler (shared by all channels) ──────────────────────────────
  const handleMessage = async (incoming: IncomingMessage): Promise<string> => {
    logger.info(`[Gateway] Message from ${incoming.channel}:${incoming.from} — "${incoming.text.slice(0, 60)}..."`);
    
    // Check rate limit
    const rateCheck = rateLimiter.check(incoming.from);
    if (!rateCheck.allowed) {
      const waitSeconds = Math.ceil((rateCheck.retryAfter ?? 0) / 1000);
      return `⏸️ Rate limit exceeded. Please wait ${waitSeconds} seconds before trying again.`;
    }

    try {
      return await agent.process(incoming);
    } catch (error) {
      logger.error("[Gateway] Message processing error:", error);
      return "❌ An error occurred while processing your message. Please try again.";
    }
  };

  // ── Start scheduler ───────────────────────────────────────────────────────
  const scheduler = new Scheduler(agent, sendMessage);
  scheduler.start();

  // Sync scheduler every 60 seconds to pick up new jobs created via tools
  setInterval(() => scheduler.sync(), 60_000);

  // ── Database maintenance ──────────────────────────────────────────────────
  // Clean up old data daily at 3 AM (or ~24 hours after start)
  setInterval(() => {
    logger.info("[DB] Running scheduled cleanup...");
    cleanupOldData({ messageRetentionDays: 90, securityEventRetentionDays: 30 });
  }, 24 * 60 * 60 * 1000);

  // Optimize database every 7 days
  setInterval(() => {
    logger.info("[DB] Running scheduled optimization...");
    optimizeDatabase();
  }, 7 * 24 * 60 * 60 * 1000);

  // Log database stats every hour
  setInterval(() => {
    const stats = getDatabaseStats();
    logger.debug(`[DB] Stats: ${stats.sessions} sessions, ${stats.messages} messages, ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  }, 60 * 60 * 1000);

  // ── Start channels ────────────────────────────────────────────────────────
  const startPromises: Promise<void>[] = [];

  if (config.channels.telegram?.enabled) {
    telegram = new TelegramChannel(config, handleMessage);
    startPromises.push(telegram.start());
    logger.info("[Telegram] Channel enabled ✓");
  } else {
    logger.warn("[Telegram] Skipped (no TELEGRAM_BOT_TOKEN configured)");
  }

  if (config.channels.whatsapp?.enabled) {
    whatsapp = new WhatsAppChannel(config, handleMessage);
    startPromises.push(whatsapp.start());
    logger.info("[WhatsApp] Channel enabled ✓");
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    logger.info(`\n[Gateway] Received ${signal} — shutting down gracefully...`);
    scheduler.stop();
    if (telegram) await telegram.stop();
    if (whatsapp) await whatsapp.stop();
    logger.info("[Gateway] Shutdown complete. Goodbye! 🤖");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // ── Print startup summary ─────────────────────────────────────────────────
  console.log("\n✅ MyBot is running!\n");
  console.log(`   AI Provider : ${config.models[0]?.provider ?? "none"} (${config.defaultModel})`);
  console.log(`   Telegram    : ${config.channels.telegram?.enabled ? "✓" : "✗ (not configured)"}`);
  console.log(`   WhatsApp    : ✓ (scan QR if prompted)`);
  console.log(`   Security    : ${containerReady ? "Docker containers + allowlist" : "Allowlist only"}`);
  console.log(`   Web search  : ${config.features.webSearch ? "✓" : "✗ (no BRAVE_SEARCH_API_KEY)"}`);
  console.log(`   Trigger word: ${config.gateway.triggerWord}`);
  console.log("\n   Press Ctrl+C to stop.\n");

  await Promise.all(startPromises);
}

main().catch((err) => {
  logger.error("[Gateway] Fatal error:", err);
  process.exit(1);
});
