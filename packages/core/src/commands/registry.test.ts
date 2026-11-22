import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedMessage } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { AuditTrail } from "../security/audit-trail.js";
import { OwnerDirectory } from "../interaction/owners.js";
import {
  CommandRegistry,
  COMMAND_DM_ONLY_TEXT,
  COMMAND_OWNER_ONLY_TEXT,
  commandContinuesToAgent,
  isDirectMessage,
  type CommandRegistryDeps,
} from "./registry.js";
import type { CommandContext, CommandDefinition, CommandReply, DispatchOutcome } from "./types.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "m1",
    channel: "telegram",
    senderId: OWNER,
    senderName: "Owner",
    text: "/status",
    chatType: "dm",
    chatId: OWNER,
    timestamp: Date.now(),
    raw: null,
    ...over,
  };
}

function identityFor(m: UnifiedMessage): ResolvedIdentity {
  return {
    role: m.senderId === OWNER ? "owner" : "user",
    canonicalId: `${m.channel}:${m.senderId}`,
    channel: m.channel,
    senderId: m.senderId,
  };
}

function def(over: Partial<CommandDefinition> = {}): CommandDefinition {
  return {
    name: "status",
    description: "Show status",
    category: "core",
    ownerOnly: true,
    handler: vi.fn(() => "ok"),
    ...over,
  };
}

