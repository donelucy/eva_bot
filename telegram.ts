import { Bot, type Context } from "grammy";
import type { Config, IncomingMessage, OutgoingMessage } from "../types.js";
import { SecurityGate } from "../security/gate.js";
import { logger } from "../utils/logger.js";

type MessageHandler = (msg: IncomingMessage) => Promise<string>;

export class TelegramChannel {
  private bot: Bot;
  private gate: SecurityGate;

  constructor(
    private config: Config,
    private onMessage: MessageHandler
  ) {
    const token = config.channels.telegram?.token;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN not configured");

    this.bot = new Bot(token);
    this.gate = new SecurityGate(config);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    const triggerWord = this.config.gateway.triggerWord.toLowerCase();

    this.bot.on("message:text", async (ctx: Context) => {
      const msg = ctx.message;
      if (!msg?.text || !msg.from) return;

      const userId = String(msg.from.id);
      const text = msg.text;
      const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
      const groupId = isGroup ? String(msg.chat.id) : undefined;

      // In groups, only respond to trigger word
      if (isGroup && !text.toLowerCase().includes(triggerWord)) return;

      // Security gate
      const check = await this.gate.check(userId, "telegram");
      if (!check.allowed) {
        if (check.pairingCode) {
          await ctx.reply(
            `🔐 Access requires authorization.\n\nYour pairing code: \`${check.pairingCode}\`\n\nAsk the bot owner to run: \`approve ${check.pairingCode}\``,
            { parse_mode: "Markdown" }
          );
        }
        return;
      }

      // Strip trigger word from message
      const cleanText = isGroup
        ? text.replace(new RegExp(triggerWord, "gi"), "").trim()
        : text;

      if (!cleanText) return;

      // Show typing indicator
      await ctx.api.sendChatAction(msg.chat.id, "typing").catch(() => {});

      const incoming: IncomingMessage = {
        id: String(msg.message_id),
        from: userId,
        groupId,
        groupName: isGroup ? msg.chat.title : undefined,
        text: cleanText,
        channel: "telegram",
        timestamp: msg.date * 1000,
      };

      try {
        const response = await this.onMessage(incoming);
        await this.send({ to: userId, groupId, text: response, channel: "telegram" });
      } catch (err) {
        logger.error("[Telegram] Message handler error:", err);
        await ctx.reply("❌ Something went wrong. Please try again.").catch(() => {});
      }
    });

    // Handle /start command
    this.bot.command("start", async (ctx) => {
      await ctx.reply(
        "👋 Hello! I'm your personal AI assistant.\n\nSend me any message to get started."
      );
    });

    // Handle /status command
    this.bot.command("status", async (ctx) => {
      await ctx.reply("✅ Bot is online and running.");
    });

    this.bot.catch((err) => {
      logger.error("[Telegram] Bot error:", err);
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    const chatId = msg.groupId ? parseInt(msg.groupId) : parseInt(msg.to);
    const maxLen = 4096;

    // Split long messages
    const chunks: string[] = [];
    let text = msg.text;
    while (text.length > 0) {
      chunks.push(text.slice(0, maxLen));
      text = text.slice(maxLen);
    }

    for (const chunk of chunks) {
      await this.bot.api
        .sendMessage(chatId, chunk, { parse_mode: "Markdown" })
        .catch(async () => {
          // Fallback: send without markdown if parsing fails
          await this.bot.api.sendMessage(chatId, chunk).catch((e) => {
            logger.error("[Telegram] Failed to send message:", e);
          });
        });
    }
  }

  async start(): Promise<void> {
    logger.info("[Telegram] Starting bot...");
    await this.bot.start({
      onStart: (info) => logger.info(`[Telegram] Bot @${info.username} is running`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    logger.info("[Telegram] Bot stopped");
  }
}
