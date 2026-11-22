import { describe, it, expect, vi } from "vitest";
import type { Bot } from "grammy";
import { verifySecretToken, generateSecretToken, setWebhook, TELEGRAM_ALLOWED_UPDATES } from "./webhook.js";

describe("Telegram webhook", () => {
  describe("verifySecretToken", () => {
    it("returns true for matching tokens", () => {
      expect(verifySecretToken("abc123", "abc123")).toBe(true);
    });

    it("returns false for mismatched tokens", () => {
      expect(verifySecretToken("abc123", "xyz789")).toBe(false);
    });

    it("returns false for null header", () => {
      expect(verifySecretToken(null, "expected")).toBe(false);
    });

    it("returns false for undefined header", () => {
      expect(verifySecretToken(undefined, "expected")).toBe(false);
    });

    it("returns false for empty string header", () => {
      expect(verifySecretToken("", "expected")).toBe(false);
    });

    it("returns false for different-length tokens", () => {
      expect(verifySecretToken("short", "a-longer-token")).toBe(false);
    });
  });

  describe("generateSecretToken", () => {
    it("returns a 64-character hex string (32 random bytes)", () => {
      const token = generateSecretToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates different tokens on successive calls", () => {
      const t1 = generateSecretToken();
      const t2 = generateSecretToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe("setWebhook", () => {
    it("subscribes to callback queries alongside the existing update types", async () => {
      const setWebhookApi = vi.fn(async () => true);
      const bot = { api: { setWebhook: setWebhookApi } } as unknown as Bot;
      await setWebhook(bot, { url: "https://example.test/tg", secretToken: "s" });
      expect(setWebhookApi).toHaveBeenCalledWith("https://example.test/tg", {
        secret_token: "s",
        allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
      });
      expect([...TELEGRAM_ALLOWED_UPDATES]).toEqual(["message", "edited_message", "message_reaction", "callback_query"]);
    });
  });
});
