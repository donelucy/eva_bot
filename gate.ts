import { randomBytes } from "crypto";
import { execSync, spawnSync } from "child_process";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { nanoid } from "nanoid";
import type { Config, SecurityEvent, PairingCode } from "../types.js";
import {
  isAllowlisted, addToAllowlist, savePairingCode,
  getPairingCode, consumePairingCode, logSecurityEvent,
} from "../memory/db.js";
import { logger } from "../utils/logger.js";

// ── Allowlist + Pairing ───────────────────────────────────────────────────────

export class SecurityGate {
  constructor(private config: Config) {}

  /**
   * Check if an inbound message is allowed to proceed.
   * Returns { allowed: true } or { allowed: false, reason, pairingCode? }
   */
  async check(
    userId: string,
    channel: "whatsapp" | "telegram"
  ): Promise<{ allowed: boolean; reason?: string; pairingCode?: string }> {
    // 1. Check channel-specific hardcoded allowlist (from .env)
    const hardcoded = this.getHardcodedAllowlist(channel);
    if (hardcoded.length > 0 && !hardcoded.includes(userId)) {
      // Not in hardcoded list — but check DB allowlist (from pairing approvals)
      if (!isAllowlisted(userId, channel)) {
        if (this.config.security.dmPolicy === "pairing") {
          const code = await this.issuePairingCode(userId, channel);
          this.logEvent("blocked", userId, channel, `Pairing code issued: ${code}`);
          return { allowed: false, reason: "pairing_required", pairingCode: code };
        }
        this.logEvent("blocked", userId, channel, "Not in allowlist");
        return { allowed: false, reason: "not_allowed" };
      }
    }

    this.logEvent("allowlist_hit", userId, channel, "Access granted");
    return { allowed: true };
  }

  /**
   * Approve a pairing code — adds user to DB allowlist
   */
  approvePairing(code: string): { success: boolean; userId?: string; channel?: string } {
    const entry = getPairingCode(code);
    if (!entry) return { success: false };
    if (consumePairingCode(code)) {
      addToAllowlist(entry.userId, entry.channel);
      this.logEvent("pairing_approved", entry.userId, entry.channel, `Code: ${code}`);
      return { success: true, userId: entry.userId, channel: entry.channel };
    }
    return { success: false };
  }

  private getHardcodedAllowlist(channel: "whatsapp" | "telegram"): string[] {
    if (channel === "telegram") {
      return this.config.channels.telegram?.allowedUserIds ?? [];
    }
    return this.config.channels.whatsapp?.allowedNumbers ?? [];
  }

  private async issuePairingCode(userId: string, channel: string): Promise<string> {
    const code = randomBytes(Math.ceil(this.config.security.pairingCodeLength / 2))
      .toString("hex")
      .slice(0, this.config.security.pairingCodeLength)
      .toUpperCase();
    const pairingCode: PairingCode = {
      code,
      userId,
      channel,
      expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      used: false,
    };
    savePairingCode(pairingCode);
    return code;
  }

  private logEvent(type: SecurityEvent["type"], userId: string, channel: string, details: string): void {
    const event: SecurityEvent = {
      id: nanoid(),
      type,
      userId,
      channel,
      details,
      timestamp: Date.now(),
    };
    logSecurityEvent(event);
    if (type === "blocked") {
      logger.warn(`[Security] Blocked ${channel}:${userId} — ${details}`);
    }
  }
}

// ── Container Runner ──────────────────────────────────────────────────────────

export class ContainerRunner {
  private runtime: "docker" | "none";

  constructor(private config: Config) {
    this.runtime = config.security.container.runtime;
  }

  /**
   * Check if Docker is available and the sandbox image exists
   */
  async isReady(): Promise<boolean> {
    if (this.runtime === "none") return true;
    try {
      execSync("docker info --format '{{.ServerVersion}}'", { stdio: "pipe" });
      return true;
    } catch {
      logger.warn("[Container] Docker not available — running without sandboxing");
      return false;
    }
  }

