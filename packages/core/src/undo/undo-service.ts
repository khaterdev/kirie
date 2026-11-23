/**
 * Undo service (PLAN C.11, R1 item 11 "Running an undo"; experiment E3).
 *
 * `preview` picks the turns, runs `rewindFiles(uuid, { dryRun: true })` and
 * returns a plan; `apply` re-checks that plan and runs the real rewind. Both
 * refuse while the chat (or the task) has a turn in flight.
 *
 * The rewind target is the client-stamped uuid of the oldest selected turn;
 * every selected turn must share its SDK session and config dir, because the
 * backups live in that account's `file-history/` (E3: under another account
 * the rewind throws for edited files). The rewind runs on the chat's live
 * query when it is idle and bound to the same session and config dir;
 * otherwise a live process on that session is closed first and a temporary
 * query is opened with `resume`, checkpointing on, the turn's own config dir
 * and a prompt that never yields. A rewind is a control request: no model
 * turn, no cost. Both failure shapes (a returned `canRewind: false` and a
 * thrown "Failed to rewind") are reported as "cannot undo"; the ledger rows
 * stay not-undone.
 */

import {
  query as sdkQuery,
  type Options,
  type Query,
  type RewindFilesResult,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import { ACCOUNT_AUTH_OVERRIDES } from "../accounts/account-env.js";
import type { SdkOptionsPipeline } from "../engine/sdk-options.js";
import type { UndoConfig } from "../config/sections/undo.js";
import type { UndoCheckpoint, UndoCheckpointStore } from "./checkpoint-store.js";
import type { UndoRecorder } from "./recorder.js";

const log = createModuleLogger("undo-service");

export const UNDO_REWIND_TIMEOUT_MS = 30_000;
/** Close-and-wait budget for a live session that must give up the SDK session first */
export const UNDO_CLOSE_TIMEOUT_MS = 10_000;
/** A file whose mtime is this much later than the turn's end counts as changed after it */
const MTIME_SLACK_MS = 1_000;
/** Shown for every refusal while a turn runs */
export const UNDO_BUSY_TEXT = "A turn is still running in this chat. Wait for it to finish (or /stop it), then send /undo again.";
export const UNDO_NEEDS_V2_TEXT = "Undo needs agent.sessionMode v2.";

type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export type UndoScope =
  | { kind: "chat"; sessionKey: string }
  | { kind: "task"; taskId: string };

export interface UndoRewindOutcome {
  canRewind: boolean;
  error?: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  skippedLinks: number;
  /** How the rewind ran */
  via: "live" | "temporary";
}

export interface UndoPlan {
  scope: UndoScope;
  /** The session the scope belongs to (a task's: the chat that started it) */
  sessionKey: string;
  /** Selected rows, newest first */
  rows: UndoCheckpoint[];
  /** Oldest selected row: the rewind target */
  target: UndoCheckpoint;
  dryRun: UndoRewindOutcome;
  /** Absolute paths the rewind restores to an earlier version */
  restore: string[];
  /** Absolute paths the selected turns created; a rewind deletes them */
  remove: string[];
  /** Paths edited by subagents that the SDK will not restore */
  notCovered: string[];
  /** Restored or deleted paths modified after the last selected turn that touched them ended */
  modifiedAfter: string[];
  /** Background tasks started from this chat that are still pending or running (chat scope) */
  runningTasks: number;
  bashCount: number;
  bashSamples: string[];
  createdAt: number;
  epoch: number;
}

export type UndoPreviewOutcome =
  | { status: "refused"; message: string }
  | { status: "nothing"; message: string; plan?: UndoPlan }
  | { status: "ready"; plan: UndoPlan };

export type UndoApplyOutcome =
  | { status: "refused"; message: string }
  | { status: "failed"; message: string; result: UndoRewindOutcome }
  | {
      status: "applied";
      plan: UndoPlan;
      result: UndoRewindOutcome;
      /** Paths the rewind reported, split into restored and deleted (created) files */
      restored: string[];
      removed: string[];
      /** A turn started in the chat while the rewind ran: it may have read or written those files */
      raced: boolean;
    };

export interface UndoServiceDeps {
  store: UndoCheckpointStore;
  recorder: Pick<UndoRecorder, "turnEpoch" | "liveBinding" | "isStreamActive">;
  config: () => UndoConfig;
  isEnabled: () => boolean;
  /** Turns only: pipeline.isBusy(key, { ignoreHolds: true }) || v2.isBusy(key). The undo holds the chat itself */
  isChatBusy: (sessionKey: string) => boolean;
  /** Null in v1 mode */
  v2: { getIdleQuery(sessionKey: string): Query | undefined; closeAndWait(sessionKey: string, timeoutMs?: number): Promise<void> } | null;
  /** Status of a background task, null when unknown */
  taskStatus: (taskId: string) => string | null;
  /** Background tasks started from this chat that are pending or running */
  runningTaskCount?: (sessionKey: string) => number;
  /** The SDK session the chat is mapped to (SessionStore), a cross-check for reusing the live query */
  currentSdkSessionId?: (sessionKey: string) => string | null;
  /** Resolve symlinks (e.g. /tmp vs /private/tmp) before comparing paths */
  canonicalPath?: (path: string) => string;
  sdkOptions?: SdkOptionsPipeline;
  query?: QueryFn;
  baseEnv?: () => NodeJS.ProcessEnv;
  rewindTimeoutMs?: number;
  now?: () => number;
  /** mtime in ms, or null when the file does not exist */
  mtimeOf?: (path: string) => number | null;
  /** pipeline.addNextTurnNote: tells the model, once, that its edits are gone */
  addNextTurnNote?: (sessionKey: string, note: string) => void;
  /** Append an assistant line to the chat history */
  appendHistory?: (sessionKey: string, text: string) => void;
  /** IANA zone for times shown to the owner and the model */
  timezone?: string;
}

/** A prompt stream that yields nothing until `end()`. */
function neverYielding(): { iterable: AsyncIterable<SDKUserMessage>; end: () => void } {
  let release: (() => void) | null = null;
  let ended = false;
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          ended
            ? Promise.resolve({ value: undefined, done: true as const })
            : new Promise<IteratorResult<SDKUserMessage>>((res) => {
                release = () => res({ value: undefined, done: true });
              }),
        return: () => {
          ended = true;
          return Promise.resolve({ value: undefined, done: true as const });
        },
      };
    },
  };
  return {
    iterable,
    end: () => {
      ended = true;
      release?.();
    },
  };
}

