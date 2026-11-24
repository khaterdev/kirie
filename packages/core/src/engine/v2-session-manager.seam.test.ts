import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Scripted streaming-input mock. Each pushed user message picks a script by
 * keyword: LIMIT (returned limit error result), WEIRD (unclassified error
 * result), THROW (stream throws a limit error), SUBAGENT (an intermediate
 * result, then the subagent's findings later with no turn pending).
 */
const recorded = vi.hoisted(() => ({
  userMessages: [] as Array<{ uuid?: string; message: { content: string } }>,
  options: [] as Array<Record<string, unknown>>,
  counter: 0,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const LIMIT = "You've hit your session limit · resets 4am (Africa/Cairo)";
  return {
    query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> & { resume?: string } }) => {
      recorded.options.push(options);
      const sessionId = options.resume ?? `sess-${++recorded.counter}`;
      const base = { session_id: sessionId, uuid: "m", parent_tool_use_id: null };
      const result = (text: string, isError = false, extra: Record<string, unknown> = {}) => ({
        type: "result", subtype: "success", result: text, is_error: isError, total_cost_usd: 0.01, num_turns: 1,
        duration_ms: 1, duration_api_ms: 1, stop_reason: null, usage: {}, modelUsage: {}, permission_denials: [], ...base, ...extra,
      });
      const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
        type: "assistant", message: { model: "claude-test-model", content: [{ type: "text", text }] }, ...base, ...extra,
      });

      const stream = (async function* () {
        for await (const raw of prompt) {
          const msg = raw as { uuid?: string; message: { content: string } };
          recorded.userMessages.push(msg);
          const content = msg.message.content;
          if (content.includes("THROW")) {
            throw new Error(`Claude Code returned an error result: ${LIMIT}`);
          } else if (content.includes("LIMIT")) {
            yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1791915000, rateLimitType: "five_hour" }, ...base };
            yield assistant(LIMIT, { error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: LIMIT }] } });
            yield result(LIMIT, true, { api_error_status: 429 });
          } else if (content.includes("SLOW")) {
            await new Promise((r) => setTimeout(r, 200));
            yield assistant("slow ok");
            yield result("slow ok");
          } else if (content.includes("WEIRD")) {
            yield result("something odd", true);
          } else if (content.includes("SUBAGENT")) {
            yield assistant("Waiting for the agent...");
            yield result("Waiting for the agent...");
            await new Promise((r) => setTimeout(r, 30));
            yield assistant("Agent findings");
            yield result("Agent findings");
          } else {
            yield assistant("ok");
            yield result("ok");
          }
        }
      })();

      return Object.assign(stream, {
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(() => {
          void stream.return(undefined);
        }),
      });
    }),
  };
});

import { SessionStore } from "./session-store.js";
import { V2SessionManager } from "./v2-session-manager.js";
import { SdkOptionsPipeline, type SdkStreamEvent } from "./sdk-options.js";
import { failureOf } from "./failure.js";
import type { ExecutionResult, IncomingMessage } from "./agent-engine.js";
import type { SenderIdentity } from "./prompt-builder.js";

const owner: SenderIdentity = { name: "Owner", platformId: "1", role: "owner" };

function msg(text: string, chatId = "1"): IncomingMessage {
  return { id: `m-${Math.random()}`, channel: "telegram", senderName: "Owner", senderId: "1", text, chatType: "dm", chatId };
}

