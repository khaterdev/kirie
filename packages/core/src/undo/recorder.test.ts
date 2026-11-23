import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, chatCallContext, type SdkCallContext } from "../engine/sdk-options.js";
import { UndoCheckpointStore } from "./checkpoint-store.js";
import { UndoRecorder, UNDO_CONTRIBUTOR_NAME, UNDO_CONTRIBUTOR_ORDER, UNDO_OBSERVER_NAME, undoConfigDirOf } from "./recorder.js";

const KEY = "telegram:dm:1";
let dir: string;
let store: UndoCheckpointStore;
let pipeline: SdkOptionsPipeline;
let enabled: boolean;
let background: boolean;
let recorder: UndoRecorder;

function chatCtx(): SdkCallContext {
  return chatCallContext({ sessionKey: KEY, channel: "telegram", chatType: "dm", senderRole: "owner", cwd: "/work" });
}

function taskCtx(taskId = "task-0001"): SdkCallContext {
  return { kind: "background", sessionKey: KEY, taskId, ownerDm: false, interactive: false, label: "task", cwd: "/work" };
}

function spawn(ctx: SdkCallContext, over: Partial<Options> = {}): Options {
  return pipeline.apply({ cwd: "/work", ...over }, ctx);
}

function assistant(blocks: unknown[], parent: string | null = null, sid = "sid-1"): SDKMessage {
  return { type: "assistant", message: { content: blocks }, parent_tool_use_id: parent, session_id: sid, uuid: "a" } as unknown as SDKMessage;
}

function toolResult(id: string, text: string): SDKMessage {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
    parent_tool_use_id: null,
    session_id: "sid-1",
  } as unknown as SDKMessage;
}

function start(ctx: SdkCallContext, uuid: string, sdkSessionId?: string, accountId: string | null = null): void {
  pipeline.observe({ type: "turn_start", ctx, userMessageUuid: uuid, ...(sdkSessionId ? { sdkSessionId } : {}), accountId });
}

function end(ctx: SdkCallContext, uuid: string, sdkSessionId = "sid-1"): void {
  pipeline.observe({
    type: "turn_end",
    ctx,
    userMessageUuid: uuid,
    sdkSessionId,
    accountId: null,
    result: { isError: false, wasAborted: false, costUsd: 0, numTurns: 1 },
  });
}

const msg = (ctx: SdkCallContext, message: SDKMessage) => pipeline.observe({ type: "message", ctx, message });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-undo-rec-"));
  store = new UndoCheckpointStore(join(dir, "checkpoints.db"));
  pipeline = new SdkOptionsPipeline();
  enabled = true;
  background = true;
  let now = 10_000;
  recorder = new UndoRecorder({
    store,
    isEnabled: () => enabled,
    backgroundTasks: () => background,
    chatPreview: () => "please fix the retry loop",
    taskPreview: (id) => `task ${id}`,
    baseEnv: () => ({}),
    now: () => (now += 1000),
  });
  pipeline.registerContributor(UNDO_CONTRIBUTOR_NAME, recorder.contributor, UNDO_CONTRIBUTOR_ORDER);
  pipeline.registerStreamObserver(UNDO_OBSERVER_NAME, recorder.observer);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("checkpointing contributor", () => {
  it("changes no option while undo is off", () => {
    enabled = false;
    const options = spawn(chatCtx());
    expect(options.enableFileCheckpointing).toBeUndefined();
  });

  it("enables checkpointing for chat and task kinds only", () => {
    expect(spawn(chatCtx()).enableFileCheckpointing).toBe(true);
    expect(spawn(taskCtx()).enableFileCheckpointing).toBe(true);
    expect(spawn({ ...taskCtx(), kind: "goal" }).enableFileCheckpointing).toBe(true);
    expect(spawn({ kind: "utility", ownerDm: false, interactive: false, label: "u", cwd: "/w" }).enableFileCheckpointing).toBeUndefined();
    background = false;
    expect(spawn(taskCtx()).enableFileCheckpointing).toBeUndefined();
  });

  it("reads the config dir from the spawn env, else the daemon env", () => {
    expect(undoConfigDirOf({ CLAUDE_CONFIG_DIR: "/h/.claude2" }, {})).toBe("/h/.claude2");
    expect(undoConfigDirOf({ PATH: "/bin" }, { CLAUDE_CONFIG_DIR: "/h/.claude3" })).toBeNull();
    expect(undoConfigDirOf(undefined, { CLAUDE_CONFIG_DIR: "/h/.claude3" })).toBe("/h/.claude3");
    expect(undoConfigDirOf(undefined, {})).toBeNull();
  });
});

