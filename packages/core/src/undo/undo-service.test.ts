import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Options, Query, RewindFilesResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { UndoConfigSchema, type UndoConfig } from "../config/sections/undo.js";
import { SdkOptionsPipeline } from "../engine/sdk-options.js";
import { UndoCheckpointStore } from "./checkpoint-store.js";
import type { UndoLiveBinding } from "./recorder.js";
import { UndoService, formatUndoTime, undoRewindEnv, UNDO_BUSY_TEXT, UNDO_NEEDS_V2_TEXT, type UndoServiceDeps } from "./undo-service.js";

const KEY = "telegram:dm:1";

interface FakeQuery {
  q: Query;
  rewindFiles: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeQuery(impl: (uuid: string, opts?: { dryRun?: boolean }) => Promise<RewindFilesResult>): FakeQuery {
  const rewindFiles = vi.fn(impl);
  const close = vi.fn();
  const q = {
    rewindFiles,
    close,
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) };
    },
  } as unknown as Query;
  return { q, rewindFiles, close };
}

const ok = (files: string[], extra: Partial<RewindFilesResult> = {}): RewindFilesResult => ({
  canRewind: true,
  filesChanged: files,
  insertions: 3,
  deletions: 4,
  ...extra,
});

let dir: string;
let store: UndoCheckpointStore;
let now: number;
let epoch: number;
let binding: UndoLiveBinding | undefined;
let busy: boolean;
let enabled: boolean;
let config: UndoConfig;
let liveQuery: FakeQuery | undefined;
let tempQueries: Array<{ fake: FakeQuery; options: Options; prompt: AsyncIterable<SDKUserMessage> }>;
let tempImpl: (uuid: string, opts?: { dryRun?: boolean }) => Promise<RewindFilesResult>;
let closeAndWait: ReturnType<typeof vi.fn>;
let notes: Array<[string, string]>;
let history: Array<[string, string]>;
let mtimes: Record<string, number>;
let taskStatus: string | null;

function service(over: Partial<UndoServiceDeps> = {}): UndoService {
  return new UndoService({
    store,
    recorder: { turnEpoch: () => epoch, liveBinding: () => binding },
    config: () => config,
    isEnabled: () => enabled,
    isChatBusy: () => busy,
    v2: { getIdleQuery: () => liveQuery?.q, closeAndWait },
    taskStatus: () => taskStatus,
    query: ({ prompt, options }) => {
      const fake = fakeQuery(tempImpl);
      tempQueries.push({ fake, options, prompt });
      return fake.q;
    },
    baseEnv: () => ({ PATH: "/bin", ANTHROPIC_API_KEY: "synthetic", CLAUDE_CONFIG_DIR: "/h/.claude9" }),
    now: () => now,
    mtimeOf: (p) => mtimes[p] ?? null,
    addNextTurnNote: (k, n) => notes.push([k, n]),
    appendHistory: (k, t) => history.push([k, t]),
    rewindTimeoutMs: 50,
    ...over,
  });
}

