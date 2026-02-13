import { logger } from "../utils/logger.js";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter per user
 */
export class RateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests = 20, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;

    // Clean up expired entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Check if a user has exceeded their rate limit
   * Returns { allowed: true } or { allowed: false, retryAfter: milliseconds }
   */
  check(userId: string): { allowed: boolean; retryAfter?: number } {
    const now = Date.now();
    const entry = this.limits.get(userId);

    // No entry or expired — allow and create new entry
    if (!entry || now >= entry.resetAt) {
      this.limits.set(userId, {
        count: 1,
        resetAt: now + this.windowMs,
      });
      return { allowed: true };
    }

    // Within window — check count
    if (entry.count < this.maxRequests) {
      entry.count++;
      return { allowed: true };
    }

    // Rate limit exceeded
    const retryAfter = entry.resetAt - now;
    logger.warn(`[RateLimit] User ${userId} exceeded limit (${this.maxRequests}/${this.windowMs}ms)`);
    return { allowed: false, retryAfter };
  }

  /**
   * Get current usage for a user
   */
  getUsage(userId: string): { count: number; limit: number; resetAt: number } | null {
    const entry = this.limits.get(userId);
    if (!entry || Date.now() >= entry.resetAt) {
      return null;
    }
    return {
      count: entry.count,
      limit: this.maxRequests,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Clean up expired entries to prevent memory leak
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [userId, entry] of this.limits.entries()) {
      if (now >= entry.resetAt) {
        this.limits.delete(userId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[RateLimit] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Reset rate limit for a specific user (admin use)
   */
  reset(userId: string): void {
    this.limits.delete(userId);
    logger.info(`[RateLimit] Reset limit for user ${userId}`);
  }

  /**
   * Get all active rate limits (admin/monitoring use)
   */
  getAll(): Array<{ userId: string; count: number; resetAt: number }> {
    const now = Date.now();
    const results: Array<{ userId: string; count: number; resetAt: number }> = [];
    for (const [userId, entry] of this.limits.entries()) {
      if (now < entry.resetAt) {
        results.push({ userId, count: entry.count, resetAt: entry.resetAt });
      }
    }
    return results;
  }
}
