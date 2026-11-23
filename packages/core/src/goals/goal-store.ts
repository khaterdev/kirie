/**
 * GoalStore: durable state of /goal (PLAN C.7, R2 section 2 "Data").
 *
 * One SQLite file, `~/.kirie/goals.db` (WAL, 0600, busy_timeout 3000), opened
 * read-write by the daemon and by the stdio MCP subprocess (goal_create writes
 * a `pending_approval` row, goal_stop writes a `goal_commands` row). Every
 * status change goes through `transition`, which only moves a row that is
 * still in one of the expected states, so a stop that races a verdict can
 * never be overwritten.
 */

import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createModuleLogger } from "../logging/logger.js";

const log = createModuleLogger("goal-store");

export type GoalStatus =
  | "pending_approval"
  | "pending"
  | "running"
  | "checking"
  | "judging"
  | "paused"
  | "done"
  | "blocked"
  | "exhausted"
  | "failed"
  | "cancelled";

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "pending_approval", "pending", "running", "checking", "judging",
  "paused", "done", "blocked", "exhausted", "failed", "cancelled",
];

/** A worker round is in flight or being evaluated. */
export const GOAL_ACTIVE_STATUSES: readonly GoalStatus[] = ["running", "checking", "judging"];
/** Never change again. */
export const GOAL_TERMINAL_STATUSES: readonly GoalStatus[] = ["done", "failed", "cancelled"];
/** The owner can resume these with a fresh allowance. */
export const GOAL_RESUMABLE_STATUSES: readonly GoalStatus[] = ["paused", "blocked", "exhausted"];
/** Not finished: everything except the terminal states. */
export const GOAL_OPEN_STATUSES: readonly GoalStatus[] = GOAL_STATUSES.filter(
  (s) => !GOAL_TERMINAL_STATUSES.includes(s),
);

export type GoalCreatedBy = "owner" | "agent";

/**
 * How the next worker session starts: a fresh goal, an owner resume, after a
 * daemon restart, or a retry after the worker died.
 */
export type GoalStartMode = "start" | "resume" | "restart" | "retry";

/** A must-pass check, fixed at creation. */
export interface GoalCheck {
  command: string;
  timeoutSec: number;
}

/** The tool-gate verdict a check got when the goal was created. */
export interface GoalCheckReview {
  command: string;
  decision: "pass" | "ask";
  reasons: string[];
}

export interface GoalCheckResult {
  command: string;
  passed: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Last 2000 chars of combined stdout and stderr, scrubbed */
  output: string;
  durationMs: number;
}

export type GoalVerdictKind = "done" | "continue" | "blocked";

export interface GoalVerdictRecord {
  verdict: GoalVerdictKind;
  reason: string;
  missing: string[];
  /** Where the verdict came from: the judge, a failing check, an error round, or a judge failure */
  source: "judge" | "check" | "error" | "judge_failure";
}

export interface GoalRecord {
  id: string;
  sessionKey: string;
  goal: string;
  status: GoalStatus;
  checks: GoalCheck[];
  /**
   * False when the stored check list no longer parses or no longer matches the
   * hash taken at creation (someone edited goals.db). The controller then
   * refuses to evaluate the goal: a changed check list must never pass.
   */
  checksIntact: boolean;
  checkReview: GoalCheckReview[];
  cwd: string | null;
  /** Per-allowance caps, as requested */
  maxRounds: number;
  maxMinutes: number;
  maxCostUsd: number;
  /** Absolute limits now in force (grow on /goal resume) */
  roundLimit: number;
  costLimitUsd: number;
  deadlineAtMs: number | null;
  startedAtMs: number | null;
  roundsUsed: number;
  /** Worker plus judge, estimated */
  costUsd: number;
  workerCostUsd: number;
  /** Last cumulative total_cost_usd seen from the current worker session */
  workerCostLast: number;
  judgeCostUsd: number;
  sdkTurns: number;
  taskId: string | null;
  sdkSessionId: string | null;
  lastVerdict: GoalVerdictRecord | null;
  lastChecks: GoalCheckResult[] | null;
  /** Tail of the worker's last reply, scrubbed */
  lastReport: string | null;
  /** One line per evaluated round, oldest first (capped) */
  roundLog: string[];
  stopReason: string | null;
  pauseRequested: boolean;
  judgeFailures: number;
  errorRounds: number;
  /** Extra instructions given with /goal resume, consumed by the next worker message */
  resumeNote: string | null;
  startMode: GoalStartMode;
  createdBy: GoalCreatedBy;
  createdAt: string;
  updatedAt: string;
}

