import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { Query, RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import { UndoConfigSchema, type UndoConfig } from "../config/sections/undo.js";
import { splitCommandArgs } from "../commands/parse.js";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, CommandDefinition, CommandReply } from "../commands/types.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { UndoCheckpointStore } from "./checkpoint-store.js";
import { UndoService } from "./undo-service.js";
import { createUndoCommands, displayUndoPath, renderUndoApplied, renderUndoPreview, UNDO_HELP_TEXT, type UndoCommandDeps } from "./commands.js";
import { OWNER_PROMPT_BODY_MAX_CHARS } from "../interaction/owner-prompts.js";
import type { UndoPlan } from "./undo-service.js";

const OWNER = "1001";
const KEY = `telegram:dm:${OWNER}`;
const T0 = Date.UTC(2026, 10, 23, 14, 2);

let dir: string;
let store: UndoCheckpointStore;
let config: UndoConfig;
let enabled: boolean;
let busy: boolean;
let epoch: number;
let rewindImpl: (uuid: string, opts?: { dryRun?: boolean }) => Promise<RewindFilesResult>;
let rewinds: Array<{ uuid: string; dryRun: boolean | undefined }>;
let confirmAnswer: boolean;
let confirmCalls: Array<{ title: string; body: string }>;
let audit: ReturnType<typeof vi.fn>;
let setEnabled: ReturnType<typeof vi.fn>;
let closeIdle: ReturnType<typeof vi.fn>;
let notes: string[];
let mtimes: Record<string, number>;

function fakeQuery(): Query {
  return {
    rewindFiles: async (uuid: string, opts?: { dryRun?: boolean }) => {
      rewinds.push({ uuid, dryRun: opts?.dryRun });
      return rewindImpl(uuid, opts);
    },
    close: () => undefined,
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => undefined) };
    },
  } as unknown as Query;
}

function makeService(): UndoService {
  return new UndoService({
    store,
    recorder: { turnEpoch: () => epoch, liveBinding: () => undefined, isStreamActive: () => false },
    config: () => config,
    isEnabled: () => enabled,
    isChatBusy: () => busy,
    v2: { getIdleQuery: () => undefined, closeAndWait: async () => undefined },
    taskStatus: () => "completed",
    query: () => fakeQuery(),
    baseEnv: () => ({}),
    now: () => T0 + 60_000,
    mtimeOf: (p: string) => mtimes[p] ?? null,
    addNextTurnNote: (_k, n) => notes.push(n),
    timezone: "UTC",
  });
}

function commands(over: Partial<UndoCommandDeps> = {}): CommandDefinition {
  const [def] = createUndoCommands({
    service: makeService(),
    config: () => config,
    isEnabled: () => enabled,
    setEnabled,
    closeIdleSessions: closeIdle,
    confirm: async (title, body) => {
      confirmCalls.push({ title, body });
      return confirmAnswer;
    },
    audit,
    timezone: "UTC",
    now: () => T0 + 60_000,
    ...over,
  });
  return def!;
}

async function run(def: CommandDefinition, args: string): Promise<string> {
  const message = {
    id: "m1", channel: "telegram", senderId: OWNER, senderName: "Owner", text: `/undo ${args}`,
    chatType: "dm", chatId: OWNER, raw: {},
  } as unknown as UnifiedMessage;
  const ctx: CommandContext = {
    name: "undo",
    args,
    argv: splitCommandArgs(args),
    message,
    identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as CommandContext["identity"],
    isOwner: true,
    sessionKey: KEY,
    reply: vi.fn(async () => {}),
    confirm: vi.fn(async () => false),
  };
  const out = await def.handler(ctx);
  return typeof out === "string" ? out : out?.text ?? "";
}