/**
 * The environment of a rewind: the daemon's env with the login overrides
 * removed and `CLAUDE_CONFIG_DIR` set to the turn's own config dir (unset for
 * the default login), so the CLI finds that account's `file-history/`.
 * For a turn that ran on the ambient env (no account lease) the daemon's env
 * is kept as it is, apart from the config dir.
 */
export function undoRewindEnv(row: Pick<UndoCheckpoint, "accountId" | "configDir">, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") env[k] = v;
  if (row.accountId !== null) for (const k of ACCOUNT_AUTH_OVERRIDES) delete env[k];
  delete env.CLAUDE_CONFIG_DIR;
  if (row.configDir) env.CLAUDE_CONFIG_DIR = row.configDir;
  return env;
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubSecrets(raw, { sink: "prompt-card" }).slice(0, 300);
}

function defaultCanonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

function defaultMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export class UndoService {
  private readonly deps: UndoServiceDeps;
  private readonly now: () => number;
  private readonly runQuery: QueryFn;
  private readonly mtimeOf: (path: string) => number | null;
  private readonly canonical: (path: string) => string;
  /** One undo at a time per scope */
  private readonly busyScopes = new Set<string>();

  constructor(deps: UndoServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.runQuery = deps.query ?? (sdkQuery as unknown as QueryFn);
    this.mtimeOf = deps.mtimeOf ?? defaultMtime;
    this.canonical = deps.canonicalPath ?? defaultCanonical;
  }

  /** Dry run: what an undo of the last `turns` turns (chat) or of a task's edits would do. Changes nothing. */
  async preview(scope: UndoScope, turns = 1): Promise<UndoPreviewOutcome> {
    const pre = this.precheck(scope);
    if (pre) return { status: "refused", message: pre };
    const key = scopeKey(scope);
    if (this.busyScopes.has(key)) return { status: "refused", message: "An undo is already running here." };
    this.busyScopes.add(key);
    try {
      const sel = this.select(scope, turns);
      if ("message" in sel) return sel.nothing ? { status: "nothing", message: sel.message } : { status: "refused", message: sel.message };
      const epoch = this.deps.recorder.turnEpoch(sel.sessionKey);
      const dryRun = await this.rewind(sel.sessionKey, scope, sel.target, true);
      if (!dryRun.canRewind) {
        return { status: "refused", message: `Cannot undo: ${dryRun.error ?? "the SDK has no checkpoint for that turn"}.` };
      }
      const plan = this.buildPlan(scope, sel.sessionKey, sel.rows, dryRun, epoch);
      if (plan.restore.length === 0 && plan.remove.length === 0) {
        return { status: "nothing", message: "Nothing to restore: the files of that turn already match their earlier state, or the SDK did not track them.", plan };
      }
      return { status: "ready", plan };
    } finally {
      this.busyScopes.delete(key);
    }
  }

  /** Apply a previewed plan, if it still describes the latest turns and nothing ran since. */
  async apply(plan: UndoPlan): Promise<UndoApplyOutcome> {
    const { scope } = plan;
    const pre = this.precheck(scope);
    if (pre) return { status: "refused", message: pre };
    const maxAgeMs = this.deps.config().confirmTimeoutSeconds * 1000 + 30_000;
    if (this.now() - plan.createdAt > maxAgeMs) {
      return { status: "refused", message: "That preview has expired. Send /undo again." };
    }
    if (this.deps.recorder.turnEpoch(plan.sessionKey) !== plan.epoch) {
      return { status: "refused", message: "A new turn ran since the preview, so it no longer applies. Send /undo again." };
    }
    const key = scopeKey(scope);
    if (this.busyScopes.has(key)) return { status: "refused", message: "An undo is already running here." };
    this.busyScopes.add(key);
    try {
      const sel = this.select(scope, scope.kind === "chat" ? plan.rows.length : Number.MAX_SAFE_INTEGER);
      if ("message" in sel || sel.rows.map((r) => r.id).join(",") !== plan.rows.map((r) => r.id).join(",")) {
        return { status: "refused", message: "The turns changed since the preview. Send /undo again." };
      }
      const result = await this.rewind(plan.sessionKey, scope, plan.target, false);
      if (!result.canRewind) {
        log.warn({ scope: key, error: result.error }, "rewind failed; ledger rows left as they were");
        return { status: "failed", message: `Undo failed: ${result.error ?? "the SDK could not restore the files"}. Nothing was marked undone.`, result };
      }
      const raced =
        this.deps.recorder.turnEpoch(plan.sessionKey) !== plan.epoch ||
        this.deps.isChatBusy(plan.sessionKey) ||
        this.deps.recorder.isStreamActive(plan.sessionKey);
      this.deps.store.markUndone(plan.rows.map((r) => r.id), this.now());
      const { restored, removed } = this.classify(plan, result.filesChanged);
      this.tellConversation(plan, restored, removed);
      if (raced) log.warn({ scope: key }, "a turn started while the undo ran");
      log.info({ scope: key, rows: plan.rows.length, files: result.filesChanged.length, via: result.via }, "undo applied");
      return { status: "applied", plan, result, restored, removed, raced };
    } finally {
      this.busyScopes.delete(key);
    }
  }

  /** The last rows of a chat session (chat turns and its tasks' turns), newest first. */
  list(sessionKey: string, limit = 10): UndoCheckpoint[] {
    return this.deps.store.recent(sessionKey, limit);
  }

  /** Resolve a task id or unique prefix to a task with ledger rows. */
  resolveTaskId(idOrPrefix: string): { taskId: string } | { message: string } {
    const s = idOrPrefix.trim();
    if (!/^[A-Za-z0-9-]{6,64}$/.test(s)) return { message: "Give the task id (at least 6 characters)." };
    const ids = this.deps.store.findTaskIds(s);
    const exact = ids.find((id) => id === s);
    if (exact) return { taskId: exact };
    if (ids.length === 0) return { message: `No recorded file edits for a task starting with ${s}.` };
    if (ids.length > 1) return { message: `More than one task starts with ${s}: ${ids.map((i) => i.slice(0, 8)).join(", ")}. Give more of the id.` };
    return { taskId: ids[0]! };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** After a real undo: one chat-history line and a one-shot note for the model's next turn. */
  /** Split the rewind's paths into restored files and deleted (created) ones; absolute, as the SDK named them. */
  private classify(plan: UndoPlan, files: readonly string[]): { restored: string[]; removed: string[] } {
    const abs = (p: string): string => (isAbsolute(p) ? p : resolve(plan.target.cwd, p));
    const created = new Set(plan.remove.map((p) => this.canonical(p)));
    const paths = [...new Set(files.map(abs))];
    return {
      restored: paths.filter((p) => !created.has(this.canonical(p))),
      removed: paths.filter((p) => created.has(this.canonical(p))),
    };
  }

  /** After a real undo: one chat-history line and a one-shot note for the model's next turn. */
  private tellConversation(plan: UndoPlan, restored: string[], deleted: string[]): void {
    const when = formatUndoTime(plan.target.createdAt, this.deps.timezone, this.now());
    const list = (ps: string[]): string => ps.slice(0, 20).join(", ") + (ps.length > 20 ? `, and ${ps.length - 20} more` : "");
    const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;
    const turnWord =
      plan.scope.kind === "task"
        ? `background task ${plan.scope.taskId.slice(0, 8)}'s edits`
        : plan.rows.length === 1 ? "your turn" : `your last ${plan.rows.length} turns`;

    const summary = [count(restored.length, "file") + " restored", ...(deleted.length > 0 ? [count(deleted.length, "created file") + " deleted"] : [])];
    try {
      this.deps.appendHistory?.(plan.sessionKey, `[owner ran /undo: ${summary.join(", ")}, back to their state before ${when}]`);
    } catch (err) {
      log.warn({ err: errorText(err) }, "undo note not stored in chat history");
    }

    const parts = [`The owner ran /undo, reverting ${turnWord} (starting ${when}).`];
    if (restored.length > 0) parts.push(`These files were restored to their state before that: ${list(restored)}.`);
    if (deleted.length > 0) parts.push(`These files, created in that span, were deleted: ${list(deleted)}.`);
    parts.push("Your earlier edits to them no longer exist; re-read a file before editing it.");
    parts.push("Shell (Bash) commands from that span were not reverted.");
    try {
      this.deps.addNextTurnNote?.(plan.sessionKey, parts.join(" "));
    } catch (err) {
      log.warn({ err: errorText(err) }, "undo next-turn note not set");
    }
  }

  private precheck(scope: UndoScope): string | null {
    if (!this.deps.v2) return UNDO_NEEDS_V2_TEXT;
    if (!this.deps.isEnabled()) return "Undo is off. Turn it on with /undo on; only turns after that can be undone.";
    if (scope.kind === "chat") {
      if (this.deps.isChatBusy(scope.sessionKey) || this.deps.recorder.isStreamActive(scope.sessionKey)) return UNDO_BUSY_TEXT;
      return null;
    }
    const status = this.deps.taskStatus(scope.taskId);
    if (status === "pending" || status === "running") {
      return `Task ${scope.taskId.slice(0, 8)} is still ${status}. Wait for it to finish (or cancel it), then undo.`;
    }
    const chatKey = this.deps.store.taskSessionKey(scope.taskId);
    if (chatKey && (this.deps.isChatBusy(chatKey) || this.deps.recorder.isStreamActive(chatKey))) return UNDO_BUSY_TEXT;
    return null;
  }

  private select(
    scope: UndoScope,
    turns: number,
  ): { rows: UndoCheckpoint[]; target: UndoCheckpoint; sessionKey: string } | { message: string; nothing?: boolean } {
    const cfg = this.deps.config();
    let sessionKey: string;
    let candidates: UndoCheckpoint[];
    if (scope.kind === "chat") {
      sessionKey = scope.sessionKey;
      if (!Number.isInteger(turns) || turns < 1 || turns > cfg.maxTurnsPerUndo) {
        return { message: `One undo covers 1 to ${cfg.maxTurnsPerUndo} turns.` };
      }
      candidates = this.deps.store.undoCandidates(sessionKey, "chat", turns);
      if (candidates.length === 0) return { message: "No turn with file edits to undo in this chat.", nothing: true };
      if (candidates.length < turns) {
        return { message: `Only ${candidates.length} turn${candidates.length === 1 ? "" : "s"} with file edits can be undone here. Send /undo ${candidates.length}.` };
      }
    } else {
      const key = this.deps.store.taskSessionKey(scope.taskId);
      if (!key) return { message: `No recorded file edits for task ${scope.taskId.slice(0, 8)}.`, nothing: true };
      sessionKey = key;
      candidates = this.deps.store.undoCandidates(sessionKey, `task:${scope.taskId}`, 1000);
      if (candidates.length === 0) return { message: `Task ${scope.taskId.slice(0, 8)} has no file edits left to undo.`, nothing: true };
    }

    // Every selected turn must share the SDK session and config dir: the
    // backups are per account and the rewind runs under one account.
    const newest = candidates[0]!;
    if (!newest.sdkSessionId) {
      return { message: "That turn has no SDK session id recorded (it ended before the session started), so it cannot be undone." };
    }
    // A gap marker (a turn that ran with checkpointing off) between two
    // selected turns would be rewound too, without being listed: stop there.
    const source = scope.kind === "chat" ? "chat" : `task:${scope.taskId}`;
    let valid = 0;
    let gap = false;
    for (const row of candidates) {
      if (row.sdkSessionId !== newest.sdkSessionId || row.configDir !== newest.configDir) break;
      if (valid > 0 && this.deps.store.gapBetween(sessionKey, source, row.id, candidates[valid - 1]!.id)) {
        gap = true;
        break;
      }
      valid++;
    }
    if (valid < candidates.length) {
      const why = gap
        ? "a turn that ran while undo was off lies between them, and rewinding past it would revert its edits unseen"
        : "they span an account switch or a /clear, and one undo can only use one account's backups";
      if (scope.kind === "chat") {
        return { message: `Those ${candidates.length} turns cannot be undone together: ${why}. Undo at most ${valid} at a time (/undo ${valid}), newest first.` };
      }
      return { message: `Task ${scope.taskId.slice(0, 8)}'s edits cannot be undone in one step: ${why}.` };
    }
    return { rows: candidates, target: candidates[candidates.length - 1]!, sessionKey };
  }

  private buildPlan(scope: UndoScope, sessionKey: string, rows: UndoCheckpoint[], dryRun: UndoRewindOutcome, epoch: number): UndoPlan {
    const target = rows[rows.length - 1]!;
    const abs = (p: string): string => (isAbsolute(p) ? p : resolve(target.cwd, p));
    const canon = (p: string): string => this.canonical(abs(p));
    const created = new Set(rows.flatMap((r) => r.filesCreated.map(canon)));
    const changed = [...new Set(dryRun.filesChanged.map(abs))];
    const restore = changed.filter((p) => !created.has(this.canonical(p)));
    const remove = changed.filter((p) => created.has(this.canonical(p)));
    const changedSet = new Set(changed.map((p) => this.canonical(p)));
    const notCovered = [...new Set(rows.flatMap((r) => r.subagentFiles.map(abs)))].filter((p) => !changedSet.has(this.canonical(p)));

    // A file counts as changed since when its mtime is later than the end of
    // the last selected turn that touched it (or the newest turn, if none listed it).
    const lastTouch = new Map<string, number>();
    for (const r of [...rows].reverse()) {
      const end = r.completedAt ?? r.createdAt;
      for (const f of [...r.filesChanged, ...r.subagentFiles]) lastTouch.set(canon(f), end);
    }
    const newestEnd = rows[0]!.completedAt ?? rows[0]!.createdAt;
    const modifiedAfter = changed.filter((p) => {
      const m = this.mtimeOf(p);
      const since = lastTouch.get(this.canonical(p)) ?? newestEnd;
      return m !== null && m > since + MTIME_SLACK_MS;
    });
    const bashSamples: string[] = [];
    for (const r of rows) for (const s of r.bashSamples) if (bashSamples.length < 3) bashSamples.push(s);
    return {
      scope,
      sessionKey,
      rows,
      target,
      dryRun,
      restore,
      remove,
      notCovered,
      modifiedAfter,
      runningTasks: scope.kind === "chat" ? (this.deps.runningTaskCount?.(sessionKey) ?? 0) : 0,
      bashCount: rows.reduce((n, r) => n + r.bashCount, 0),
      bashSamples,
      createdAt: this.now(),
      epoch,
    };
  }

  /** True when nothing runs in the chat (or the task) right now. */
  private idle(sessionKey: string, scope: UndoScope): boolean {
    if (this.deps.isChatBusy(sessionKey) || this.deps.recorder.isStreamActive(sessionKey)) return false;
    if (scope.kind === "task") {
      const status = this.deps.taskStatus(scope.taskId);
      if (status === "pending" || status === "running") return false;
    }
    return true;
  }

  /** Run rewindFiles on the live query when it is safe, else on a temporary resumed query. */
  private async rewind(sessionKey: string, scope: UndoScope, target: UndoCheckpoint, dryRun: boolean): Promise<UndoRewindOutcome> {
    const v2 = this.deps.v2!;
    if (scope.kind === "chat") {
      const live = v2.getIdleQuery(sessionKey);
      if (live) {
        const binding = this.deps.recorder.liveBinding(sessionKey);
        const mapped = this.deps.currentSdkSessionId?.(sessionKey);
        const reusable =
          binding?.checkpointing === true &&
          binding.sdkSessionId === target.sdkSessionId &&
          binding.configDir === target.configDir &&
          (mapped === undefined || mapped === null || mapped === target.sdkSessionId);
        if (reusable) {
          // No await between the busy check and this call: no turn can start in between.
          const res = await this.callRewind(live, target.userMessageUuid, dryRun, "live");
          // A timed-out control request may still be running in that process: end it.
          if (res.timedOut) await v2.closeAndWait(sessionKey, UNDO_CLOSE_TIMEOUT_MS);
          return res;
        }
        // The live process may hold the SDK session open; it must exit before
        // another process resumes that session. It is resumed on the next message.
        await v2.closeAndWait(sessionKey, UNDO_CLOSE_TIMEOUT_MS);
      }
    }
    return this.rewindInTemporaryQuery(sessionKey, scope, target, dryRun);
  }

  private async rewindInTemporaryQuery(sessionKey: string, scope: UndoScope, target: UndoCheckpoint, dryRun: boolean): Promise<UndoRewindOutcome> {
    const fail = (error: string): UndoRewindOutcome => ({
      canRewind: false, error, filesChanged: [], insertions: 0, deletions: 0, skippedLinks: 0, via: "temporary",
    });
    const startedTurn = "a turn started in this chat before the rewind could run; nothing was changed";
    if (!this.idle(sessionKey, scope)) return fail(startedTurn);

    const input = neverYielding();
    const options: Options = {
      resume: target.sdkSessionId!,
      enableFileCheckpointing: true,
      cwd: target.cwd,
      env: undoRewindEnv(target, this.deps.baseEnv?.() ?? process.env),
      // No user settings, hooks or MCP servers: nothing here needs tools (E3 ran this way)
      settingSources: [],
    };

    let q: Query | undefined;
    try {
      this.deps.sdkOptions?.apply(options, {
        kind: "utility",
        sessionKey: target.sessionKey,
        ownerDm: false,
        interactive: false,
        label: dryRun ? "undo preview" : "undo rewind",
        cwd: target.cwd,
      });
      q = this.runQuery({ prompt: input.iterable, options });
      const stream = q;
      void (async () => {
        try {
          for await (const _ of stream) {
            // a rewind is a control request: no turn; drain whatever the CLI emits
          }
        } catch {
          // closing the query ends the stream with an error
        }
      })();
      // Spawning takes a moment: check again right before the files change.
      if (!this.idle(sessionKey, scope)) return fail(startedTurn);
      return await this.callRewind(stream, target.userMessageUuid, dryRun, "temporary");
    } catch (err) {
      return fail(errorText(err));
    } finally {
      input.end();
      try {
        q?.close();
      } catch {
        // already closed
      }
    }
  }

  private async callRewind(q: Query, uuid: string, dryRun: boolean, via: "live" | "temporary"): Promise<UndoRewindOutcome & { timedOut?: boolean }> {
    const timeoutMs = this.deps.rewindTimeoutMs ?? UNDO_REWIND_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        q.rewindFiles(uuid, { dryRun }),
        new Promise<"timeout">((r) => {
          timer = setTimeout(() => r("timeout"), timeoutMs);
        }),
      ]);
      if (res === "timeout") {
        return {
          canRewind: false,
          error: `the rewind timed out after ${Math.round(timeoutMs / 1000)} s`,
          filesChanged: [], insertions: 0, deletions: 0, skippedLinks: 0, via, timedOut: true,
        };
      }
      return normalizeResult(res, via);
    } catch (err) {
      // E3: under the wrong account (or with a backup gone) the SDK throws "Failed to rewind: ..."
      return { canRewind: false, error: errorText(err), filesChanged: [], insertions: 0, deletions: 0, skippedLinks: 0, via };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function normalizeResult(res: RewindFilesResult, via: "live" | "temporary"): UndoRewindOutcome {
  return {
    canRewind: res.canRewind === true,
    ...(res.error ? { error: scrubSecrets(res.error, { sink: "prompt-card" }).slice(0, 300) } : {}),
    filesChanged: Array.isArray(res.filesChanged) ? res.filesChanged.filter((f): f is string => typeof f === "string") : [],
    insertions: typeof res.insertions === "number" ? res.insertions : 0,
    deletions: typeof res.deletions === "number" ? res.deletions : 0,
    skippedLinks: typeof res.skippedLinks === "number" ? res.skippedLinks : 0,
    via,
  };
}

/** "14:02" today, "Nov 21 14:02" otherwise, in the given zone. */
export function formatUndoTime(ms: number, timezone?: string, now: number = Date.now()): string {
  const zone = timezone ? { timeZone: timezone } : {};
  try {
    const day = (t: number): string => new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
    const time = new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
    if (day(ms) === day(now)) return time;
    const date = new Intl.DateTimeFormat("en-US", { ...zone, month: "short", day: "numeric" }).format(ms);
    return `${date} ${time}`;
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function scopeKey(scope: UndoScope): string {
  return scope.kind === "chat" ? `chat:${scope.sessionKey}` : `task:${scope.taskId}`;
}
