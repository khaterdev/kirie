import type { SecurityConfig } from "../config/schema.js";
import type { ChannelName, ChatType } from "../channels/normalizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Milliseconds until the next token is available (only set when denied) */
  retryAfterMs?: number;
  /** Remaining tokens in the bucket */
  remaining: number;
  /** Total bucket capacity */
  limit: number;
}

export interface RateLimiterOptions {
  /** Security config section from KirieConfig */
  securityConfig: SecurityConfig;
  /** Interval in ms for stale bucket cleanup (default: 60000) */
  cleanupIntervalMs?: number;
}

interface TokenBucket {
  tokens: number;
  maxTokens: number;
  refillRatePerMs: number;
  lastRefill: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const STALE_BUCKET_AGE_MS = 5 * 60_000; // Remove buckets idle for 5 minutes

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly buckets: Map<string, TokenBucket> = new Map();
  private readonly perUserMax: number;
  private readonly perUserWindowMs: number;
  private readonly perGroupMax: number;
  private readonly perGroupWindowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RateLimiterOptions) {
    const { securityConfig, cleanupIntervalMs } = options;

    this.perUserMax = securityConfig.rateLimit.perUser.maxRequests;
    this.perUserWindowMs = securityConfig.rateLimit.perUser.windowMs;
    this.perGroupMax = securityConfig.rateLimit.perGroup.maxRequests;
    this.perGroupWindowMs = securityConfig.rateLimit.perGroup.windowMs;

    // Start automatic stale bucket cleanup
    const interval = cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.cleanup(), interval);
    // Allow the process to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Attempt to consume a token for a given user on a channel.
   * Uses per-user limits for DMs and per-group limits for group chats.
   */
  consume(
    channel: ChannelName,
    userId: string,
    chatType: ChatType,
  ): RateLimitResult {
    const isGroup = chatType === "group" || chatType === "thread";
    const bucketKey = isGroup
      ? `group:${channel}:${userId}`
      : `user:${channel}:${userId}`;

    const maxTokens = isGroup ? this.perGroupMax : this.perUserMax;
    const windowMs = isGroup ? this.perGroupWindowMs : this.perUserWindowMs;
    const refillRatePerMs = maxTokens / windowMs;

    const bucket = this.getOrCreateBucket(bucketKey, maxTokens, refillRatePerMs);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        limit: maxTokens,
      };
    }

    // Denied: calculate when the next token will be available
    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs);

    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      limit: maxTokens,
    };
  }

  /**
   * Reset the rate limit for a specific user on a channel.
   * Used for admin overrides.
   */
  reset(channel: ChannelName, userId: string): void {
    // Remove both user and group buckets for this user/channel
    this.buckets.delete(`user:${channel}:${userId}`);
    this.buckets.delete(`group:${channel}:${userId}`);
  }

  /**
   * Get current rate limit status without consuming a token.
   */
  peek(
    channel: ChannelName,
    userId: string,
    chatType: ChatType,
  ): RateLimitResult {
    const isGroup = chatType === "group" || chatType === "thread";
    const bucketKey = isGroup
      ? `group:${channel}:${userId}`
      : `user:${channel}:${userId}`;

    const maxTokens = isGroup ? this.perGroupMax : this.perUserMax;
    const refillRatePerMs = maxTokens / (isGroup ? this.perGroupWindowMs : this.perUserWindowMs);

    const bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      return { allowed: true, remaining: maxTokens, limit: maxTokens };
    }

    // Simulate refill without mutating
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const refilled = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRatePerMs,
    );

    if (refilled >= 1) {
      return {
        allowed: true,
        remaining: Math.floor(refilled),
        limit: maxTokens,
      };
    }

    const tokensNeeded = 1 - refilled;
    const retryAfterMs = Math.ceil(tokensNeeded / refillRatePerMs);

    return {
      allowed: false,
      retryAfterMs,
      remaining: 0,
      limit: maxTokens,
    };
  }

  /**
   * Stop the cleanup timer. Call this on shutdown.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private getOrCreateBucket(
    key: string,
    maxTokens: number,
    refillRatePerMs: number,
  ): TokenBucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: maxTokens,
        maxTokens,
        refillRatePerMs,
        lastRefill: Date.now(),
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;

    // Guard against clock skew: if the clock jumped backward, reset the window
    if (elapsed < 0) {
      bucket.lastRefill = now;
      bucket.tokens = bucket.maxTokens;
      return;
    }

    if (elapsed === 0) return;

    bucket.tokens = Math.min(
      bucket.maxTokens,
      bucket.tokens + elapsed * bucket.refillRatePerMs,
    );
    bucket.lastRefill = now;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      // Remove buckets that haven't been used recently and are fully refilled
      if (
        now - bucket.lastRefill > STALE_BUCKET_AGE_MS &&
        bucket.tokens >= bucket.maxTokens
      ) {
        this.buckets.delete(key);
      }
    }
  }
}