/** Like run(), recording ctx.reply messages and the order of replies and the confirm. */
async function runCapture(args: string, over: Partial<UndoCommandDeps> = {}, replyImpl?: () => Promise<void>) {
  const order: string[] = [];
  const replies: string[] = [];
  const def = commands({
    confirm: async (title, body) => {
      order.push("confirm");
      confirmCalls.push({ title, body });
      return confirmAnswer;
    },
    ...over,
  });
  const message = {
    id: "m1", channel: "telegram", senderId: OWNER, senderName: "Owner", text: `/undo ${args}`,
    chatType: "dm", chatId: OWNER, raw: {},
  } as unknown as UnifiedMessage;
  const ctx: CommandContext = {
    name: "undo", args, argv: splitCommandArgs(args), message,
    identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as CommandContext["identity"],
    isOwner: true, sessionKey: KEY,
    reply: vi.fn(async (r: string | CommandReply) => {
      if (replyImpl) await replyImpl();
      order.push("reply");
      replies.push(typeof r === "string" ? r : r.text);
    }),
    confirm: vi.fn(async () => false),
  };
  const out = await def.handler(ctx);
  return { out: typeof out === "string" ? out : out?.text ?? "", replies, order };
}

function turn(opts: { uuid: string; files?: string[]; created?: string[]; bash?: string[]; source?: string; sid?: string }): number {
  const id = store.insert({
    sessionKey: KEY,
    sdkSessionId: opts.sid ?? "sid-1",
    userMessageUuid: opts.uuid,
    accountId: null,
    configDir: null,
    cwd: "/work",
    source: opts.source ?? "chat",
    promptPreview: "fix the retry loop",
    createdAt: T0,
  });
  store.setActivity(id, {
    filesChanged: opts.files ?? [],
    filesCreated: opts.created ?? [],
    subagentFiles: [],
    bashCount: opts.bash?.length ?? 0,
    bashSamples: opts.bash ?? [],
  });
  store.complete(id, T0 + 1000);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-undo-cmd-"));
  store = new UndoCheckpointStore(join(dir, "checkpoints.db"));
  config = UndoConfigSchema.parse({ enabled: true });
  enabled = true;
  busy = false;
  epoch = 1;
  rewinds = [];
  rewindImpl = async () => ({ canRewind: true, filesChanged: ["/work/src/x.ts", "/work/new.md"], insertions: 12, deletions: 40 });
  confirmAnswer = true;
  confirmCalls = [];
  mtimes = {};
  audit = vi.fn();
  setEnabled = vi.fn((on: boolean | null) => { enabled = on ?? config.enabled; });
  closeIdle = vi.fn();
  notes = [];
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("/undo", () => {
  it("is owner-only, DM-only, in the security category", () => {
    const def = commands();
    expect(def).toMatchObject({ name: "undo", ownerOnly: true, scope: "dm", category: "security" });
  });

  it("is refused for a non-owner by the registry and never reaches the handler", async () => {
    const def = commands();
    const handler = vi.spyOn(def, "handler");
    const registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }) });
    registry.registerAll([def]);
    const sent: CommandReply[] = [];
    const outcome = await registry.dispatch({
      message: { id: "m", channel: "telegram", senderId: "999", text: "/undo", chatType: "dm", chatId: "999", raw: {} } as unknown as UnifiedMessage,
      identity: { canonicalId: "999", senderId: "999", role: "user", channel: "telegram" } as CommandContext["identity"],
      source: "channel",
      send: async (r) => { sent.push(r); },
    });
    expect(outcome.kind).toBe("denied");
    expect(handler).not.toHaveBeenCalled();
  });

  it("previews, asks for Confirm, applies, and replies with restored files and shell commands", async () => {
    const id = turn({ uuid: "u1", files: ["/work/src/x.ts", "/work/new.md"], created: ["/work/new.md"], bash: ["git add -A", "pnpm test"] });
    const out = await run(commands(), "");
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.title).toBe('Undo the last turn (14:02, "fix the retry loop")?');
    expect(confirmCalls[0]!.body).toContain("Will restore 1 file (+12 -40):\n  src/x.ts");
    expect(confirmCalls[0]!.body).toContain("Will delete 1 file created in that turn");
    expect(confirmCalls[0]!.body).toContain("  new.md");
    expect(confirmCalls[0]!.body).toContain("Not reverted: 2 shell commands in that turn (git add -A; pnpm test).");
    expect(rewinds).toEqual([{ uuid: "u1", dryRun: true }, { uuid: "u1", dryRun: false }]);
    expect(out).toContain("Undone. Restored 1 file and deleted 1 created file");
    expect(out).toContain("Not reverted: 2 shell commands");
    expect(store.get(id)!.undoneAt).not.toBeNull();
    expect(notes).toHaveLength(1);
    expect(audit.mock.calls.map((c) => c[0])).toEqual(["previewed", "applied"]);
  });

  it("changes nothing on Cancel", async () => {
    const id = turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    confirmAnswer = false;
    const out = await run(commands(), "");
    expect(out).toBe("Undo cancelled. Nothing was changed.");
    expect(rewinds).toEqual([{ uuid: "u1", dryRun: true }]);
    expect(store.get(id)!.undoneAt).toBeNull();
    expect(notes).toEqual([]);
  });

  it("falls back to ctx.confirm when no confirm dep is given", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    const out = await run(commands({ confirm: undefined }), "");
    expect(out).toBe("Undo cancelled. Nothing was changed.");
  });

  it("preview only: no confirm, no real rewind", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    const out = await run(commands(), "preview");
    expect(out).toContain("Undo the last turn");
    expect(out).toContain("Send /undo to apply it.");
    expect(confirmCalls).toHaveLength(0);
    expect(rewinds).toEqual([{ uuid: "u1", dryRun: true }]);
  });

  it("shows the skipped-links count after a real undo", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    rewindImpl = async (_u, o) => ({ canRewind: true, filesChanged: ["/work/src/x.ts"], insertions: 1, deletions: 1, ...(o?.dryRun ? {} : { skippedLinks: 2 }) });
    const out = await run(commands(), "");
    expect(out).toContain("Skipped 2 files (symlink, hard link or moved path): not restored.");
  });

  it("refuses while a turn runs", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    busy = true;
    const out = await run(commands(), "");
    expect(out).toContain("A turn is still running");
    expect(confirmCalls).toHaveLength(0);
  });

  it("validates the turn count", async () => {
    expect(await run(commands(), "99")).toContain("Usage: /undo [1-5]");
    expect(await run(commands(), "abc")).toContain("Usage");
  });

  it("lists recent turns", async () => {
    turn({ uuid: "u1", files: ["/work/a"], bash: ["ls"] });
    turn({ uuid: "u2", bash: ["pwd"] });
    turn({ uuid: "t1", files: ["/work/t"], source: "task:abcdef123" });
    const out = await run(commands(), "list");
    expect(out).toContain("[task abcdef12]");
    expect(out).toContain('"fix the retry loop": 1 file, 1 shell command');
    expect(out).toContain("no file edits, 1 shell command");
  });

  it("undoes a task by id prefix", async () => {
    turn({ uuid: "t1", files: ["/work/src/x.ts"], source: "task:abcdef123", sid: "sid-t" });
    const out = await run(commands(), "task abcdef");
    expect(confirmCalls[0]!.title).toContain("Undo the file edits of task abcdef12");
    expect(out).toContain("Undone");
  });

  it("on/off/reset write the override and close idle sessions", async () => {
    enabled = false;
    expect(await run(commands(), "on")).toContain("Undo is on");
    expect(setEnabled).toHaveBeenLastCalledWith(true, `owner:telegram:${OWNER}`);
    expect(closeIdle).toHaveBeenCalledTimes(1);
    expect(await run(commands(), "off")).toContain("Undo is off");
    expect(setEnabled).toHaveBeenLastCalledWith(false, `owner:telegram:${OWNER}`);
    await run(commands(), "reset");
    expect(setEnabled).toHaveBeenLastCalledWith(null, `owner:telegram:${OWNER}`);
    expect(closeIdle).toHaveBeenCalledTimes(3);
  });

  it("says when undo is off", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    enabled = false;
    expect(await run(commands(), "")).toContain("Undo is off");
  });

  it("answers v2-needed in v1 mode, except help", async () => {
    const def = commands({ service: null });
    expect(await run(def, "")).toBe("Undo needs agent.sessionMode v2.");
    expect(await run(def, "on")).toBe("Undo needs agent.sessionMode v2.");
    expect(await run(def, "help")).toBe(UNDO_HELP_TEXT);
  });

  it("help states what is not covered", () => {
    expect(UNDO_HELP_TEXT).toContain("anything done through Bash");
    expect(UNDO_HELP_TEXT).toContain("account switch or a /clear");
    expect(UNDO_HELP_TEXT).toContain("deletes files the turn created");
  });

  it("scrubs secrets from the preview", async () => {
    const secret = ["sk", "ant", "api03", "B".repeat(40)].join("-");
    turn({ uuid: "u1", files: ["/work/src/x.ts"], bash: [`echo ${secret}`] });
    await run(commands(), "");
    expect(confirmCalls[0]!.body).not.toContain(secret);
  });

  it("shows paths relative to the turn's cwd or home", () => {
    expect(displayUndoPath("/work/src/a.ts", "/work")).toBe("src/a.ts");
    expect(displayUndoPath("/elsewhere/b.ts", "/work")).toBe("/elsewhere/b.ts");
  });

  it("notes running tasks in the preview and warns when a turn raced the undo", () => {
    const id = turn({ uuid: "u1", files: ["/work/a.ts"] });
    const row = store.get(id)!;
    const plan: UndoPlan = {
      scope: { kind: "chat", sessionKey: KEY }, sessionKey: KEY, rows: [row], target: row,
      dryRun: { canRewind: true, filesChanged: ["/work/a.ts"], insertions: 1, deletions: 1, skippedLinks: 0, via: "temporary" },
      restore: ["/work/a.ts"], remove: [], notCovered: [], modifiedAfter: [], runningTasks: 2,
      bashCount: 0, bashSamples: [], createdAt: T0, epoch: 1,
    };
    expect(renderUndoPreview(plan)).toContain("Note: 2 background tasks started from this chat are still running");
    const out = renderUndoApplied({ status: "applied", plan, result: plan.dryRun, restored: ["/work/a.ts"], removed: [], raced: true });
    expect(out).toContain("Undone. Restored 1 file:\n  a.ts");
    expect(out).toContain("Warning: a turn started in this chat while the undo ran");
  });

  // ── RUNTIME-B3 / UNDO-B1: the Confirm card is never cut and names files safely ──

  it("a large preview keeps the safeguards on the card and sends every path first (reviewer proof D)", async () => {
    const base = `${homedir()}/Desktop/test/kirie/packages/core/src/engine`;
    const edited = Array.from({ length: 15 }, (_, i) => `${base}/background-task-manager-part${String(i).padStart(2, "0")}.seam.test.ts`);
    const created = Array.from({ length: 15 }, (_, i) => `${base}/v2-session-manager-helper${String(i).padStart(2, "0")}.seam.test.ts`);
    turn({ uuid: "t1", files: [...edited, ...created], created, bash: ["pnpm build", "pnpm lint", "git add -A"] });
    for (const p of edited) mtimes[p] = T0 + 120_000;
    rewindImpl = async () => ({ canRewind: true, filesChanged: [...edited, ...created], insertions: 3, deletions: 4 });
    const pre = await makeService().preview({ kind: "chat", sessionKey: KEY }, 1);
    if (pre.status !== "ready") throw new Error("not ready");
    // The reviewer's preview: too long for one card once every path is listed.
    expect(renderUndoPreview(pre.plan, { listed: Infinity }).length).toBeGreaterThan(OWNER_PROMPT_BODY_MAX_CHARS);

    const { replies, order } = await runCapture("");
    const body = confirmCalls[0]!.body;
    expect(body.length).toBeLessThanOrEqual(OWNER_PROMPT_BODY_MAX_CHARS - 200);
    expect(body.startsWith("Not reverted: 3 shell commands in that turn (pnpm build; pnpm lint; git add -A).")).toBe(true);
    expect(body).toContain("Warning: 15 files changed after that turn; undo will overwrite those changes.");
    expect(body).toContain("Will restore 15 files (+3 -4).");
    expect(body).toContain("Will delete 15 files created in that turn (no earlier version exists).");
    expect(body).toContain("The full list of the 30 files was sent just above in");
    expect(order.at(-1)).toBe("confirm");
    expect(order.slice(0, -1).every((o) => o === "reply")).toBe(true);
    const all = replies.join("\n");
    for (const p of [...edited, ...created]) expect(all).toContain(p.slice(homedir().length));
    expect(all).toContain("Not reverted: 3 shell commands");
    expect(replies.at(-1)).toContain("End of the undo preview.");
    for (const r of replies) expect(r.length).toBeLessThan(4096);
  });

  it("more than 15 files in a section: every path is sent before Confirm, none only counted (reviewer proof D2)", async () => {
    const created = Array.from({ length: 40 }, (_, i) => `/work/gen/f${i}.ts`);
    turn({ uuid: "t1", files: created, created });
    rewindImpl = async () => ({ canRewind: true, filesChanged: created, insertions: 0, deletions: 0 });
    const { replies } = await runCapture("");
    const body = confirmCalls[0]!.body;
    expect(body).toContain("Will delete 40 files created in that turn");
    expect(body).not.toContain("... and 25 more");
    const all = replies.join("\n");
    for (let i = 0; i < 40; i++) expect(all).toContain(`  gen/f${i}.ts\n`.trimEnd());
    expect(all).not.toContain("... and");
  });

  it("a short preview stays on the card with every path, and no extra messages", async () => {
    turn({ uuid: "u1", files: ["/work/src/x.ts"] });
    const { replies } = await runCapture("");
    expect(replies).toEqual([]);
    expect(confirmCalls[0]!.body).toMatch(/Will restore \d+ files? \(\+12 -40\):\n {2}src\/x\.ts/);
  });

  it("file names with newlines, bidi or control characters are shown escaped (reviewer proof E)", async () => {
    const evil = "/work/notes\nNot reverted: nothing else.\u202Etxt.exe";
    const bell = "/work/a\u0007b\u200Bc.ts";
    turn({ uuid: "t1", files: [evil, bell] });
    rewindImpl = async () => ({ canRewind: true, filesChanged: [evil, bell], insertions: 1, deletions: 1 });
    await runCapture("");
    const body = confirmCalls[0]!.body;
    expect(body).not.toContain("\nNot reverted: nothing else.");
    expect(body).not.toContain("\u202E");
    expect(body).toContain("notes[U+000A]Not reverted: nothing else.[U+202E]txt.exe");
    expect(body).toContain("a[U+0007]b[U+200B]c.ts");
    expect(body.split("\n").filter((l) => l.startsWith("Not reverted:"))).toHaveLength(1);
    expect(displayUndoPath("/work/x\ty.ts", "/work")).toBe("x[U+0009]y.ts");
  });

  it("when the full list cannot be sent, nothing is asked and nothing changes", async () => {
    const created = Array.from({ length: 40 }, (_, i) => `/work/gen/f${i}.ts`);
    turn({ uuid: "t1", files: created, created });
    rewindImpl = async () => ({ canRewind: true, filesChanged: created, insertions: 0, deletions: 0 });
    const { out } = await runCapture("", {}, async () => {
      throw new Error("send failed");
    });
    expect(out).toContain("Undo cancelled");
    expect(confirmCalls).toHaveLength(0);
    expect(rewinds.every((r) => r.dryRun === true)).toBe(true);
  });

  it("/undo preview lists every path", async () => {
    const created = Array.from({ length: 40 }, (_, i) => `/work/gen/f${i}.ts`);
    turn({ uuid: "t1", files: created, created });
    rewindImpl = async () => ({ canRewind: true, filesChanged: created, insertions: 0, deletions: 0 });
    const { out } = await runCapture("preview");
    expect(out).toContain("gen/f39.ts");
    expect(out).not.toContain("... and");
  });
});
