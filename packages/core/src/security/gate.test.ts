import { describe, it, expect, vi } from "vitest";
import { SecurityGate, type ChannelSecurityRestrictions } from "./gate.js";
import { IdentityResolver } from "./auth.js";
import { AuthorizationEngine } from "./authz.js";
import { RateLimiter } from "./rate-limiter.js";
import { InputGuard } from "./input-guard.js";
import type { UnifiedMessage } from "../channels/normalizer.js";

function makeMessage(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "msg-1",
    channel: "telegram",
    senderId: "123",
    senderName: "Test User",
    text: "hello",
    chatType: "dm",
    chatId: "chat-1",
    timestamp: Date.now(),
    raw: {},
    ...overrides,
  };
}

function makeGate(channelRestrictions?: Record<string, ChannelSecurityRestrictions>) {
  const securityConfig = {
    owner: { identities: { telegram: ["123"], discord: [], whatsapp: [], signal: [], slack: [] } },
    dmPolicy: "open" as const,
    groupPolicy: "all" as const,
    rateLimit: {
      perUser: { maxRequests: 100, windowMs: 60000 },
      perGroup: { maxRequests: 100, windowMs: 60000 },
    },
  };

  return new SecurityGate({
    identityResolver: new IdentityResolver({ securityConfig }),
    authzEngine: new AuthorizationEngine({
      dmPolicy: securityConfig.dmPolicy,
      groupPolicy: securityConfig.groupPolicy,
    }),
    rateLimiter: new RateLimiter({ securityConfig }),
    inputGuard: new InputGuard(),
    channelRestrictions,
  });
}

describe("SecurityGate channel restrictions", () => {
  describe("allowedUserIds", () => {
    it("passes when user is in allowedUserIds", () => {
      const gate = makeGate({
        telegram: { allowedUserIds: [123, 456] },
      });
      const result = gate.check(makeMessage({ senderId: "123" }));
      expect(result.passed).toBe(true);
    });

    it("blocks when user is NOT in allowedUserIds", () => {
      const gate = makeGate({
        telegram: { allowedUserIds: [456, 789] },
      });
      const result = gate.check(makeMessage({ senderId: "123" }));
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("allowlist");
      }
    });

    it("passes when allowedUserIds is empty (no restriction)", () => {
      const gate = makeGate({
        telegram: { allowedUserIds: [] },
      });
      const result = gate.check(makeMessage({ senderId: "123" }));
      expect(result.passed).toBe(true);
    });

    it("passes for channels without restrictions", () => {
      const gate = makeGate({
        discord: { allowedUserIds: [456] },
      });
      // Telegram has no restrictions configured
      const result = gate.check(makeMessage({ senderId: "123", channel: "telegram" }));
      expect(result.passed).toBe(true);
    });
  });

  describe("allowGroups", () => {
    it("blocks group messages when allowGroups is false", () => {
      const gate = makeGate({
        telegram: { allowGroups: false },
      });
      const result = gate.check(makeMessage({ chatType: "group", chatId: "group-1" }));
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("disabled");
      }
    });

    it("blocks thread messages when allowGroups is false", () => {
      const gate = makeGate({
        telegram: { allowGroups: false },
      });
      const result = gate.check(makeMessage({ chatType: "thread", chatId: "group-1", threadId: "t-1" }));
      expect(result.passed).toBe(false);
    });

    it("passes DM messages when allowGroups is false", () => {
      const gate = makeGate({
        telegram: { allowGroups: false },
      });
      const result = gate.check(makeMessage({ chatType: "dm" }));
      expect(result.passed).toBe(true);
    });

    it("passes group messages when allowGroups is true", () => {
      const gate = makeGate({
        telegram: { allowGroups: true },
      });
      const result = gate.check(makeMessage({ chatType: "group", chatId: "group-1" }));
      expect(result.passed).toBe(true);
    });
  });

  describe("combined restrictions", () => {
    it("checks allowedUserIds before allowGroups", () => {
      const gate = makeGate({
        telegram: {
          allowedUserIds: [456],
          allowGroups: false,
        },
      });
      // User not in allowlist, should fail on allowlist check first
      const result = gate.check(makeMessage({ senderId: "123", chatType: "dm" }));
      expect(result.passed).toBe(false);
      if (!result.passed) {
        expect(result.reason).toContain("allowlist");
      }
    });
  });

  describe("without channel restrictions", () => {
    it("passes all checks normally when no restrictions configured", () => {
      const gate = makeGate();
      const result = gate.check(makeMessage());
      expect(result.passed).toBe(true);
    });
  });
});
