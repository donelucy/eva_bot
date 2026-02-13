import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
  type WASocket,
} from "baileys";
import { Boom } from "@hapi/boom";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Config, IncomingMessage, OutgoingMessage } from "../types.js";
import { SecurityGate } from "../security/gate.js";
import { logger } from "../utils/logger.js";

type MessageHandler = (msg: IncomingMessage) => Promise<string>;

const AUTH_DIR = join(homedir(), ".mybot", "whatsapp-auth");

export class WhatsAppChannel {
  private sock?: WASocket;
  private gate: SecurityGate;
  private store = makeInMemoryStore({});
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECTS = 10;
  private reconnectTimer?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(
    private config: Config,
    private onMessage: MessageHandler
  ) {
    this.gate = new SecurityGate(config);
    if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.sock?.end(undefined);
    logger.info("[WhatsApp] Disconnected");
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: { level: "silent" } as never,
      markOnlineOnConnect: false,
    });

    this.store.bind(this.sock.ev);

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info("[WhatsApp] Scan the QR code above with WhatsApp → Se && !this.isShuttingDown;

        logger.warn(`[WhatsApp] Connection closed (${statusCode}). Reconnect: ${shouldReconnect}`);

        if (shouldReconnect && this.reconnectAttempts < this.MAX_RECONNECTS) {
          this.reconnectAttempts++;
          // Exponential backoff with jitter: 2^n * 1000ms + random(0-1000ms)
          const baseDelay = Math.min(1000 * 2 ** this.reconnectAttempts, 60000);
          const jitter = Math.random() * 1000;
          const delay = baseDelay + jitter;
          
          logger.info(`[WhatsApp] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${this.MAX_RECONNECTS})`);
          
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connect();
          }, delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.error("[WhatsApp] Logged out. Delete ~/.mybot/whatsapp-auth and restart.");
        } else if (this.reconnectAttempts >= this.MAX_RECONNECTS) {
          logger.error(`[WhatsApp] Max reconnection attempts (${this.MAX_RECONNECTS}) reached. Please restart manually.`);
        }
      } else if (connection === "open") {
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }nect(), delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          logger.error("[WhatsApp] Logged out. Delete ~/.mybot/whatsapp-auth and restart.");
        }
      } else if (connection === "open") {
        this.reconnectAttempts = 0;
        logger.info("[WhatsApp] Connected ✓");
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          "";

        if (!text) continue;

        const jid = msg.key.remoteJid ?? "";
        const isGroup = jid.endsWith("@g.us");
        const senderId = isGroup
          ? (msg.key.participant ?? "").replace("@s.whatsapp.net", "")
          : jid.replace("@s.whatsapp.net", "");

        const senderNumber = `+${senderId}`;
        const groupId = isGroup ? jid : undefined;

        const triggerWord = this.config.gateway.triggerWord.toLowerCase();

        // In groups, only respond to trigger word
        if (isGroup && !text.toLowerCase().includes(triggerWord)) continue;

        // Security gate
        const check = await this.gate.check(senderNumber, "whatsapp");
        if (!check.allowed) {
          if (check.pairingCode) {
            await this.sendRaw(jid, `🔐 Access requires authorization.\n\nYour pairing code: ${check.pairingCode}\n\nAsk the bot owner to approve it.`);
          }
          continue;
        }

        const cleanText = isGroup
          ? text.replace(new RegExp(triggerWord, "gi"), "").trim()
          : text;

        if (!cleanText) continue;

        // Show "typing..." indicator
        await this.sock?.sendPresenceUpdate("composing", jid).catch(() => {});

        const incoming: IncomingMessage = {
          id: msg.key.id ?? "",
          from: senderNumber,
          fromNumber: senderNumber,
          groupId,
          text: cleanText,
          channel: "whatsapp",
          timestamp: (msg.messageTimestamp as number) * 1000,
        };

        try {
          const response = await this.onMessage(incoming);
          await this.send({ to: senderNumber, groupId, text: response, channel: "whatsapp" });
        } catch (err) {
          logger.error("[WhatsApp] Message handler error:", err);
          await this.sendRaw(jid, "❌ Something went wrong. Please try again.").catch(() => {});
        } finally {
          await this.sock?.sendPresenceUpdate("paused", jid).catch(() => {});
        }
      }
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.sock) {
      logger.error("[WhatsApp] Not connected");
      return;
    }

    const jid = msg.groupId
      ? msg.groupId
      : `${msg.to.replace("+", "")}@s.whatsapp.net`;

    await this.sendRaw(jid, msg.text);
  }

  private async sendRaw(jid: string, text: string): Promise<void> {
    if (!this.sock) return;
    // Split long messages at 4000 chars
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 4000));
      remaining = remaining.slice(4000);
    }

    for (const chunk of chunks) {
      await this.sock.sendMessage(jid, { text: chunk }).catch((err) => {
        logger.error("[WhatsApp] Send failed:", err);
      });
    }
  }
}