  /**
   * Ensure the sandbox Docker image is built
   */
  async ensureImage(): Promise<void> {
    if (this.runtime === "none") return;
    try {
      const result = spawnSync("docker", ["image", "inspect", this.config.security.container.image], {
        stdio: "pipe",
      });
      if (result.status !== 0) {
        logger.info("[Container] Building sandbox image...");
        await this.buildImage();
      }
    } catch (e) {
      logger.error("[Container] Failed to ensure image:", e);
    }
  }

  private async buildImage(): Promise<void> {
    const dockerfilePath = join(process.cwd(), "docker", "Dockerfile.sandbox");
    if (!existsSync(dockerfilePath)) {
      this.writeSandboxDockerfile();
    }
    execSync(`docker build -t ${this.config.security.container.image} -f ${dockerfilePath} docker/`, {
      stdio: "inherit",
    });
  }

  private writeSandboxDockerfile(): void {
    const content = `# MyBot Sandbox — Isolated agent execution environment
FROM node:22-alpine

RUN apk add --no-cache curl bash git python3 py3-pip

# Create non-root user for extra security
RUN adduser -D -u 1000 botuser
USER botuser

WORKDIR /workspace

# No network access by default — tools must explicitly request it
CMD ["sh"]
`;
    mkdirSync(join(process.cwd(), "docker"), { recursive: true });
    writeFileSync(join(process.cwd(), "docker", "Dockerfile.sandbox"), content);
  }

  /**
   * Run a command inside the Docker sandbox
   * Returns stdout or throws on failure
   */
  async runInSandbox(
    command: string,
    workspacePath: string,
    timeoutMs = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.runtime === "none") {
      // No sandboxing — run directly (development mode)
      logger.warn("[Container] Running WITHOUT sandbox isolation");
      const result = spawnSync("sh", ["-c", command], {
        cwd: workspacePath,
        timeout: timeoutMs,
        encoding: "utf8",
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      };
    }

    const containerName = `mybot-sandbox-${nanoid(8)}`;
    const cfg = this.config.security.container;

    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--memory", cfg.memoryLimit,
      "--cpus", cfg.cpuLimit,
      "--network", "none",           // No network by default
      "--read-only",                  // Read-only root filesystem
      "--tmpfs", "/tmp:size=100m",    // Writable /tmp only
      "-v", `${workspacePath}:/workspace:rw`,
      "--workdir", "/workspace",
      "--user", "1000:1000",          // Non-root
      "--security-opt", "no-new-privileges",
      cfg.image,
      "sh", "-c", command,
    ];

    try {
      const result = spawnSync("docker", args, {
        timeout: timeoutMs,
        encoding: "utf8",
      });

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      };
    } catch (err) {
      // Ensure container cleanup on error
      logger.error(`[Container] Error running sandbox, cleaning up ${containerName}:`, err);
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
      } catch (cleanupErr) {
        // Container may have already stopped
        logger.debug(`[Container] Cleanup attempted for ${containerName}`);
      }
      throw err;
    }
  }

  /**
   * Run with network access enabled (for web search tool)
   */
  async runWithNetwork(
    command: string,
    workspacePath: string,
    timeoutMs = 30000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (this.runtime === "none") {
      return this.runInSandbox(command, workspacePath, timeoutMs);
    }

    const containerName = `mybot-net-${nanoid(8)}`;
    const cfg = this.config.security.container;

    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--memory", cfg.memoryLimit,
      "--cpus", cfg.cpuLimit,
      "--tmpfs", "/tmp:size=100m",
      "-v", `${workspacePath}:/workspace:rw`,
      "--workdir", "/workspace",
      "--user", "1000:1000",
      "--security-opt", "no-new-privileges",
      cfg.image,
      "sh", "-c", command,
    ];

    try {
      const result = spawnSync("docker", args, {
        timeout: timeoutMs,
        encoding: "utf8",
      });

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? 1,
      };
    } catch (err) {
      // Ensure container cleanup on error
      logger.error(`[Container] Error running network sandbox, cleaning up ${containerName}:`, err);
      try {
        execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
      } catch (cleanupErr) {
        // Container may have already stopped
        logger.debug(`[Container] Cleanup attempted for ${containerName}`);
      }
      throw err;
    }
  }
}