/** Seed a finished turn. */
function turn(opts: {
  uuid: string;
  sid?: string | null;
  configDir?: string | null;
  accountId?: string | null;
  files?: string[];
  created?: string[];
  sub?: string[];
  bash?: string[];
  source?: string;
  at?: number;
}): number {
  const at = opts.at ?? now;
  const id = store.insert({
    sessionKey: KEY,
    sdkSessionId: opts.sid === undefined ? "sid-1" : opts.sid,
    userMessageUuid: opts.uuid,
    accountId: opts.accountId ?? null,
    configDir: opts.configDir ?? null,
    cwd: "/work",
    source: opts.source ?? "chat",
    promptPreview: `prompt ${opts.uuid}`,
    createdAt: at,
  });
  store.setActivity(id, {
    filesChanged: opts.files ?? [],
    filesCreated: opts.created ?? [],
    subagentFiles: opts.sub ?? [],
    bashCount: opts.bash?.length ?? 0,
    bashSamples: opts.bash ?? [],
  });
  store.complete(id, at + 500);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-undo-svc-"));
  store = new UndoCheckpointStore(join(dir, "checkpoints.db"));
  now = 1_700_000_000_000;
  epoch = 3;
  binding = undefined;
  busy = false;
  enabled = true;
  config = UndoConfigSchema.parse({ enabled: true });
  liveQuery = undefined;
  tempQueries = [];
  tempImpl = async () => ok(["/work/a.ts"]);
  closeAndWait = vi.fn(async () => undefined);
  notes = [];
  history = [];
  mtimes = {};
  taskStatus = null;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("UndoService.preview", () => {
  it("runs a dry run and changes nothing", async () => {
    const id = turn({ uuid: "u1", files: ["/work/a.ts"], bash: ["pnpm test"] });
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    expect(res.status).toBe("ready");
    if (res.status !== "ready") return;
    expect(tempQueries).toHaveLength(1);
    expect(tempQueries[0]!.fake.rewindFiles).toHaveBeenCalledWith("u1", { dryRun: true });
    expect(res.plan.restore).toEqual(["/work/a.ts"]);
    expect(res.plan.bashCount).toBe(1);
    expect(store.get(id)!.undoneAt).toBeNull();
    expect(notes).toEqual([]);
    expect(history).toEqual([]);
  });

  it("opens the temporary query with resume, checkpointing, the turn's config dir and a never-yielding prompt, and closes it", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"], configDir: "/h/.claude2", accountId: "acc2", sid: "sid-xyz" });
    const pipeline = new SdkOptionsPipeline();
    const applySpy = vi.spyOn(pipeline, "apply");
    await service({ sdkOptions: pipeline }).preview({ kind: "chat", sessionKey: KEY });
    const { options, prompt, fake } = tempQueries[0]!;
    expect(options.resume).toBe("sid-xyz");
    expect(options.enableFileCheckpointing).toBe(true);
    expect(options.cwd).toBe("/work");
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe("/h/.claude2");
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    expect(options.settingSources).toEqual([]);
    expect(applySpy.mock.calls[0]![1]).toMatchObject({ kind: "utility", interactive: false });
    expect(prompt).toBeDefined();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("the temporary query's prompt yields no message before or during the rewind", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    type Seen = IteratorResult<SDKUserMessage> | "pending";
    let yielded: Seen = "pending";
    let atRewind: Seen | undefined;
    const svc = service({
      query: ({ prompt }) => {
        void prompt[Symbol.asyncIterator]().next().then((r) => {
          yielded = r;
        });
        return fakeQuery(async () => {
          await new Promise((r) => setTimeout(r, 10));
          atRewind = yielded;
          return ok(["/work/a.ts"]);
        }).q;
      },
    });
    await svc.preview({ kind: "chat", sessionKey: KEY });
    expect(atRewind).toBe("pending");
    await new Promise((r) => setTimeout(r, 0));
    // ended (not a message) once the query is done
    expect(yielded).toEqual({ value: undefined, done: true });
  });

  it("uses the default login (no CLAUDE_CONFIG_DIR) for a default-account turn", () => {
    expect(undoRewindEnv({ accountId: "default", configDir: null }, { CLAUDE_CONFIG_DIR: "/x", PATH: "/bin" })).toEqual({ PATH: "/bin" });
    // ambient turn: the daemon env is kept apart from the config dir
    expect(undoRewindEnv({ accountId: null, configDir: "/h/.c3" }, { ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/x" })).toEqual({
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CONFIG_DIR: "/h/.c3",
    });
  });

  it("reuses the idle live query when it is bound to the same session and config dir, with no query() call", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"], configDir: "/h/.claude2" });
    liveQuery = fakeQuery(async () => ok(["/work/a.ts"]));
    binding = { checkpointing: true, sdkSessionId: "sid-1", configDir: "/h/.claude2" };
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    expect(res.status).toBe("ready");
    expect(liveQuery.rewindFiles).toHaveBeenCalledWith("u1", { dryRun: true });
    expect(liveQuery.close).not.toHaveBeenCalled();
    expect(tempQueries).toHaveLength(0);
    expect(closeAndWait).not.toHaveBeenCalled();
  });

  it("closes a live session on another account before opening the temporary query", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"], configDir: null });
    liveQuery = fakeQuery(async () => ok([]));
    binding = { checkpointing: true, sdkSessionId: "sid-1", configDir: "/h/.claude2" };
    await service().preview({ kind: "chat", sessionKey: KEY });
    expect(closeAndWait).toHaveBeenCalledWith(KEY, expect.any(Number));
    expect(liveQuery.rewindFiles).not.toHaveBeenCalled();
    expect(tempQueries).toHaveLength(1);
    expect(tempQueries[0]!.options.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("closes a live session spawned without checkpointing, and leaves a live session on another SDK session alone", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    liveQuery = fakeQuery(async () => ok([]));
    binding = { checkpointing: false, sdkSessionId: null, configDir: null };
    await service().preview({ kind: "chat", sessionKey: KEY });
    expect(closeAndWait).toHaveBeenCalledTimes(1);

    closeAndWait.mockClear();
    binding = { checkpointing: true, sdkSessionId: "sid-after-clear", configDir: null };
    await service().preview({ kind: "chat", sessionKey: KEY });
    expect(closeAndWait).not.toHaveBeenCalled();
  });

  it("refuses while a turn is in flight, without opening a query", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    busy = true;
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    expect(res).toEqual({ status: "refused", message: UNDO_BUSY_TEXT });
    expect(tempQueries).toHaveLength(0);
  });

  it("refuses in v1 mode and while undo is off", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    expect(await service({ v2: null }).preview({ kind: "chat", sessionKey: KEY })).toEqual({ status: "refused", message: UNDO_NEEDS_V2_TEXT });
    enabled = false;
    expect((await service().preview({ kind: "chat", sessionKey: KEY })).status).toBe("refused");
  });

  it("refuses a multi-turn undo across two session ids or config dirs and names the largest valid count", async () => {
    turn({ uuid: "old", files: ["/work/o"], sid: "sid-0" });
    turn({ uuid: "mid", files: ["/work/m"], sid: "sid-1" });
    turn({ uuid: "new", files: ["/work/n"], sid: "sid-1" });
    const res = await service().preview({ kind: "chat", sessionKey: KEY }, 3);
    expect(res.status).toBe("refused");
    if (res.status === "refused") expect(res.message).toContain("/undo 2");
    expect(tempQueries).toHaveLength(0);

    turn({ uuid: "newest", files: ["/work/x"], sid: "sid-1", configDir: "/h/.claude2" });
    const res2 = await service().preview({ kind: "chat", sessionKey: KEY }, 2);
    expect(res2.status).toBe("refused");
    if (res2.status === "refused") expect(res2.message).toContain("/undo 1");
  });

  it("targets the oldest selected turn and skips turns without file edits", async () => {
    turn({ uuid: "t1", files: ["/work/a"] });
    turn({ uuid: "t2", bash: ["ls"] });
    turn({ uuid: "t3", files: ["/work/b"] });
    tempImpl = async () => ok(["/work/a", "/work/b"]);
    const res = await service().preview({ kind: "chat", sessionKey: KEY }, 2);
    expect(res.status).toBe("ready");
    expect(tempQueries[0]!.fake.rewindFiles).toHaveBeenCalledWith("t1", { dryRun: true });
  });

  it("says when there is nothing to undo, or fewer turns than asked", async () => {
    expect((await service().preview({ kind: "chat", sessionKey: KEY })).status).toBe("nothing");
    turn({ uuid: "t1", files: ["/work/a"] });
    const res = await service().preview({ kind: "chat", sessionKey: KEY }, 3);
    expect(res.status).toBe("refused");
    if (res.status === "refused") expect(res.message).toContain("/undo 1");
    expect((await service().preview({ kind: "chat", sessionKey: KEY }, 99)).status).toBe("refused");
  });

  it("splits created files (deleted by a rewind) from restored ones, and lists untracked subagent edits", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts", "/work/new.md"], created: ["/work/new.md"], sub: ["/work/sub.ts"] });
    tempImpl = async () => ok(["/work/a.ts", "new.md"]);
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    if (res.status !== "ready") throw new Error(res.status);
    expect(res.plan.restore).toEqual(["/work/a.ts"]);
    expect(res.plan.remove).toEqual(["/work/new.md"]);
    expect(res.plan.notCovered).toEqual(["/work/sub.ts"]);
  });

  it("warns about files modified after the turn ended", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts", "/work/b.ts"], at: now - 60_000 });
    tempImpl = async () => ok(["/work/a.ts", "/work/b.ts"]);
    mtimes = { "/work/a.ts": now - 59_800, "/work/b.ts": now - 10_000 };
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    if (res.status !== "ready") throw new Error(res.status);
    expect(res.plan.modifiedAfter).toEqual(["/work/b.ts"]);
  });

  it("treats a thrown 'Failed to rewind' (wrong account, E3) as cannot undo, and closes the query", async () => {
    const id = turn({ uuid: "u1", files: ["/work/a.ts"] });
    tempImpl = async () => {
      throw new Error("Failed to rewind: No files were restored: 1 file failed (backup missing, or the file could not be updated)");
    };
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    expect(res.status).toBe("refused");
    if (res.status === "refused") expect(res.message).toContain("No files were restored");
    expect(tempQueries[0]!.fake.close).toHaveBeenCalledTimes(1);
    expect(store.get(id)!.undoneAt).toBeNull();
  });

  it("times out a rewind that never answers, and closes the query", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    tempImpl = () => new Promise<RewindFilesResult>(() => undefined);
    const res = await service().preview({ kind: "chat", sessionKey: KEY });
    expect(res.status).toBe("refused");
    if (res.status === "refused") expect(res.message).toContain("timed out");
    expect(tempQueries[0]!.fake.close).toHaveBeenCalledTimes(1);
  });

  it("reports a query that fails to open", async () => {
    turn({ uuid: "u1", files: ["/work/a.ts"] });
    const res = await service({ query: () => { throw new Error("spawn failed"); } }).preview({ kind: "chat", sessionKey: KEY });
    expect(res.status).toBe("refused");
  });
});

