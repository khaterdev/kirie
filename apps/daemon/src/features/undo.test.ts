import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CommandRegistry,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  UndoCheckpointStore,
  chatCallContext,
  type CommandReply,
  type SdkCallContext,
  type UnifiedMessage,
} from "@kirie/core";
import { setupUndo, renderUndoAddendum } from "./undo.js";
import type { DaemonContext, FeatureHandle } from "./types.js";

const OWNER = "1001";
const KEY = `telegram:dm:${OWNER}`;

interface Harness {
  ctx: DaemonContext;
  sdkOptions: SdkOptionsPipeline;
  heartbeat: EventEmitter;
  addNextTurnNote: ReturnType<typeof vi.fn>;
  historyAppend: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  closeIdleSessions: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
  rewindFiles: ReturnType<typeof vi.fn>;
  /** Session keys currently held through pipeline.holdSession */
  held: string[];
  holdSession: ReturnType<typeof vi.fn>;
}

function harness(dataDir: string, opts: { v2?: boolean; config?: Record<string, unknown> } = {}): Harness {
  const owners = new OwnerDirectory({ telegram: [OWNER] });
  const heartbeat = new EventEmitter();
  const sdkOptions = new SdkOptionsPipeline();
  const addNextTurnNote = vi.fn();
  const historyAppend = vi.fn(() => 1);
  const requestApproval = vi.fn(async () => ({ outcome: "approved", optionId: "approve", code: "K7Q2" }));
  const closeIdleSessions = vi.fn(() => 0);
  const audit = vi.fn();
  const held: string[] = [];
  const holdSession = vi.fn((key: string) => {
    held.push(key);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      held.splice(held.indexOf(key), 1);
    };
  });
  const heldDuringRewind: string[][] = [];
  const rewindFiles = vi.fn(async () => {
    heldDuringRewind.push([...held]);
    return { canRewind: true, filesChanged: [join(dataDir, "a.txt")], insertions: 1, deletions: 1 };
  });
  Object.assign(rewindFiles, { heldDuringRewind });
  const liveQuery = { rewindFiles, close: vi.fn() };
  const v2 = {
    isBusy: () => false,
    getIdleQuery: () => liveQuery,
    closeAndWait: vi.fn(async () => undefined),
    closeIdleSessions,
  };
  const ctx = {
    config: KirieConfigSchema.parse(opts.config ?? {}),
    dataDir,
    agentCwd: dataDir,
    commands: new CommandRegistry({ owners }),
    owners,
    ownerPrompts: { requestApproval },
    settings: new RuntimeSettings(join(dataDir, "state", "runtime-settings.json")),
    audit: { record: audit },
    sdkOptions,
    turnContext: { get: () => ({ origin: "owner_message", startedAt: 0, textPreview: "write a.txt" }) },
    promptAddenda: new PromptAddenda(),
    pipeline: { isBusy: () => false, addNextTurnNote, holdSession },
    heartbeat,
    backgroundTaskStore: { get: () => null, list: () => [] },
    sessionStore: { get: () => "sid-1" },
    chatHistoryStore: { append: historyAppend },
    v2Sessions: opts.v2 === false ? null : v2,
  } as unknown as DaemonContext;
  return { ctx, sdkOptions, heartbeat, addNextTurnNote, historyAppend, requestApproval, closeIdleSessions, audit, rewindFiles, held, holdSession };
}

async function send(ctx: DaemonContext, text: string, senderId = OWNER): Promise<string[]> {
  const replies: string[] = [];
  const message = {
    id: "m1", channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, raw: {},
  } as unknown as UnifiedMessage;
  await ctx.commands.dispatch({
    message,
    identity: { canonicalId: senderId, senderId, role: senderId === OWNER ? "owner" : "user", channel: "telegram" },
    source: "channel",
    send: async (r: CommandReply) => { replies.push(r.text); },
  });
  return replies;
}

function chatCtx(dataDir: string): SdkCallContext {
  return chatCallContext({ sessionKey: KEY, channel: "telegram", chatType: "dm", senderRole: "owner", cwd: dataDir });
}

/** One chat turn through the real pipeline: spawn (apply), turn_start, a Write, turn_end. */
function runTurn(h: Harness, dataDir: string, uuid: string): { enableFileCheckpointing?: boolean } {
  const ctx = chatCtx(dataDir);
  const options = h.sdkOptions.apply({ cwd: dataDir, resume: "sid-1" }, ctx);
  h.sdkOptions.observe({ type: "turn_start", ctx, userMessageUuid: uuid, sdkSessionId: "sid-1", accountId: null });
  h.sdkOptions.observe({
    type: "message",
    ctx,
    message: {
      type: "assistant",
      parent_tool_use_id: null,
      session_id: "sid-1",
      message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: join(dataDir, "a.txt") } }] },
    } as never,
  });
  h.sdkOptions.observe({
    type: "turn_end",
    ctx,
    userMessageUuid: uuid,
    sdkSessionId: "sid-1",
    accountId: null,
    result: { isError: false, wasAborted: false, costUsd: 0, numTurns: 1 },
  });
  return options;
}

