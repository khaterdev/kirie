import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import type { SecurityConfig } from "../config/schema.js";

function makeSecurityConfig(overrides: Partial<SecurityConfig["rateLimit"]> = {}): SecurityConfig {
  return {
    owner: { identities: { telegram: [], discord: [], whatsapp: [], signal: [], slack: [] } },
    dmPolicy: "owner-only",
    groupPolicy: "mention-only",
    rateLimit: {
      perUser: { maxRequests: 5, windowMs: 1000, ...overrides.perUser },
      perGroup: { maxRequests: 10, windowMs: 1000, ...overrides.perGroup },
    },
  } as SecurityConfig;
}

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.dispose();
  });

  describe("consume", () => {
    it("allows requests within the limit", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      for (let i = 0; i < 5; i++) {
        const result = limiter.consume("telegram", "user-1", "dm");
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(5 - i - 1);
        expect(result.limit).toBe(5);
      }
    });

    it("denies requests exceeding the limit", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Exhaust the bucket
      for (let i = 0; i < 5; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      const result = limiter.consume("telegram", "user-1", "dm");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("uses per-group limits for group chats", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Per-group limit is 10
      for (let i = 0; i < 10; i++) {
        const result = limiter.consume("telegram", "user-1", "group");
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(10);
      }

      const denied = limiter.consume("telegram", "user-1", "group");
      expect(denied.allowed).toBe(false);
    });

    it("uses per-group limits for thread chats", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Threads use group limits too
      const result = limiter.consume("telegram", "user-1", "thread");
      expect(result.limit).toBe(10);
    });

    it("tracks different users independently", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Exhaust user-1's bucket
      for (let i = 0; i < 5; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      // user-2 should still have tokens
      const result = limiter.consume("telegram", "user-2", "dm");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it("tracks different channels independently", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Exhaust telegram bucket
      for (let i = 0; i < 5; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      // discord should still have tokens
      const result = limiter.consume("discord", "user-1", "dm");
      expect(result.allowed).toBe(true);
    });
  });

  describe("token refill", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("refills tokens over time", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig({ perUser: { maxRequests: 5, windowMs: 1000 } }),
        cleanupIntervalMs: 60000,
      });

      // Exhaust all tokens
      for (let i = 0; i < 5; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      // Advance time by 200ms - should refill 1 token (5 tokens / 1000ms * 200ms = 1)
      vi.advanceTimersByTime(200);

      const result = limiter.consume("telegram", "user-1", "dm");
      expect(result.allowed).toBe(true);
    });

    it("resets the window when system clock jumps backward", () => {
      const now = Date.now();
      vi.setSystemTime(now);

      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig({ perUser: { maxRequests: 5, windowMs: 1000 } }),
        cleanupIntervalMs: 60000,
      });

      // Consume 3 tokens
      for (let i = 0; i < 3; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      // Should have 2 remaining
      expect(limiter.peek("telegram", "user-1", "dm").remaining).toBe(2);

      // Simulate clock jumping backward by 10 seconds
      vi.setSystemTime(now - 10_000);

      // After clock skew, the bucket should reset to full capacity
      const result = limiter.consume("telegram", "user-1", "dm");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // maxTokens(5) - 1 consumed now
    });

    it("does not exceed max tokens", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig({ perUser: { maxRequests: 5, windowMs: 1000 } }),
        cleanupIntervalMs: 60000,
      });

      // Wait a very long time - tokens should cap at max
      vi.advanceTimersByTime(100000);

      const result = limiter.consume("telegram", "user-1", "dm");
      expect(result.remaining).toBe(4); // 5 - 1
    });
  });

  describe("peek", () => {
    it("returns status without consuming tokens", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Fresh bucket
      const peek1 = limiter.peek("telegram", "user-1", "dm");
      expect(peek1.allowed).toBe(true);
      expect(peek1.remaining).toBe(5);

      // Should still be 5 (not consumed by peek)
      const peek2 = limiter.peek("telegram", "user-1", "dm");
      expect(peek2.remaining).toBe(5);
    });

    it("reflects consumed tokens", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      limiter.consume("telegram", "user-1", "dm");
      limiter.consume("telegram", "user-1", "dm");

      const peek = limiter.peek("telegram", "user-1", "dm");
      expect(peek.remaining).toBe(3);
    });
  });

  describe("reset", () => {
    it("resets rate limit for a user", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      // Exhaust the bucket
      for (let i = 0; i < 5; i++) {
        limiter.consume("telegram", "user-1", "dm");
      }

      expect(limiter.consume("telegram", "user-1", "dm").allowed).toBe(false);

      limiter.reset("telegram", "user-1");

      // After reset, should be allowed again
      const result = limiter.consume("telegram", "user-1", "dm");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });
  });

  describe("dispose", () => {
    it("clears all buckets and timers", () => {
      limiter = new RateLimiter({
        securityConfig: makeSecurityConfig(),
        cleanupIntervalMs: 60000,
      });

      limiter.consume("telegram", "user-1", "dm");
      limiter.dispose();

      // After dispose, fresh bucket should be created
      const result = limiter.peek("telegram", "user-1", "dm");
      expect(result.remaining).toBe(5);
    });
  });
});
