import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Query, RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import { UndoConfigSchema, type UndoConfig } from "../config/sections/undo.js";
import { splitCommandArgs } from "../commands/parse.js";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandContext, CommandDefinition, CommandReply } from "../commands/types.js";
import type { UnifiedMessage } from "../channels/normalizer.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { UndoCheckpointStore } from "./checkpoint-store.js";
import { UndoService } from "./undo-service.js";
import { createUndoCommands, displayUndoPath, UNDO_HELP_TEXT, type UndoCommandDeps } from "./commands.js";

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
    recorder: { turnEpoch: () => epoch, liveBinding: () => undefined },
    config: () => config,
    isEnabled: () => enabled,
    isChatBusy: () => busy,
    v2: { getIdleQuery: () => undefined, closeAndWait: async () => undefined },
    taskStatus: () => "completed",
    query: () => fakeQuery(),
    baseEnv: () => ({}),
    now: () => T0 + 60_000,
    mtimeOf: () => null,
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
});