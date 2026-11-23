import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail } from "../security/audit-trail.js";
import { OwnerDirectory } from "./owners.js";
import {
  InteractionRouter,
  INTERACTION_EXPIRED_TEXT,
  INTERACTION_NOT_OWNER_TEXT,
  INTERACTION_RATE_LIMITED_TEXT,
} from "./router.js";
import { makeFakeAdapter, makeFakeRegistry, type FakeAdapter } from "./fake-channel.test-util.js";

const OWNER = "1001";
const none = { telegram: [], discord: [], whatsapp: [], signal: [], slack: [] };

describe("InteractionRouter", () => {
  describe("encode / decode", () => {
    it("round-trips", () => {
      const data = InteractionRouter.encode("prop", "a:42:deadbeef");
      expect(data).toBe("k1|prop|a:42:deadbeef");
      expect(InteractionRouter.decode(data)).toEqual({ ns: "prop", action: "a:42:deadbeef" });
    });

    it("throws when the data exceeds 64 bytes", () => {
      expect(() => InteractionRouter.encode("ask", "x".repeat(60))).toThrow(/64 bytes/);
      expect(() => InteractionRouter.encode("ask", "x".repeat(57))).not.toThrow();
    });

    it("throws on a bad namespace or action", () => {
      expect(() => InteractionRouter.encode("A", "x")).toThrow(/namespace/);
      expect(() => InteractionRouter.encode("toolongns", "x")).toThrow(/namespace/);
      expect(() => InteractionRouter.encode("ask", "")).toThrow(/action/);
      expect(() => InteractionRouter.encode("ask", "a|b")).toThrow(/action/);
      expect(() => InteractionRouter.encode("ask", "a b")).toThrow(/action/);
    });

    it("decodes only well-formed current-version data", () => {
      expect(InteractionRouter.decode("k2|ask|x")).toBeNull();
      expect(InteractionRouter.decode("k1|ask")).toBeNull();
      expect(InteractionRouter.decode("k1|ASK|x")).toBeNull();
      expect(InteractionRouter.decode("k1|ask|")).toBeNull();
      expect(InteractionRouter.decode("k1|ask|a|b")).toBeNull();
      expect(InteractionRouter.decode("garbage")).toBeNull();
      expect(InteractionRouter.decode(`k1|ask|${"x".repeat(80)}`)).toBeNull();
    });
  });

  describe("handle", () => {
    let dir: string;
    let audit: AuditTrail;
    let adapter: FakeAdapter;
    let router: InteractionRouter;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "kirie-router-test-"));
      audit = new AuditTrail(join(dir, "audit.jsonl"));
      adapter = makeFakeAdapter("telegram");
      router = new InteractionRouter({
        channelRegistry: makeFakeRegistry([adapter]),
        owners: new OwnerDirectory({ ...none, telegram: [OWNER] }),
        audit,
      });
      handler = vi.fn(async () => ({ toast: "Done" }));
      router.registerNamespace("prop", handler);
      router.attach(adapter);
    });

    afterEach(() => {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    });

    it("throws on a duplicate or invalid namespace", () => {
      expect(() => router.registerNamespace("prop", vi.fn())).toThrow(/already registered/);
      expect(() => router.registerNamespace("Bad1", vi.fn())).toThrow(/Invalid/);
    });

    it("routes an owner press in the owner's DM and acks once", async () => {
      await adapter.press({ data: "k1|prop|a:1:abcd", messageId: "55" });
      expect(handler).toHaveBeenCalledWith({
        ns: "prop",
        action: "a:1:abcd",
        channel: "telegram",
        chatId: OWNER,
        messageId: "55",
        senderId: OWNER,
      });
      expect(adapter.acks).toHaveLength(1);
      expect(adapter.acks[0]).toMatchObject({ text: "Done" });
    });

    it("acks a non-owner press with an alert, audits it, and never calls the handler", async () => {
      await adapter.press({ data: "k1|prop|a:1:abcd", senderId: "2002", chatId: "2002" });
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.acks).toEqual([expect.objectContaining({ text: INTERACTION_NOT_OWNER_TEXT, alert: true })]);
      const rec = audit.recent({ feature: "interaction" });
      expect(rec[0]).toMatchObject({ action: "press.denied", actor: "user:telegram:2002", detail: { reason: "not-owner" } });
    });

    it("does not route an owner press from a group chat", async () => {
      await adapter.press({ data: "k1|prop|a:1:abcd", chatType: "group", chatId: "-100555" });
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.acks[0]).toMatchObject({ text: INTERACTION_NOT_OWNER_TEXT, alert: true });
      expect(audit.recent({ feature: "interaction" })[0]!.detail).toMatchObject({ reason: "not-dm" });
    });

    it("does not route an owner press from someone else's DM (Telegram chatId must equal senderId)", async () => {
      await adapter.press({ data: "k1|prop|a:1:abcd", chatType: "dm", chatId: "3003" });
      expect(handler).not.toHaveBeenCalled();
      expect(audit.recent({ feature: "interaction" })[0]!.detail).toMatchObject({ reason: "not-own-dm" });
    });

    it("denies every press when no owner is configured", async () => {
      const r = new InteractionRouter({ channelRegistry: makeFakeRegistry([adapter]), owners: new OwnerDirectory(none), audit });
      const h = vi.fn();
      r.registerNamespace("prop", h);
      await r.handle({ id: "x", channel: "telegram", senderId: OWNER, senderName: "", chatId: OWNER, chatType: "dm", messageId: "1", data: "k1|prop|a", timestamp: 0, raw: null });
      expect(h).not.toHaveBeenCalled();
    });

    it("answers Expired for an unknown namespace or version", async () => {
      await adapter.press({ data: "k1|zzz|a" });
      await adapter.press({ data: "k0|prop|a" });
      await adapter.press({ data: "not ours" });
      expect(handler).not.toHaveBeenCalled();
      expect(adapter.acks.map((a) => a.text)).toEqual([INTERACTION_EXPIRED_TEXT, INTERACTION_EXPIRED_TEXT, INTERACTION_EXPIRED_TEXT]);
    });

    it("rate limits to 20 presses per minute per sender", async () => {
      vi.useFakeTimers();
      for (let i = 0; i < 20; i++) await adapter.press({ data: "k1|prop|a" });
      await adapter.press({ data: "k1|prop|a" });
      expect(handler).toHaveBeenCalledTimes(20);
      expect(adapter.acks[20]).toMatchObject({ text: INTERACTION_RATE_LIMITED_TEXT });
      vi.advanceTimersByTime(61_000);
      await adapter.press({ data: "k1|prop|a" });
      expect(handler).toHaveBeenCalledTimes(21);
    });

    it("applies the handler's reply to the message", async () => {
      handler.mockResolvedValueOnce({ replaceText: "Applied", removeButtons: true, toast: "OK", alert: true });
      await adapter.press({ data: "k1|prop|a", messageId: "77" });
      expect(adapter.updates).toEqual([
        { ctx: { chatId: OWNER }, messageId: "77", text: "Applied", buttons: null, plain: true },
      ]);
      expect(adapter.acks[0]).toMatchObject({ text: "OK", alert: true });
    });

    it("acks even when the handler returns nothing", async () => {
      handler.mockResolvedValueOnce(undefined);
      await adapter.press({ data: "k1|prop|a" });
      expect(adapter.acks).toHaveLength(1);
      expect(adapter.updates).toEqual([]);
    });

    it("acks with an alert and audits when the handler throws", async () => {
      handler.mockRejectedValueOnce(new Error("kaput"));
      await adapter.press({ data: "k1|prop|a" });
      expect(adapter.acks).toHaveLength(1);
      expect(adapter.acks[0]!.alert).toBe(true);
      expect(audit.recent({ feature: "interaction", action: "press.failed" })).toHaveLength(1);
    });

    it("never throws when acking fails", async () => {
      (adapter.ackInteraction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("query is too old"));
      await expect(router.handle({ id: "x", channel: "telegram", senderId: OWNER, senderName: "", chatId: OWNER, chatType: "dm", messageId: "1", data: "k1|prop|a", timestamp: 0, raw: null })).resolves.toBeUndefined();
    });

    it("attaches to an adapter only once", async () => {
      router.attach(adapter);
      await adapter.press({ data: "k1|prop|a" });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