describe("CommandRegistry", () => {
  let dir: string;
  let audit: AuditTrail;
  let owners: OwnerDirectory;
  let sent: CommandReply[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-cmd-test-"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    owners = new OwnerDirectory({ telegram: [Number(OWNER)], discord: [], whatsapp: [], signal: [], slack: [] });
    sent = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function registry(over: Partial<CommandRegistryDeps> = {}): CommandRegistry {
    return new CommandRegistry({ owners, audit, selfUsername: () => "kirie_bot", ...over });
  }

  function dispatch(reg: CommandRegistry, m: UnifiedMessage, source: "channel" | "synthetic" = "channel"): Promise<DispatchOutcome> {
    return reg.dispatch({
      message: m,
      identity: identityFor(m),
      source,
      send: async (r) => {
        sent.push(r);
      },
    });
  }

  describe("register", () => {
    it("throws on a duplicate name", () => {
      const reg = registry();
      reg.register(def());
      expect(() => reg.register(def())).toThrow(/already registered/);
    });

    it("throws when an alias collides with a name or alias", () => {
      const reg = registry();
      reg.register(def({ name: "heartbeat", aliases: ["hb"] }));
      expect(() => reg.register(def({ name: "hb" }))).toThrow(/already registered/);
      expect(() => reg.register(def({ name: "other", aliases: ["heartbeat"] }))).toThrow(/already registered/);
      expect(() => reg.register(def({ name: "third", aliases: ["hb"] }))).toThrow(/already registered/);
    });

    it("leaves nothing behind when registration fails", () => {
      const reg = registry();
      reg.register(def({ name: "a", aliases: ["b"] }));
      expect(() => reg.register(def({ name: "c", aliases: ["d", "b"] }))).toThrow();
      expect(reg.get("c")).toBeUndefined();
      expect(reg.get("d")).toBeUndefined();
    });

    it.each(["Status", "1abc", "a-b", "", "a".repeat(33), "/help"])("rejects bad name %j", (name) => {
      expect(() => registry().register(def({ name }))).toThrow(/Invalid command name/);
    });

    it("rejects bad aliases, descriptions, categories, scopes and handlers", () => {
      const reg = registry();
      expect(() => reg.register(def({ aliases: ["Bad"] }))).toThrow(/Invalid alias/);
      expect(() => reg.register(def({ description: "" }))).toThrow(/description/);
      expect(() => reg.register(def({ description: "x".repeat(257) }))).toThrow(/description/);
      expect(() => reg.register(def({ category: "memory" as never }))).toThrow(/category/);
      expect(() => reg.register(def({ scope: "group" as never }))).toThrow(/scope/);
      expect(() => reg.register(def({ handler: undefined as never }))).toThrow(/handler/);
    });

    it("finds commands by name or alias", () => {
      const reg = registry();
      const d = def({ name: "webhook", aliases: ["webhooks"] });
      reg.registerAll([d]);
      expect(reg.get("webhook")).toBe(d);
      expect(reg.get("/WEBHOOKS")).toBe(d);
    });
  });

  describe("dispatch", () => {
    it("runs an owner-only command for the owner in the DM", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg());
      expect(out).toEqual({ kind: "handled", reply: { text: "ok", plain: true } });
      expect(d.handler).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([{ text: "ok", plain: true }]);
    });

    it("denies an owner-only command for a non-owner without calling the handler", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg({ senderId: STRANGER, chatId: STRANGER }));
      expect(out.kind).toBe("denied");
      expect(out).toMatchObject({ reason: "owner-only", reply: { text: COMMAND_OWNER_ONLY_TEXT } });
      expect(d.handler).not.toHaveBeenCalled();
      expect(sent).toEqual([{ text: COMMAND_OWNER_ONLY_TEXT, plain: true }]);
      expect(commandContinuesToAgent(out)).toBe(false);
    });

    it("denies owner-only commands for everyone when no owner is configured", async () => {
      const reg = registry({ owners: new OwnerDirectory({ telegram: [], discord: [], whatsapp: [], signal: [], slack: [] }) });
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg());
      expect(out).toMatchObject({ kind: "denied", reason: "owner-only" });
      expect(d.handler).not.toHaveBeenCalled();
    });

    it("denies with a null or undefined identity list", async () => {
      const reg = registry({ owners: new OwnerDirectory(undefined) });
      const d = def();
      reg.register(d);
      expect(await dispatch(reg, msg())).toMatchObject({ kind: "denied", reason: "owner-only" });
    });

    it("does not treat an owner of another channel as owner here", async () => {
      const reg = registry({ owners: new OwnerDirectory({ telegram: [], discord: [OWNER], whatsapp: [], signal: [], slack: [] }) });
      const d = def();
      reg.register(d);
      expect(await dispatch(reg, msg())).toMatchObject({ kind: "denied", reason: "owner-only" });
    });

    it("ignores the identity role: owner comes only from the OwnerDirectory", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const m = msg({ senderId: STRANGER, chatId: STRANGER });
      const out = await reg.dispatch({
        message: m,
        identity: { ...identityFor(m), role: "owner" },
        source: "channel",
        send: async () => {},
      });
      expect(out).toMatchObject({ kind: "denied", reason: "owner-only" });
      expect(d.handler).not.toHaveBeenCalled();
    });

    it("treats ownerOnly undefined at runtime as owner-only", async () => {
      const reg = registry();
      const d = def({ ownerOnly: undefined as unknown as boolean });
      reg.register(d);
      const out = await dispatch(reg, msg({ senderId: STRANGER, chatId: STRANGER }));
      expect(out).toMatchObject({ kind: "denied", reason: "owner-only" });
      expect(d.handler).not.toHaveBeenCalled();
      // ...and defaults to DM scope for the owner.
      const inGroup = await dispatch(reg, msg({ chatType: "group", chatId: "-100" }));
      expect(inGroup).toMatchObject({ kind: "denied", reason: "dm-only" });
    });

    it("returns not-command for synthetic text, even from the owner", async () => {
      const reg = registry();
      const d = def({ name: "restart" });
      reg.register(d);
      const out = await dispatch(reg, msg({ text: "/restart" }), "synthetic");
      expect(out).toEqual({ kind: "not-command" });
      expect(d.handler).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(commandContinuesToAgent(out)).toBe(true);
    });

    it("treats any source other than channel as not-command", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg(), "schedule" as never);
      expect(out).toEqual({ kind: "not-command" });
      expect(d.handler).not.toHaveBeenCalled();
    });

    it("ignores edited messages", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg({ isEdited: true }));
      expect(out).toEqual({ kind: "ignored", reason: "edited" });
      expect(d.handler).not.toHaveBeenCalled();
      expect(commandContinuesToAgent(out)).toBe(false);
    });

    it("ignores commands addressed to another bot", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg({ text: "/status@OtherBot" }));
      expect(out).toEqual({ kind: "ignored", reason: "other-bot" });
      expect(d.handler).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it("accepts commands addressed to itself, case-insensitively", async () => {
      const reg = registry();
      reg.register(def());
      expect((await dispatch(reg, msg({ text: "/status@KIRIE_BOT" }))).kind).toBe("handled");
    });

    it("ignores a mention when its own username is unknown", async () => {
      const reg = registry({ selfUsername: undefined });
      reg.register(def());
      expect(await dispatch(reg, msg({ text: "/status@kirie_bot" }))).toEqual({ kind: "ignored", reason: "other-bot" });
    });

    it("denies a dm-scoped command in a group, even for the owner", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg({ chatType: "group", chatId: "-100123" }));
      expect(out).toMatchObject({ kind: "denied", reason: "dm-only", reply: { text: COMMAND_DM_ONLY_TEXT } });
      expect(d.handler).not.toHaveBeenCalled();
    });

    it("requires chatId === senderId for a Telegram DM", async () => {
      const reg = registry();
      const d = def();
      reg.register(d);
      const out = await dispatch(reg, msg({ chatType: "dm", chatId: "999" }));
      expect(out).toMatchObject({ kind: "denied", reason: "dm-only" });
      expect(d.handler).not.toHaveBeenCalled();
    });

    it("allows a public command anywhere for anyone", async () => {
      const reg = registry();
      const d = def({ name: "stop", ownerOnly: false });
      reg.register(d);
      const out = await dispatch(reg, msg({ text: "/stop", senderId: STRANGER, chatType: "group", chatId: "-100" }));
      expect(out.kind).toBe("handled");
      expect(d.handler).toHaveBeenCalledTimes(1);
    });

    it("honours an explicit dm scope on a public command", async () => {
      const reg = registry();
      reg.register(def({ name: "pub", ownerOnly: false, scope: "dm" }));
      const out = await dispatch(reg, msg({ text: "/pub", senderId: STRANGER, chatType: "group", chatId: "-100" }));
      expect(out).toMatchObject({ kind: "denied", reason: "dm-only" });
    });

    it("returns unknown for an unregistered command and lets it continue to the agent", async () => {
      const reg = registry();
      const out = await dispatch(reg, msg({ text: "/skillthing do it" }));
      expect(out).toEqual({ kind: "unknown", name: "skillthing", replied: false });
      expect(commandContinuesToAgent(out)).toBe(true);
      expect(sent).toEqual([]);
    });

    it("answers unknown commands when unknownCommand is reply", async () => {
      const reg = registry({ unknownCommand: "reply" });
      const out = await dispatch(reg, msg({ text: "/nope" }));
      expect(out).toEqual({ kind: "unknown", name: "nope", replied: true });
      expect(commandContinuesToAgent(out)).toBe(false);
      expect(sent[0]!.text).toMatch(/Unknown command \/nope/);
    });

    it("returns not-command for plain text and empty reactions", async () => {
      const reg = registry();
      reg.register(def());
      expect(await dispatch(reg, msg({ text: "hello" }))).toEqual({ kind: "not-command" });
      expect(await dispatch(reg, msg({ text: "" }))).toEqual({ kind: "not-command" });
    });

    it("turns a handler throw into failed with a scrubbed message, never the agent", async () => {
      const reg = registry({ scrub: (t) => t.replace(/sk-[a-z0-9]+/g, "«redacted:test»") });
      reg.register(def({ handler: () => { throw new Error("boom sk-" + "abc123"); } }));
      const out = await dispatch(reg, msg());
      expect(out).toEqual({ kind: "failed", reply: { text: "Command failed: boom «redacted:test»", plain: true } });
      expect(commandContinuesToAgent(out)).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it("sends every reply plain, even when the handler asks otherwise", async () => {
      const reg = registry();
      reg.register(def({ handler: () => ({ text: "*bold*", plain: false }) }));
      await dispatch(reg, msg());
      expect(sent).toEqual([{ text: "*bold*", plain: true }]);
    });

    it("sends nothing for a handler that returns nothing", async () => {
      const reg = registry();
      reg.register(def({ handler: () => undefined }));
      expect(await dispatch(reg, msg())).toEqual({ kind: "handled" });
      expect(sent).toEqual([]);
    });

    it("still returns the outcome when sending the reply fails", async () => {
      const reg = registry();
      reg.register(def());
      const m = msg();
      const out = await reg.dispatch({
        message: m,
        identity: identityFor(m),
        source: "channel",
        send: async () => {
          throw new Error("network down");
        },
      });
      expect(out.kind).toBe("handled");
    });

    it("builds the handler context", async () => {
      const reg = registry();
      let ctx: CommandContext | undefined;
      reg.register(def({ name: "goal", aliases: ["g"], handler: (c) => { ctx = c; } }));
      await dispatch(reg, msg({ text: `/g start "ship it" now` }));
      expect(ctx).toBeDefined();
      expect(ctx!.name).toBe("goal");
      expect(ctx!.args).toBe(`start "ship it" now`);
      expect(ctx!.argv).toEqual(["start", "ship it", "now"]);
      expect(ctx!.isOwner).toBe(true);
      expect(ctx!.sessionKey).toBe(`telegram:dm:${OWNER}`);
      expect(ctx!.identity.senderId).toBe(OWNER);
      await ctx!.reply("extra");
      expect(sent).toContainEqual({ text: "extra", plain: true });
    });

    describe("confirm", () => {
      it("resolves true only when approved, with Confirm / Cancel labels and a 120 s timeout", async () => {
        const requestApproval = vi.fn(async () => ({ outcome: "approved" as const, optionId: "approve", code: "K7Q2" }));
        const reg = registry({ prompts: { requestApproval } });
        let result: boolean | undefined;
        reg.register(def({ handler: async (c) => { result = await c.confirm("Switch to yolo?", "This loosens approvals"); } }));
        await dispatch(reg, msg());
        expect(result).toBe(true);
        expect(requestApproval).toHaveBeenCalledWith({
          kind: "confirm",
          title: "Switch to yolo?",
          body: "This loosens approvals",
          timeoutMs: 120_000,
          labels: { approve: "Confirm", deny: "Cancel" },
        });
      });

      it.each(["denied", "timeout", "cancelled", "unavailable"] as const)("resolves false on %s", async (outcome) => {
        const reg = registry({ prompts: { requestApproval: async () => ({ outcome, optionId: "deny", code: "" }) } });
        let result: boolean | undefined;
        reg.register(def({ handler: async (c) => { result = await c.confirm("x"); } }));
        await dispatch(reg, msg());
        expect(result).toBe(false);
      });

      it("resolves false when prompts are not available", async () => {
        const reg = registry();
        let result: boolean | undefined;
        reg.register(def({ handler: async (c) => { result = await c.confirm("x"); } }));
        await dispatch(reg, msg());
        expect(result).toBe(false);
      });
    });

    describe("audit", () => {
      it("writes one record per owner-only dispatch, with the outcome", async () => {
        const reg = registry();
        reg.register(def({ name: "goal", category: "automation" }));
        await dispatch(reg, msg({ text: "/goal start build it" }));
        await dispatch(reg, msg({ text: "/goal start x", senderId: STRANGER, chatId: STRANGER }));
        const recs = audit.recent({ feature: "commands" });
        expect(recs).toHaveLength(2);
        expect(recs[0]).toMatchObject({ action: "goal", actor: `user:telegram:${STRANGER}`, detail: { outcome: "denied:owner-only" } });
        expect(recs[1]).toMatchObject({
          action: "goal",
          actor: `owner:telegram:${OWNER}`,
          detail: { outcome: "handled", args: "start build it" },
        });
      });

      it("does not record arguments for security and accounts commands", async () => {
        const reg = registry();
        reg.register(def({ name: "approvals", category: "security" }));
        reg.register(def({ name: "accounts", category: "accounts" }));
        await dispatch(reg, msg({ text: "/approvals allow secret-thing" }));
        await dispatch(reg, msg({ text: "/accounts import /path" }));
        for (const r of audit.recent({ feature: "commands" })) {
          expect(r.detail).not.toHaveProperty("args");
        }
      });

      it("does not audit public commands or non-commands", async () => {
        const reg = registry();
        reg.register(def({ name: "stop", ownerOnly: false }));
        await dispatch(reg, msg({ text: "/stop" }));
        await dispatch(reg, msg({ text: "/restart" }), "synthetic");
        expect(audit.recent({ feature: "commands" })).toEqual([]);
      });

      it("records failed dispatches", async () => {
        const reg = registry();
        reg.register(def({ handler: () => { throw new Error("x"); } }));
        await dispatch(reg, msg());
        expect(audit.recent({ feature: "commands" })[0]!.detail).toMatchObject({ outcome: "failed" });
      });
    });
  });

  describe("help and menu", () => {
    function populated(): CommandRegistry {
      const reg = registry();
      reg.register(def({ name: "help", ownerOnly: false, args: "[command]", description: "List commands, or show details for one command" }));
      reg.register(def({ name: "stop", ownerOnly: false, description: "Stop the current reply" }));
      reg.register(def({ name: "restart", description: "Restart the daemon" }));
      reg.register(def({
        name: "heartbeat",
        aliases: ["hb"],
        category: "automation",
        args: "[sub]",
        description: "Control my background checks",
        usage: "Use /heartbeat on or /heartbeat off.",
        subcommands: { on: { description: "Turn on" }, every: { args: "<minutes>", description: "Set the interval" } },
      }));
      reg.register(def({ name: "secretish", category: "security", hidden: true, description: "Hidden owner command" }));
      reg.register(def({ name: "pubhidden", ownerOnly: false, hidden: true, description: "Hidden public command" }));
      return reg;
    }

    it("hides owner commands from non-owners", () => {
      const text = populated().renderHelp({ isOwner: false });
      expect(text).toContain("/help [command] - List commands");
      expect(text).toContain("/stop - Stop the current reply");
      expect(text).toContain("/pubhidden");
      expect(text).not.toContain("/restart");
      expect(text).not.toContain("/heartbeat");
      expect(text).not.toContain("/secretish");
      expect(text).not.toContain("Automation");
    });

    it("shows everything to the owner, grouped by category in fixed order", () => {
      const text = populated().renderHelp({ isOwner: true });
      expect(text).toContain("/restart - Restart the daemon");
      expect(text).toContain("/heartbeat [sub] - Control my background checks");
      expect(text).toContain("/secretish");
      expect(text.indexOf("Core")).toBeLessThan(text.indexOf("Automation"));
      expect(text.indexOf("Automation")).toBeLessThan(text.indexOf("Security"));
    });

    it("prints usage, aliases and subcommands for /help <name>", () => {
      const text = populated().renderHelp({ isOwner: true, topic: "/hb" });
      expect(text).toContain("/heartbeat [sub] - Control my background checks");
      expect(text).toContain("Aliases: /hb");
      expect(text).toContain("Use /heartbeat on or /heartbeat off.");
      expect(text).toContain("every <minutes> - Set the interval");
    });

    it("answers /help <owner command> to a non-owner as unknown", () => {
      const reg = populated();
      expect(reg.renderHelp({ isOwner: false, topic: "restart" })).toBe(reg.renderHelp({ isOwner: false, topic: "doesnotexist" }).replace("doesnotexist", "restart"));
    });

    it("splits the menu: public only by default, everything but hidden for the owner", () => {
      const reg = populated();
      expect(reg.menu({ forOwner: false }).map((e) => e.command)).toEqual(["help", "stop"]);
      expect(reg.menu({ forOwner: true }).map((e) => e.command)).toEqual(["help", "stop", "restart", "heartbeat"]);
    });

    it("caps the menu at 100 entries", () => {
      const reg = registry();
      for (let i = 0; i < 120; i++) reg.register(def({ name: `c${i}`, ownerOnly: false }));
      expect(reg.menu({ forOwner: false })).toHaveLength(100);
    });
  });
});

describe("isDirectMessage", () => {
  it("requires a dm and, for Telegram, the sender's own chat", () => {
    expect(isDirectMessage({ channel: "telegram", chatType: "dm", chatId: "1", senderId: "1" })).toBe(true);
    expect(isDirectMessage({ channel: "telegram", chatType: "dm", chatId: "2", senderId: "1" })).toBe(false);
    expect(isDirectMessage({ channel: "telegram", chatType: "group", chatId: "1", senderId: "1" })).toBe(false);
    expect(isDirectMessage({ channel: "discord", chatType: "dm", chatId: "dm-chan", senderId: "1" })).toBe(true);
  });
});