describe("setupUndo", () => {
  let dataDir: string;
  let handle: FeatureHandle | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "kirie-undo-feature-"));
    handle = undefined;
  });

  afterEach(async () => {
    await handle?.stop?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("is off by default: no SDK option changes and nothing is recorded", async () => {
    const h = harness(dataDir);
    handle = await setupUndo(h.ctx);
    const options = runTurn(h, dataDir, "u-off");
    expect(options.enableFileCheckpointing).toBeUndefined();
    expect(h.ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toBe("");
    const [reply] = await send(h.ctx, "/undo");
    expect(reply).toContain("Undo is off");
    await handle.stop?.();
    const store = new UndoCheckpointStore(join(dataDir, "checkpoints.db"));
    expect(store.count()).toBe(0);
    store.close();
    handle = undefined;
  });

  it("/undo on records turns; /undo previews, confirms and rewinds on the live query; notes are set once", async () => {
    const h = harness(dataDir);
    handle = await setupUndo(h.ctx);
    await handle.start?.();

    const [on] = await send(h.ctx, "/undo on");
    expect(on).toContain("Undo is on");
    expect(h.closeIdleSessions).toHaveBeenCalledWith(0);
    expect(h.ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toContain("/undo");

    const options = runTurn(h, dataDir, "u-1");
    expect(options.enableFileCheckpointing).toBe(true);

    const [reply] = await send(h.ctx, "/undo");
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    const req = (h.requestApproval.mock.calls[0] as unknown[])[0] as { kind: string; title: string; body: string; timeoutMs: number };
    expect(req.kind).toBe("confirm");
    expect(req.timeoutMs).toBe(120_000);
    expect(req.title).toContain('"write a.txt"');
    expect(req.body).toContain("a.txt");
    expect(h.rewindFiles.mock.calls).toEqual([["u-1", { dryRun: true }], ["u-1", { dryRun: false }]]);
    expect(reply).toContain("Undone.");
    expect(h.addNextTurnNote).toHaveBeenCalledTimes(1);
    expect(h.addNextTurnNote.mock.calls[0]![0]).toBe(KEY);
    expect(h.historyAppend).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(
      expect.arrayContaining(["previewed", "applied"]),
    );

    const [again] = await send(h.ctx, "/undo");
    expect(again).toContain("No turn with file edits");
  });

  it("holds the chat for the dry run and for the rewind, and releases it after each", async () => {
    const h = harness(dataDir);
    handle = await setupUndo(h.ctx);
    await handle.start?.();
    await send(h.ctx, "/undo on");
    runTurn(h, dataDir, "u-1");

    let heldWhileAsking: string[] = [];
    h.requestApproval.mockImplementation(async () => {
      heldWhileAsking = [...h.held];
      return { outcome: "approved", optionId: "approve", code: "K7Q2" };
    });
    const [reply] = await send(h.ctx, "/undo");
    expect(reply).toContain("Undone.");
    const during = (h.rewindFiles as unknown as { heldDuringRewind: string[][] }).heldDuringRewind;
    expect(during).toEqual([[KEY], [KEY]]);
    expect(heldWhileAsking).toEqual([]);
    expect(h.holdSession).toHaveBeenCalledTimes(2);
    expect(h.held).toEqual([]);
  });

  it("releases the hold when the rewind throws", async () => {
    const h = harness(dataDir);
    handle = await setupUndo(h.ctx);
    await handle.start?.();
    await send(h.ctx, "/undo on");
    runTurn(h, dataDir, "u-1");
    h.rewindFiles.mockImplementation(async () => { throw new Error("Failed to rewind"); });
    const [reply] = await send(h.ctx, "/undo");
    expect(reply).toMatch(/cannot undo/i);
    expect(h.holdSession).toHaveBeenCalled();
    expect(h.held).toEqual([]);
  });

  it("a stranger cannot run /undo", async () => {
    const h = harness(dataDir);
    handle = await setupUndo(h.ctx);
    const [reply] = await send(h.ctx, "/undo on", "2002");
    expect(reply).not.toContain("Undo is on");
    expect(h.ctx.settings.keys("undo")).toEqual([]);
  });

  it("v1 mode: only the command, answering that v2 is needed; no ledger file", async () => {
    const h = harness(dataDir, { v2: false, config: { undo: { enabled: true } } });
    handle = await setupUndo(h.ctx);
    const options = runTurn(h, dataDir, "u-v1");
    expect(options.enableFileCheckpointing).toBeUndefined();
    expect(await send(h.ctx, "/undo")).toEqual(["Undo needs agent.sessionMode v2."]);
    expect(existsSync(join(dataDir, "checkpoints.db"))).toBe(false);
  });

  it("prunes the ledger at start and once a day on the heartbeat", async () => {
    const seed = new UndoCheckpointStore(join(dataDir, "checkpoints.db"));
    seed.insert({
      sessionKey: KEY, sdkSessionId: "s", userMessageUuid: "ancient", accountId: null, configDir: null, cwd: "/", source: "chat",
      promptPreview: null, createdAt: Date.now() - 30 * 86_400_000,
    });
    seed.close();
    const h = harness(dataDir, { config: { undo: { enabled: true } } });
    handle = await setupUndo(h.ctx);
    await handle.start?.();
    runTurn(h, dataDir, "fresh");
    await handle.stop?.();
    handle = undefined;
    const store = new UndoCheckpointStore(join(dataDir, "checkpoints.db"));
    expect(store.getByUuid("ancient")).toBeNull();
    expect(store.getByUuid("fresh")).not.toBeNull();
    store.close();
  });

  it("stops recording after stop()", async () => {
    const h = harness(dataDir, { config: { undo: { enabled: true } } });
    handle = await setupUndo(h.ctx);
    await handle.stop?.();
    handle = undefined;
    const options = runTurn(h, dataDir, "late");
    expect(options.enableFileCheckpointing).toBeUndefined();
  });

  it("the addendum is for the owner's DM chat only, while undo is on", () => {
    expect(renderUndoAddendum(true, { kind: "chat", ownerDm: true })).toContain("Bash");
    expect(renderUndoAddendum(true, { kind: "chat", ownerDm: false })).toBeNull();
    expect(renderUndoAddendum(true, { kind: "background", ownerDm: false })).toBeNull();
    expect(renderUndoAddendum(false, { kind: "chat", ownerDm: true })).toBeNull();
  });
});