describe("V2SessionManager with the SDK options seam", () => {
  let dir: string;
  let store: SessionStore;
  let sdkOptions: SdkOptionsPipeline;
  let events: SdkStreamEvent[];
  let manager: V2SessionManager;
  const key = "telegram:dm:1";

  beforeEach(() => {
    recorded.userMessages.length = 0;
    recorded.options.length = 0;
    dir = mkdtempSync(join(tmpdir(), "kirie-v2-seam-"));
    store = new SessionStore(join(dir, "sessions.db"));
    sdkOptions = new SdkOptionsPipeline();
    events = [];
    sdkOptions.registerStreamObserver("test", (ev) => events.push(ev));
    manager = new V2SessionManager(store, { workspacePath: dir, model: "claude-test", sdkOptions });
  });

  afterEach(async () => {
    await manager.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a schedule turn after the owner's message resumes the session as not ownerDm, and back (CORE-N2)", async () => {
    await manager.execute(msg("hello"), { ...owner, origin: "owner_message" });
    await manager.execute(msg("scheduled check"), { ...owner, origin: "schedule" });
    await manager.execute(msg("again"), { ...owner, origin: "owner_message" });
    await manager.execute(msg("and again"), { ...owner, origin: "owner_message" });
    const starts = events.filter((e) => e.type === "turn_start").map((e) => e.ctx.ownerDm);
    expect(starts).toEqual([true, false, true, true]);
    // Three processes: the context changed twice; each resumes the same conversation.
    expect(recorded.options).toHaveLength(3);
    expect(recorded.options.slice(1).map((o) => o.resume)).toEqual([store.get(key), store.get(key)]);
  });

  it("keeps the session and its mapping after a returned limit error, with no fresh retry", async () => {
    await manager.execute(msg("hello"), owner);
    const mapped = store.get(key);
    expect(mapped).toBeTruthy();

    const result = await manager.execute(msg("LIMIT please"), owner);

    expect(result.isError).toBe(true);
    expect(result.failure?.class).toBe("usage_limit_account");
    expect(result.failure?.resetAtMs).toBe(1791915000 * 1000);
    expect(recorded.options).toHaveLength(1);
    expect(store.get(key)).toBe(mapped);
    expect(manager.hasSession(key)).toBe(true);
  });

  it("a thrown limit error rejects with its classification and keeps the mapping", async () => {
    await manager.execute(msg("hello"), owner);
    const mapped = store.get(key);

    const err = await manager.execute(msg("THROW"), owner).catch((e: unknown) => e);

    expect(failureOf(err)?.class).toBe("usage_limit_account");
    expect(store.get(key)).toBe(mapped);
  });

  it("still retries in a fresh session after an unclassified error result (today's behaviour)", async () => {
    await manager.execute(msg("hello"), owner);
    const result = await manager.execute(msg("WEIRD then fine"), owner);
    // The retry re-sends the same text, which the mock answers WEIRD again.
    expect(recorded.options).toHaveLength(2);
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it("stamps a uuid on every pushed message and returns it with the result", async () => {
    const a = await manager.execute(msg("one"), owner);
    const b = await manager.execute(msg("two"), owner);
    expect(recorded.userMessages).toHaveLength(2);
    const [u1, u2] = recorded.userMessages.map((m) => m.uuid);
    expect(u1).toMatch(/^[0-9a-f-]{36}$/);
    expect(u2).toMatch(/^[0-9a-f-]{36}$/);
    expect(u1).not.toBe(u2);
    expect(a.userMessageUuid).toBe(u1);
    expect(b.userMessageUuid).toBe(u2);
    expect(a.model).toBe("claude-test-model");
    expect(a.accountId).toBeNull();
  });

  it("emits turn_start, every message, then turn_end, in order", async () => {
    await manager.execute(msg("one"), owner);
    expect(events.map((e) => e.type)).toEqual(["turn_start", "message", "message", "turn_end"]);
    const uuid = recorded.userMessages[0]!.uuid;
    const start = events[0]!;
    const end = events[3]!;
    expect(start.type === "turn_start" && start.userMessageUuid).toBe(uuid);
    expect(end.type === "turn_end" && end.userMessageUuid).toBe(uuid);
    expect(end.type === "turn_end" && end.result).toMatchObject({ isError: false, wasAborted: false, model: "claude-test-model" });
    expect(start.ctx).toMatchObject({ kind: "chat", sessionKey: key, ownerDm: true, interactive: true, cwd: dir });
  });

  it("applies the pipeline when the session starts: one hook and canUseTool, yolo unchanged", async () => {
    await manager.execute(msg("one"), owner);
    const options = recorded.options[0] as { hooks: { PreToolUse: unknown[] }; canUseTool: unknown; permissionMode: string; disallowedTools?: string[] };
    expect(options.hooks.PreToolUse).toHaveLength(1);
    expect(options.canUseTool).toBeTypeOf("function");
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.disallowedTools).toBeUndefined();
  });

  it("delivers a result that arrives with no turn pending to the unsolicited handler", async () => {
    const unsolicited: Array<[string, ExecutionResult]> = [];
    manager.setUnsolicitedResultHandler((k, r) => unsolicited.push([k, r]));

    const first = await manager.execute(msg("SUBAGENT go"), owner);
    expect(first.response).toBe("Waiting for the agent...");

    await vi.waitFor(() => expect(unsolicited).toHaveLength(1), { timeout: 2000 });
    expect(unsolicited[0]![0]).toBe(key);
    expect(unsolicited[0]![1]).toMatchObject({ response: "Agent findings", isError: false });
    expect(unsolicited[0]![1].userMessageUuid).toBeUndefined();
    const lastEnd = events.filter((e) => e.type === "turn_end").pop()!;
    expect(lastEnd.type === "turn_end" && lastEnd.userMessageUuid).toBeUndefined();
  });

  it("closing a session mid-turn ends the open turn (turn_start and turn_end stay paired)", async () => {
    const pending = manager.execute(msg("SLOW"), owner).catch((e: unknown) => e);
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_start")).toBe(true));
    manager.closeSession(key);
    expect(await pending).toBeInstanceOf(Error);
    await new Promise((r) => setTimeout(r, 250));
    const starts = events.filter((e) => e.type === "turn_start");
    const ends = events.filter((e) => e.type === "turn_end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.type === "turn_end" && ends[0]!.result.wasAborted).toBe(true);
  });

  it("isBusy and getIdleQuery reflect a turn in flight", async () => {
    expect(manager.isBusy(key)).toBe(false);
    expect(manager.getIdleQuery(key)).toBeUndefined();
    const pending = manager.execute(msg("one"), owner);
    expect(manager.isBusy(key)).toBe(true);
    expect(manager.getIdleQuery(key)).toBeUndefined();
    await pending;
    expect(manager.isBusy(key)).toBe(false);
    expect(manager.getIdleQuery(key)).toBeDefined();
  });

  it("closeAndWait closes the session and waits for its stream to end; the mapping is kept", async () => {
    await manager.execute(msg("one"), owner);
    const mapped = store.get(key);
    await manager.closeAndWait(key, 1000);
    expect(manager.hasSession(key)).toBe(false);
    expect(store.get(key)).toBe(mapped);
    await manager.closeAndWait("telegram:dm:none");
  });

  it("closeIdleSessions(0) closes every session that is not busy", async () => {
    await manager.execute(msg("one", "1"), owner);
    await manager.execute(msg("two", "2"), owner);
    expect(manager.activeSessionCount).toBe(2);
    expect(manager.closeIdleSessions(0)).toBe(2);
    expect(manager.activeSessionCount).toBe(0);
  });
});