describe("ledger recording", () => {
  it("records a chat turn: uuid, session, account dir, files, created files, shell commands", () => {
    const ctx = chatCtx();
    spawn(ctx, { env: { CLAUDE_CONFIG_DIR: "/h/.claude2" } });
    start(ctx, "u-1", undefined, "acc2");
    msg(ctx, assistant([
      { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/work/new.md", content: "x" } },
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "n1", name: "NotebookEdit", input: { notebook_path: "/work/nb.ipynb" } },
      { type: "tool_use", id: "b1", name: "Bash", input: { command: "git add -A" } },
      { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/work/other.ts" } },
    ]));
    msg(ctx, toolResult("w1", "File created successfully at: /work/new.md"));
    msg(ctx, assistant([{ type: "tool_use", id: "w2", name: "Write", input: { file_path: "/work/a.ts" } }]));
    msg(ctx, toolResult("w2", "The file /work/a.ts has been updated."));
    msg(ctx, assistant([{ type: "tool_use", id: "s1", name: "Edit", input: { file_path: "/work/sub.ts" } }], "task-tool-1"));
    end(ctx, "u-1");

    const row = store.getByUuid("u-1")!;
    expect(row).toMatchObject({
      sessionKey: KEY,
      source: "chat",
      sdkSessionId: "sid-1",
      accountId: "acc2",
      configDir: "/h/.claude2",
      cwd: "/work",
      promptPreview: "please fix the retry loop",
      bashCount: 1,
      bashSamples: ["git add -A"],
      subagentFiles: ["/work/sub.ts"],
    });
    expect(row.filesChanged.sort()).toEqual(["/work/a.ts", "/work/nb.ipynb", "/work/new.md"]);
    expect(row.filesCreated).toEqual(["/work/new.md"]);
    expect(row.completedAt).not.toBeNull();
  });

  it("does not record turns of a process spawned with undo off", () => {
    enabled = false;
    const ctx = chatCtx();
    spawn(ctx);
    enabled = true;
    start(ctx, "u-off", "sid-1");
    msg(ctx, assistant([{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/work/a" } }]));
    end(ctx, "u-off");
    expect(store.count()).toBe(0);
    expect(recorder.liveBinding(KEY)).toEqual({ checkpointing: false, sdkSessionId: null, configDir: null });
  });

  it("does not record a turn without a uuid (v1 string prompt)", () => {
    const ctx = chatCtx();
    spawn(ctx);
    pipeline.observe({ type: "turn_start", ctx, accountId: null });
    expect(store.count()).toBe(0);
  });

  it("fills the SDK session id of a new session from the stream, and tracks the live binding", () => {
    const ctx = chatCtx();
    spawn(ctx);
    start(ctx, "u-new");
    expect(store.getByUuid("u-new")!.sdkSessionId).toBeNull();
    msg(ctx, { type: "system", subtype: "init", session_id: "sid-fresh" } as unknown as SDKMessage);
    expect(store.getByUuid("u-new")!.sdkSessionId).toBe("sid-fresh");
    end(ctx, "u-new", "sid-fresh");
    expect(recorder.liveBinding(KEY)).toEqual({ checkpointing: true, sdkSessionId: "sid-fresh", configDir: null });
  });

  it("uses the resume id as the session id of a resumed process", () => {
    const ctx = chatCtx();
    spawn(ctx, { resume: "sid-old" });
    start(ctx, "u-r");
    expect(store.getByUuid("u-r")!.sdkSessionId).toBe("sid-old");
  });

  it("records task turns under task:<id> with the task description", () => {
    const ctx = taskCtx("task-77");
    spawn(ctx);
    start(ctx, "t-1", "sid-t");
    msg(ctx, assistant([{ type: "tool_use", id: "e", name: "Edit", input: { file_path: "/work/t.ts" } }], null, "sid-t"));
    end(ctx, "t-1", "sid-t");
    expect(store.getByUuid("t-1")).toMatchObject({ source: "task:task-77", promptPreview: "task task-77", filesChanged: ["/work/t.ts"] });
  });

  it("counts every turn start of the chat and of its tasks (the confirm check), recorded or not", () => {
    const ctx = chatCtx();
    expect(recorder.turnEpoch(KEY)).toBe(0);
    start(ctx, "x1");
    start(ctx, "x2");
    start(taskCtx("task-9"), "x3");
    expect(recorder.turnEpoch(KEY)).toBe(3);
    expect(recorder.turnEpoch("telegram:dm:2")).toBe(0);
  });

  it("treats stream activity after turn end as an unsolicited turn: active and counted until its result", () => {
    const ctx = chatCtx();
    spawn(ctx);
    start(ctx, "u1", "sid-1");
    end(ctx, "u1");
    expect(recorder.isStreamActive(KEY)).toBe(false);
    const before = recorder.turnEpoch(KEY);
    msg(ctx, assistant([{ type: "tool_use", id: "late", name: "Edit", input: { file_path: "/work/late.ts" } }]));
    expect(recorder.isStreamActive(KEY)).toBe(true);
    expect(recorder.turnEpoch(KEY)).toBe(before + 1);
    msg(ctx, assistant([{ type: "text", text: "more" }]));
    expect(recorder.turnEpoch(KEY)).toBe(before + 1);
    msg(ctx, { type: "result", subtype: "success", session_id: "sid-1" } as unknown as SDKMessage);
    expect(recorder.isStreamActive(KEY)).toBe(false);
    // the late edit is attributed to the previous turn, which a rewind to its uuid covers
    expect(store.getByUuid("u1")!.filesChanged).toEqual(["/work/late.ts"]);
  });

  it("writes a gap marker for an unrecorded turn only in a session with undo history", () => {
    const off = chatCtx();
    start(off, "g0", "sid-1"); // no history yet: nothing written
    expect(store.count()).toBe(0);
    const on = chatCtx();
    spawn(on);
    start(on, "u1", "sid-1");
    end(on, "u1");
    enabled = false;
    const off2 = chatCtx();
    spawn(off2);
    start(off2, "g1", "sid-1");
    const gap = store.getByUuid("g1")!;
    expect(gap.checkpointed).toBe(false);
    expect(store.recent(KEY, 10).map((r) => r.userMessageUuid)).toEqual(["u1"]);
  });

  it("takes the engine's session id at turn end over one read from the stream", () => {
    const ctx = chatCtx();
    spawn(ctx);
    start(ctx, "u1");
    msg(ctx, { type: "system", subtype: "init", session_id: "sid-stale" } as unknown as SDKMessage);
    end(ctx, "u1", "sid-real");
    expect(store.getByUuid("u1")!.sdkSessionId).toBe("sid-real");
  });

  it("a contributor error never breaks a spawn", () => {
    const broken = new UndoRecorder({
      store,
      isEnabled: () => { throw new Error("settings closed"); },
      backgroundTasks: () => true,
    });
    const options: Options = { cwd: "/w" };
    expect(() => broken.contributor(options, chatCtx())).not.toThrow();
    expect(options.enableFileCheckpointing).toBeUndefined();
  });

  it("scrubs shell samples and keeps three", () => {
    const ctx = chatCtx();
    spawn(ctx);
    start(ctx, "u-s", "sid-1");
    const secret = ["sk", "ant", "api03", "A".repeat(40)].join("-");
    msg(ctx, assistant([
      { type: "tool_use", id: "1", name: "Bash", input: { command: `curl -H "x-api-key: ${secret}" https://example.invalid` } },
      { type: "tool_use", id: "2", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "3", name: "Bash", input: { command: "pwd" } },
      { type: "tool_use", id: "4", name: "Bash", input: { command: "date" } },
    ]));
    const row = store.getByUuid("u-s")!;
    expect(row.bashCount).toBe(4);
    expect(row.bashSamples).toHaveLength(3);
    expect(row.bashSamples.join(" ")).not.toContain(secret);
  });

  it("stops recording after stop()", () => {
    const ctx = chatCtx();
    recorder.stop();
    expect(spawn(ctx).enableFileCheckpointing).toBeUndefined();
    start(ctx, "late", "sid-1");
    expect(store.count()).toBe(0);
  });
});