interface GoalRow {
  id: string;
  session_key: string;
  goal: string;
  status: string;
  checks: string;
  checks_hash: string;
  check_review: string;
  cwd: string | null;
  max_rounds: number;
  max_minutes: number;
  max_cost_usd: number;
  round_limit: number;
  cost_limit_usd: number;
  deadline_at_ms: number | null;
  started_at_ms: number | null;
  rounds_used: number;
  cost_usd: number;
  worker_cost_usd: number;
  worker_cost_last: number;
  judge_cost_usd: number;
  sdk_turns: number;
  task_id: string | null;
  sdk_session_id: string | null;
  last_verdict: string | null;
  last_checks: string | null;
  last_report: string | null;
  round_log: string;
  stop_reason: string | null;
  pause_requested: number;
  judge_failures: number;
  error_rounds: number;
  resume_note: string | null;
  start_mode: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Columns `update`/`transition` may change. */
export interface GoalPatch {
  roundLimit?: number;
  costLimitUsd?: number;
  maxCostUsd?: number;
  deadlineAtMs?: number | null;
  startedAtMs?: number | null;
  roundsUsed?: number;
  costUsd?: number;
  workerCostUsd?: number;
  workerCostLast?: number;
  judgeCostUsd?: number;
  sdkTurns?: number;
  taskId?: string | null;
  sdkSessionId?: string | null;
  lastVerdict?: GoalVerdictRecord | null;
  lastChecks?: GoalCheckResult[] | null;
  lastReport?: string | null;
  roundLog?: string[];
  stopReason?: string | null;
  pauseRequested?: boolean;
  judgeFailures?: number;
  errorRounds?: number;
  resumeNote?: string | null;
  startMode?: GoalStartMode;
}

const PATCH_COLUMNS: Record<keyof GoalPatch, { column: string; encode: (v: never) => unknown }> = {
  roundLimit: { column: "round_limit", encode: (v: number) => v },
  costLimitUsd: { column: "cost_limit_usd", encode: (v: number) => v },
  maxCostUsd: { column: "max_cost_usd", encode: (v: number) => v },
  deadlineAtMs: { column: "deadline_at_ms", encode: (v: number | null) => v },
  startedAtMs: { column: "started_at_ms", encode: (v: number | null) => v },
  roundsUsed: { column: "rounds_used", encode: (v: number) => v },
  costUsd: { column: "cost_usd", encode: (v: number) => v },
  workerCostUsd: { column: "worker_cost_usd", encode: (v: number) => v },
  workerCostLast: { column: "worker_cost_last", encode: (v: number) => v },
  judgeCostUsd: { column: "judge_cost_usd", encode: (v: number) => v },
  sdkTurns: { column: "sdk_turns", encode: (v: number) => v },
  taskId: { column: "task_id", encode: (v: string | null) => v },
  sdkSessionId: { column: "sdk_session_id", encode: (v: string | null) => v },
  lastVerdict: { column: "last_verdict", encode: (v: GoalVerdictRecord | null) => (v ? JSON.stringify(v) : null) },
  lastChecks: { column: "last_checks", encode: (v: GoalCheckResult[] | null) => (v ? JSON.stringify(v) : null) },
  lastReport: { column: "last_report", encode: (v: string | null) => v },
  roundLog: { column: "round_log", encode: (v: string[]) => JSON.stringify(v) },
  stopReason: { column: "stop_reason", encode: (v: string | null) => v },
  pauseRequested: { column: "pause_requested", encode: (v: boolean) => (v ? 1 : 0) },
  judgeFailures: { column: "judge_failures", encode: (v: number) => v },
  errorRounds: { column: "error_rounds", encode: (v: number) => v },
  resumeNote: { column: "resume_note", encode: (v: string | null) => v },
  startMode: { column: "start_mode", encode: (v: GoalStartMode) => v },
};

export interface GoalCreateInput {
  sessionKey: string;
  goal: string;
  status: "pending_approval" | "pending";
  checks?: GoalCheck[];
  checkReview?: GoalCheckReview[];
  cwd?: string | null;
  maxRounds: number;
  maxMinutes: number;
  maxCostUsd: number;
  createdBy: GoalCreatedBy;
}

export interface GoalEvent {
  id: number;
  goalId: string;
  ts: string;
  kind: string;
  data: Record<string, unknown> | null;
}

export type GoalCommandAction = "stop";

export interface GoalCommand {
  id: string;
  goalId: string;
  action: GoalCommandAction;
  data: string | null;
  createdAt: string;
}

/** kv keys the daemon writes and the goal tools in the stdio MCP subprocess read. */
export const GOAL_KV_ENABLED = "goals.enabled";
export const GOAL_KV_AGENT_CREATE = "goals.agentCreate";
export const GOAL_KV_AGENT_CAPS = "goals.agentCaps";

/** Caps an agent-created goal may ask for at most (the configured per-goal defaults). */
export interface GoalAgentCaps {
  maxRounds: number;
  maxMinutes: number;
  maxCostUsd: number;
}

/** "g-" + 6 base32 characters (a-z, 2-7). */
export const GOAL_ID_RE = /^g-[a-z2-7]{6}$/;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
/** Lines kept in round_log. */
export const GOAL_ROUND_LOG_MAX = 30;

export function newGoalId(): string {
  const bytes = randomBytes(6);
  let out = "g-";
  for (const b of bytes) out += BASE32[b % 32];
  return out;
}

/** Hash of the stored check list, taken at creation and verified on every read. */
export function goalChecksHash(checksJson: string): string {
  return createHash("sha256").update(`kirie-goal-checks\0${checksJson}`).digest("hex");
}

/** The stored check list, or null when it is not a well-formed list (fail closed). */
function parseChecks(raw: string): GoalCheck[] | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    for (const c of v) {
      if (typeof c !== "object" || c === null) return null;
      const { command, timeoutSec } = c as Record<string, unknown>;
      if (typeof command !== "string" || !command || typeof timeoutSec !== "number" || !(timeoutSec > 0)) return null;
    }
    return v as GoalCheck[];
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class GoalStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(dbPath)) closeSync(openSync(dbPath, "a", 0o600));
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(p)) chmodSync(p, 0o600);
      } catch (err) {
        log.warn({ path: p, err }, "could not set goals database mode");
      }
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id                TEXT PRIMARY KEY,
        session_key       TEXT NOT NULL,
        goal              TEXT NOT NULL,
        status            TEXT NOT NULL,
        checks            TEXT NOT NULL DEFAULT '[]',
        checks_hash       TEXT NOT NULL DEFAULT '',
        check_review      TEXT NOT NULL DEFAULT '[]',
        cwd               TEXT,
        max_rounds        INTEGER NOT NULL,
        max_minutes       INTEGER NOT NULL,
        max_cost_usd      REAL NOT NULL,
        round_limit       INTEGER NOT NULL,
        cost_limit_usd    REAL NOT NULL,
        deadline_at_ms    INTEGER,
        started_at_ms     INTEGER,
        rounds_used       INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL NOT NULL DEFAULT 0,
        worker_cost_usd   REAL NOT NULL DEFAULT 0,
        worker_cost_last  REAL NOT NULL DEFAULT 0,
        judge_cost_usd    REAL NOT NULL DEFAULT 0,
        sdk_turns         INTEGER NOT NULL DEFAULT 0,
        task_id           TEXT,
        sdk_session_id    TEXT,
        last_verdict      TEXT,
        last_checks       TEXT,
        last_report       TEXT,
        round_log         TEXT NOT NULL DEFAULT '[]',
        stop_reason       TEXT,
        pause_requested   INTEGER NOT NULL DEFAULT 0,
        judge_failures    INTEGER NOT NULL DEFAULT 0,
        error_rounds      INTEGER NOT NULL DEFAULT 0,
        resume_note       TEXT,
        start_mode        TEXT NOT NULL DEFAULT 'start',
        created_by        TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
      CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_key);

      CREATE TABLE IF NOT EXISTS goal_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id  TEXT NOT NULL,
        ts       TEXT NOT NULL,
        kind     TEXT NOT NULL,
        data     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id);

      CREATE TABLE IF NOT EXISTS goal_commands (
        id          TEXT PRIMARY KEY,
        goal_id     TEXT NOT NULL,
        action      TEXT NOT NULL,
        data        TEXT,
        processed   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_commands_unprocessed
        ON goal_commands(processed) WHERE processed = 0;

      CREATE TABLE IF NOT EXISTS kv (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
    `);
  }

  private rowToGoal(row: GoalRow): GoalRecord {
    const checks = parseChecks(row.checks);
    return {
      id: row.id,
      sessionKey: row.session_key,
      goal: row.goal,
      status: row.status as GoalStatus,
      checks: checks ?? [],
      checksIntact: checks !== null && row.checks_hash === goalChecksHash(row.checks),
      checkReview: parseJson<GoalCheckReview[]>(row.check_review, []),
      cwd: row.cwd,
      maxRounds: row.max_rounds,
      maxMinutes: row.max_minutes,
      maxCostUsd: row.max_cost_usd,
      roundLimit: row.round_limit,
      costLimitUsd: row.cost_limit_usd,
      deadlineAtMs: row.deadline_at_ms,
      startedAtMs: row.started_at_ms,
      roundsUsed: row.rounds_used,
      costUsd: row.cost_usd,
      workerCostUsd: row.worker_cost_usd,
      workerCostLast: row.worker_cost_last,
      judgeCostUsd: row.judge_cost_usd,
      sdkTurns: row.sdk_turns,
      taskId: row.task_id,
      sdkSessionId: row.sdk_session_id,
      lastVerdict: parseJson<GoalVerdictRecord | null>(row.last_verdict, null),
      lastChecks: parseJson<GoalCheckResult[] | null>(row.last_checks, null),
      lastReport: row.last_report,
      roundLog: parseJson<string[]>(row.round_log, []),
      stopReason: row.stop_reason,
      pauseRequested: row.pause_requested === 1,
      judgeFailures: row.judge_failures,
      errorRounds: row.error_rounds,
      resumeNote: row.resume_note,
      startMode: (["start", "resume", "restart", "retry"].includes(row.start_mode) ? row.start_mode : "start") as GoalStartMode,
      createdBy: row.created_by === "agent" ? "agent" : "owner",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Insert a new goal. The round and cost limits start equal to the requested caps. */
  create(input: GoalCreateInput): GoalRecord {
    const now = new Date().toISOString();
    const checksJson = JSON.stringify(input.checks ?? []);
    for (let attempt = 0; attempt < 8; attempt++) {
      const id = newGoalId();
      try {
        this.db
          .prepare(
            `INSERT INTO goals (id, session_key, goal, status, checks, checks_hash, check_review, cwd,
               max_rounds, max_minutes, max_cost_usd, round_limit, cost_limit_usd,
               created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id, input.sessionKey, input.goal, input.status,
            checksJson, goalChecksHash(checksJson), JSON.stringify(input.checkReview ?? []), input.cwd ?? null,
            input.maxRounds, input.maxMinutes, input.maxCostUsd, input.maxRounds, input.maxCostUsd,
            input.createdBy, now, now,
          );
        this.addEvent(id, "created", { by: input.createdBy, status: input.status });
        return this.get(id)!;
      } catch (err) {
        if (err instanceof Error && /UNIQUE|PRIMARY KEY/i.test(err.message)) continue;
        throw err;
      }
    }
    throw new Error("could not allocate a goal id");
  }

  get(id: string): GoalRecord | null {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as GoalRow | undefined;
    return row ? this.rowToGoal(row) : null;
  }

  /** Goals in any of the given states, oldest first. */
  listByStatus(statuses: readonly GoalStatus[]): GoalRecord[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT * FROM goals WHERE status IN (${marks}) ORDER BY created_at ASC, rowid ASC`)
      .all(...statuses) as GoalRow[];
    return rows.map((r) => this.rowToGoal(r));
  }

  /** Most recent goals first, optionally for one chat. */
  listRecent(opts: { sessionKey?: string; limit?: number } = {}): GoalRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
    const rows = (opts.sessionKey
      ? this.db
          .prepare("SELECT * FROM goals WHERE session_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(opts.sessionKey, limit)
      : this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)) as GoalRow[];
    return rows.map((r) => this.rowToGoal(r));
  }

  /** Change columns without touching the status. Returns false when the goal does not exist. */
  update(id: string, patch: GoalPatch): boolean {
    const { sql, values } = this.patchSql(patch);
    const info = this.db
      .prepare(`UPDATE goals SET ${sql}updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id);
    return info.changes > 0;
  }

  /**
   * Move a goal to `to` only if it is currently in one of `from`, applying
   * `patch` in the same statement. Terminal goals never move. Returns true
   * when the row changed.
   */
  transition(id: string, from: readonly GoalStatus[], to: GoalStatus, patch: GoalPatch = {}, event?: Record<string, unknown>): boolean {
    const allowed = from.filter((s) => !GOAL_TERMINAL_STATUSES.includes(s));
    if (allowed.length === 0) return false;
    const { sql, values } = this.patchSql(patch);
    const marks = allowed.map(() => "?").join(", ");
    const info = this.db
      .prepare(`UPDATE goals SET ${sql}status = ?, updated_at = ? WHERE id = ? AND status IN (${marks})`)
      .run(...values, to, new Date().toISOString(), id, ...allowed);
    if (info.changes > 0) {
      this.addEvent(id, `status.${to}`, event ?? null);
      return true;
    }
    return false;
  }

  private patchSql(patch: GoalPatch): { sql: string; values: unknown[] } {
    let sql = "";
    const values: unknown[] = [];
    for (const key of Object.keys(patch) as Array<keyof GoalPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      const spec = PATCH_COLUMNS[key];
      sql += `${spec.column} = ?, `;
      values.push(spec.encode(value as never));
    }
    return { sql, values };
  }

  addEvent(goalId: string, kind: string, data: Record<string, unknown> | null): void {
    this.db
      .prepare("INSERT INTO goal_events (goal_id, ts, kind, data) VALUES (?, ?, ?, ?)")
      .run(goalId, new Date().toISOString(), kind, data ? JSON.stringify(data) : null);
  }

  events(goalId: string, limit = 50): GoalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT ?")
      .all(goalId, limit) as Array<{ id: number; goal_id: string; ts: string; kind: string; data: string | null }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      goalId: r.goal_id,
      ts: r.ts,
      kind: r.kind,
      data: parseJson<Record<string, unknown> | null>(r.data, null),
    }));
  }

  // ── Commands (stdio MCP subprocess -> daemon) ────────────────────────────

  addCommand(goalId: string, action: GoalCommandAction, data?: string): string {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO goal_commands (id, goal_id, action, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, goalId, action, data ?? null, new Date().toISOString());
    return id;
  }

  unprocessedCommands(): GoalCommand[] {
    const rows = this.db
      .prepare("SELECT * FROM goal_commands WHERE processed = 0 ORDER BY created_at ASC, rowid ASC")
      .all() as Array<{ id: string; goal_id: string; action: string; data: string | null; created_at: string }>;
    return rows
      .filter((r) => r.action === "stop")
      .map((r) => ({ id: r.id, goalId: r.goal_id, action: r.action as GoalCommandAction, data: r.data, createdAt: r.created_at }));
  }

  markCommandProcessed(id: string): void {
    this.db.prepare("UPDATE goal_commands SET processed = 1 WHERE id = ?").run(id);
  }

  /** Drop commands with an unknown action so they are not read again. */
  discardUnknownCommands(): number {
    return this.db.prepare("UPDATE goal_commands SET processed = 1 WHERE processed = 0 AND action <> 'stop'").run().changes;
  }

  // ── kv (daemon -> stdio subprocess: effective switches) ─────────────────

  getKv(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