describe("UndoService.apply", () => {
  async function ready(svc: UndoService, turns = 1) {
    const res = await svc.preview({ kind: "chat", sessionKey: KEY }, turns);
    if (res.status !== "ready") throw new Error(`not ready: ${JSON.stringify(res)}`);
    return res.plan;
  }

  it("rewinds to the oldest selected uuid, marks rows undone, sets the history note and the next-turn note once", async () => {
    const a = turn({ uuid: "t1", files: ["/work/a"] });
    const b = turn({ uuid: "t2", files: ["/work/b"] });
    tempImpl = async () => ok(["/work/a", "/work/b"]);
    const svc = service();
    const plan = await ready(svc, 2);
    const res = await svc.apply(plan);
    expect(res.status).toBe("applied");
    const real = tempQueries[1]!;
    expect(real.fake.rewindFiles).toHaveBeenCalledWith("t1", { dryRun: false });
    expect(real.fake.close).toHaveBeenCalledTimes(1);
    expect(store.get(a)!.undoneAt).toBe(now);
    expect(store.get(b)!.undoneAt).toBe(now);
    expect(notes).toHaveLength(1);
    expect(notes[0]![0]).toBe(KEY);
    expect(notes[0]![1]).toContain("/work/a");
    expect(notes[0]![1]).toContain("Shell (Bash) commands");
    expect(history).toHaveLength(1);
    expect(history[0]![1]).toMatch(/^\[owner ran \/undo: 2 files restored/);
  });

  it("leaves rows not undone when the SDK says it cannot rewind", async () => {
    const id = turn({ uuid: "t1", files: ["/work/a"] });
    const svc = service();
    const plan = await ready(svc);
    tempImpl = async () => ({ canRewind: false, error: "No file checkpoint found for this message." });
    const res = await svc.apply(plan);
    expect(res.status).toBe("failed");
    if (res.status === "failed") expect(res.message).toContain("No file checkpoint");
    expect(store.get(id)!.undoneAt).toBeNull();
    expect(notes).toEqual([]);
  });

  it("refuses while a turn runs, after a new turn, or after the confirm window", async () => {
    turn({ uuid: "t1", files: ["/work/a"] });
    const svc = service();
    const plan = await ready(svc);

    busy = true;
    expect(await svc.apply(plan)).toEqual({ status: "refused", message: UNDO_BUSY_TEXT });
    busy = false;

    epoch += 1;
    expect((await svc.apply(plan)).status).toBe("refused");
    epoch -= 1;

    now += (config.confirmTimeoutSeconds + 60) * 1000;
    expect((await svc.apply(plan)).status).toBe("refused");
    expect(tempQueries).toHaveLength(1); // only the dry run
  });

  it("refuses when the selected turns changed since the preview", async () => {
    turn({ uuid: "t1", files: ["/work/a"] });
    const svc = service();
    const plan = await ready(svc);
    turn({ uuid: "t2", files: ["/work/b"] });
    expect((await svc.apply(plan)).status).toBe("refused");
  });

  it("a second undo targets the next older turn", async () => {
    turn({ uuid: "t1", files: ["/work/a"] });
    turn({ uuid: "t2", files: ["/work/b"] });
    const svc = service();
    await svc.apply(await ready(svc));
    const plan2 = await ready(svc);
    expect(plan2.target.userMessageUuid).toBe("t1");
  });
});

describe("UndoService task scope", () => {
  it("refuses while the task is pending or running", async () => {
    turn({ uuid: "k1", files: ["/work/a"], source: "task:task-1234567" });
    taskStatus = "running";
    const res = await service().preview({ kind: "task", taskId: "task-1234567" });
    expect(res.status).toBe("refused");
    expect(tempQueries).toHaveLength(0);
  });

  it("previews and applies all of a finished task's turns through a temporary query", async () => {
    turn({ uuid: "k1", files: ["/work/a"], source: "task:task-1234567", sid: "sid-task" });
    turn({ uuid: "k2", files: ["/work/b"], source: "task:task-1234567", sid: "sid-task" });
    liveQuery = fakeQuery(async () => ok([]));
    taskStatus = "completed";
    const svc = service();
    const res = await svc.preview({ kind: "task", taskId: "task-1234567" });
    if (res.status !== "ready") throw new Error(res.status);
    expect(res.plan.target.userMessageUuid).toBe("k1");
    expect(tempQueries[0]!.options.resume).toBe("sid-task");
    expect(liveQuery.rewindFiles).not.toHaveBeenCalled();
    const applied = await svc.apply(res.plan);
    expect(applied.status).toBe("applied");
  });

  it("resolves task ids by unique prefix", () => {
    turn({ uuid: "k1", files: ["/work/a"], source: "task:abcdef-1" });
    turn({ uuid: "k2", files: ["/work/a"], source: "task:abcdef-2" });
    const svc = service();
    expect(svc.resolveTaskId("abcdef-1")).toEqual({ taskId: "abcdef-1" });
    expect("message" in svc.resolveTaskId("abcdef")).toBe(true);
    expect("message" in svc.resolveTaskId("abc")).toBe(true);
    expect("message" in svc.resolveTaskId("zzzzzz")).toBe(true);
  });
});

describe("formatUndoTime", () => {
  it("shows the time today and the date otherwise", () => {
    const t = Date.UTC(2026, 10, 23, 14, 2);
    expect(formatUndoTime(t, "UTC", t + 60_000)).toBe("14:02");
    expect(formatUndoTime(t, "UTC", t + 3 * 86_400_000)).toBe("Nov 23 14:02");
  });
});