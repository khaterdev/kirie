import { describe, it, expect, vi, beforeEach } from "vitest";
import { CommandRegistry, COMMAND_OWNER_ONLY_TEXT, COMMAND_DM_ONLY_TEXT } from "../registry.js";
import { OwnerDirectory } from "../../interaction/owners.js";
import { createCoreCommands, type CoreCommandDeps } from "./core.js";
import type { CommandReply } from "../types.js";
import type { UnifiedMessage, ChannelName } from "../../channels/normalizer.js";
import type { ResolvedIdentity } from "../../security/auth.js";
import type { ChannelAdapter } from "../../channels/adapter.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    id: "10", channel: "telegram" as ChannelName, senderId: OWNER, senderName: "Owner",
    text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over,
  } as UnifiedMessage;
}

function identity(senderId: string, role: ResolvedIdentity["role"] = "user"): ResolvedIdentity {
  return { canonicalId: senderId, senderId, role, channel: "telegram" } as ResolvedIdentity;
}

describe("built-in core commands", () => {
  let registry: CommandRegistry;
  let deps: CoreCommandDeps;
  let replies: CommandReply[];
  let onRestart: ReturnType<typeof vi.fn>;
  let cancelAll: ReturnType<typeof vi.fn>;
  let abortAll: ReturnType<typeof vi.fn>;
  let answerByCode: ReturnType<typeof vi.fn>;

  async function run(text: string, over: Partial<UnifiedMessage> = {}) {
    replies = [];
    const message = msg(text, over);
    const outcome = await registry.dispatch({
      message,
      identity: identity(message.senderId, message.senderId === OWNER ? "owner" : "user"),
      source: "channel",
      send: async (r) => { replies.push(r); },
    });
    return { outcome, texts: replies.map((r) => r.text) };
  }

  beforeEach(() => {
    vi.useRealTimers();
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }) });
    onRestart = vi.fn();
    cancelAll = vi.fn(async () => 2);
    abortAll = vi.fn(() => 1);
    answerByCode = vi.fn(() => "ok");
    deps = {
      help: registry,
      channelRegistry: {
        getRunning: () => ["telegram"],
        getAll: () => new Map([["telegram", { getStatus: () => ({ state: "connected" }) } as unknown as ChannelAdapter]]),
        isRunning: () => true,
      } as unknown as CoreCommandDeps["channelRegistry"],
      sessionStore: {
        count: () => 3,
        listAll: () => ["telegram:dm:1001"],
        getRow: () => undefined,
      } as unknown as CoreCommandDeps["sessionStore"],
      pipeline: { abortSession: vi.fn(() => true), abortAll, clearSession: vi.fn() },
      backgroundTaskManager: { cancelAll },
      onRestart,
      prompts: {
        pending: () => [{ code: "K7Q2", kind: "approval", title: "Run rm -rf build", expiresAt: Date.now() + 120_000, options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }] }],
        answerByCode,
      },
    };
    registry.registerAll(createCoreCommands(deps));
  });

  it("registers the ten migrated commands plus the four prompt commands with the B.12 flags", () => {
    const flags = Object.fromEntries(registry.list().map((d) => [d.name, { ownerOnly: d.ownerOnly, scope: d.scope ?? (d.ownerOnly ? "dm" : "any") }]));
    expect(flags).toEqual({
      help: { ownerOnly: false, scope: "any" },
      status: { ownerOnly: true, scope: "dm" },
      sessions: { ownerOnly: true, scope: "dm" },
      channels: { ownerOnly: true, scope: "dm" },
      stop: { ownerOnly: false, scope: "any" },
      stopall: { ownerOnly: true, scope: "dm" },
      clear: { ownerOnly: false, scope: "any" },
      restart: { ownerOnly: true, scope: "dm" },
      context: { ownerOnly: false, scope: "any" },
      usage: { ownerOnly: true, scope: "dm" },
      pending: { ownerOnly: true, scope: "dm" },
      approve: { ownerOnly: true, scope: "dm" },
      deny: { ownerOnly: true, scope: "dm" },
      answer: { ownerOnly: true, scope: "dm" },
    });
  });

  it("/restart and /stopall are owner-only: a stranger is refused and nothing runs", async () => {
    for (const text of ["/restart", "/stopall"]) {
      const { outcome, texts } = await run(text, { senderId: STRANGER, chatId: STRANGER });
      expect(outcome.kind).toBe("denied");
      expect(texts).toEqual([COMMAND_OWNER_ONLY_TEXT]);
    }
    await new Promise((r) => setImmediate(r));
    expect(onRestart).not.toHaveBeenCalled();
    expect(abortAll).not.toHaveBeenCalled();
    expect(cancelAll).not.toHaveBeenCalled();
  });

  it("/restart for the owner replies first, then restarts", async () => {
    const { outcome, texts } = await run("/restart");
    expect(outcome.kind).toBe("handled");
    expect(texts).toEqual(["Restarting Kirie daemon... I'll be back in a moment."]);
    expect(onRestart).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("/restart in a group is refused even for the owner (DM only)", async () => {
    const { texts } = await run("/restart", { chatType: "group", chatId: "-100" });
    expect(texts).toEqual([COMMAND_DM_ONLY_TEXT]);
  });

  it("/stopall keeps its old text for the owner", async () => {
    const { texts } = await run("/stopall");
    expect(texts).toEqual(["Stopped 1 running agent.\nCancelled 2 background tasks."]);
  });

  it("/status, /sessions keep their old texts for the owner", async () => {
    expect((await run("/status")).texts[0]).toMatch(/^System Status\n {2}Uptime: \d+h \d+m \d+s\n {2}Active sessions: 3\n {2}Running channels: telegram$/);
    expect((await run("/sessions")).texts).toEqual(["Active sessions (1):\n  telegram:dm:1001"]);
    expect((await run("/channels")).texts).toEqual(["Channels:\n  telegram: connected (running)"]);
  });

  it("/stop, /clear, /context are public and act on the caller's own chat", async () => {
    expect((await run("/stop", { senderId: STRANGER, chatId: STRANGER })).texts).toEqual(["Stopped the running agent for this chat."]);
    expect(deps.pipeline!.abortSession).toHaveBeenCalledWith(`telegram:dm:${STRANGER}`);
    expect((await run("/clear", { senderId: STRANGER, chatId: STRANGER })).texts).toEqual(["Chat context cleared. Next message starts a fresh conversation."]);
    expect(deps.pipeline!.clearSession).toHaveBeenCalledWith(`telegram:dm:${STRANGER}`);
    const ctx = (await run("/context", { senderId: STRANGER, chatId: STRANGER })).texts[0]!;
    expect(ctx).toContain(`Session: telegram:dm:${STRANGER}`);
  });

  it("/help hides owner commands from non-owners and lists them for the owner", async () => {
    const stranger = (await run("/help", { senderId: STRANGER, chatId: STRANGER })).texts[0]!;
    expect(stranger).toContain("/help");
    expect(stranger).toContain("/stop");
    for (const hidden of ["/restart", "/stopall", "/status", "/usage", "/pending", "/approve"]) {
      expect(stranger).not.toContain(`${hidden} `);
    }
    const owner = (await run("/help")).texts[0]!;
    expect(owner).toContain("/restart - Restart the daemon");
    expect(owner).toContain("/approve <code> - Approve a pending request by its code");
    expect((await run("/help restart", { senderId: STRANGER, chatId: STRANGER })).texts[0]).toContain("Unknown command");
  });

  it("the default-scope menu contains no owner command", () => {
    const publicMenu = registry.menu({ forOwner: false }).map((m) => m.command);
    expect(publicMenu.sort()).toEqual(["clear", "context", "help", "stop"]);
    expect(registry.menu({ forOwner: true })).toHaveLength(14);
  });

  it("/pending lists codes and options; /approve, /deny, /answer call answerByCode", async () => {
    const pending = (await run("/pending")).texts[0]!;
    expect(pending).toContain("K7Q2  Run rm -rf build");
    expect(pending).toContain("approve (Approve), deny (Deny)");
    expect((await run("/approve k7q2")).texts).toEqual(["Approved K7Q2."]);
    expect(answerByCode).toHaveBeenLastCalledWith("K7Q2", "approve", { channel: "telegram", senderId: OWNER });
    expect((await run("/deny K7Q2")).texts).toEqual(["Denied K7Q2."]);
    expect(answerByCode).toHaveBeenLastCalledWith("K7Q2", "deny", { channel: "telegram", senderId: OWNER });
    answerByCode.mockReturnValueOnce("bad-option");
    expect((await run("/answer K7Q2 maybe")).texts[0]).toContain("no such option");
    answerByCode.mockReturnValueOnce("not-found");
    expect((await run("/approve ZZZZ")).texts[0]).toContain("No pending request");
    expect((await run("/approve")).texts[0]).toContain("Usage");
    expect((await run("/approve K7Q2", { senderId: STRANGER, chatId: STRANGER })).texts).toEqual([COMMAND_OWNER_ONLY_TEXT]);
  });
});
