/**
 * LoopStore - persistent rows for /loop recurring prompts (PLAN C.8).
 *
 * Own file `~/.kirie/loops.db` (WAL, 0600, busy_timeout 3000). The daemon
 * reads and writes it; the stdio MCP subprocess opens it for `loop_create`
 * (a pending_approval row only), `loop_list` and `loop_stop`.
 *
 * A row stores the chat route, so restart recovery is a scan of the table.
 */

import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LoopStatus =
  | "pending_approval" // created by the agent, waiting for the owner (or the agentCreate policy)
  | "active"
  | "paused"
  | "done"             // LOOP_COMPLETE or max runs reached
  | "expired"
  | "cancelled"        // stopped by the owner or the agent
  | "declined";        // an agent-created loop the owner (or the policy) did not start

/** Statuses a loop never leaves. */
export const LOOP_ENDED_STATUSES: ReadonlySet<LoopStatus> = new Set(["done", "expired", "cancelled", "declined"]);

export type LoopCreatedBy = "owner" | "agent";

export interface LoopRecord {
  id: string;
  sessionKey: string;
  channel: string;
  chatId: string;
  chatType: string;
  prompt: string;
  baseIntervalSec: number;
  currentIntervalSec: number;
  backoff: boolean;
  status: LoopStatus;
  /** Why a paused loop is paused: "owner", "disabled" (/loop off), "errors" */
  pauseReason: string | null;
  runs: number;
  maxRuns: number;
  quietStreak: number;
  errorStreak: number;
  /** sha256 of the normalised last reported reply */
  lastDigest: string | null;
  /** First characters of the last reported reply, shown to the agent on the next tick */
  lastReport: string | null;
  /** ms epoch */
  nextRunAt: number;
  expiresAt: number;
  lastRunAt: number | null;
  lastStatus: string | null;
  createdBy: LoopCreatedBy;
  createdAt: number;
  updatedAt: number;
  /** For ended loops: "complete", "max-runs", "owner", "agent", "expired", "declined:<why>" */
  endedReason: string | null;
}

export interface LoopCreateInput {
  sessionKey: string;
  channel: string;
  chatId: string;
  chatType: string;
  prompt: string;
  intervalSec: number;
  backoff: boolean;
  maxRuns: number;
  expiresAt: number;
  createdBy: LoopCreatedBy;
  status: "active" | "pending_approval";
  /** Default: now (the first run happens at the next heartbeat tick) */
  nextRunAt?: number;
  now?: number;
}

export type LoopPatch = Partial<Omit<LoopRecord, "id" | "createdAt" | "createdBy" | "sessionKey" | "channel" | "chatId" | "chatType">>;

interface LoopRow {
  id: string;
  session_key: string;
  channel: string;
  chat_id: string;
  chat_type: string;
  prompt: string;
  base_interval_sec: number;
  current_interval_sec: number;
  backoff: number;
  status: string;
  pause_reason: string | null;
  runs: number;
  max_runs: number;
  quiet_streak: number;
  error_streak: number;
  last_digest: string | null;
  last_report: string | null;
  next_run_at: number;
  expires_at: number;
  last_run_at: number | null;
  last_status: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  ended_reason: string | null;
}

const COLUMN_OF: Record<keyof LoopPatch, keyof LoopRow> = {
  prompt: "prompt",
  baseIntervalSec: "base_interval_sec",
  currentIntervalSec: "current_interval_sec",
  backoff: "backoff",
  status: "status",
  pauseReason: "pause_reason",
  runs: "runs",
  maxRuns: "max_runs",
  quietStreak: "quiet_streak",
  errorStreak: "error_streak",
  lastDigest: "last_digest",
  lastReport: "last_report",
  nextRunAt: "next_run_at",
  expiresAt: "expires_at",
  lastRunAt: "last_run_at",
  lastStatus: "last_status",
  updatedAt: "updated_at",
  endedReason: "ended_reason",
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const LOOP_ID_RE = /^l-[a-z2-7]{5}$/;

function newLoopId(): string {
  const bytes = randomBytes(5);
  let out = "l-";
  for (const b of bytes) out += ID_ALPHABET[b % 32];
  return out;
}

function fromRow(r: LoopRow): LoopRecord {
  return {
    id: r.id,
    sessionKey: r.session_key,
    channel: r.channel,
    chatId: r.chat_id,
    chatType: r.chat_type,
    prompt: r.prompt,
    baseIntervalSec: r.base_interval_sec,
    currentIntervalSec: r.current_interval_sec,
    backoff: r.backoff === 1,
    status: r.status as LoopStatus,
    pauseReason: r.pause_reason,
    runs: r.runs,
    maxRuns: r.max_runs,
    quietStreak: r.quiet_streak,
    errorStreak: r.error_streak,
    lastDigest: r.last_digest,
    lastReport: r.last_report,
    nextRunAt: r.next_run_at,
    expiresAt: r.expires_at,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    createdBy: r.created_by === "agent" ? "agent" : "owner",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    endedReason: r.ended_reason,
  };
}

function tightenMode(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(p)) chmodSync(p, 0o600);
    } catch {
      // Best effort: the directory may not allow it (tests on odd filesystems)
    }
  }
}

export class LoopStore {
  private readonly db: Database.Database;

  constructor(readonly dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS loops (
        id                   TEXT PRIMARY KEY,
        session_key          TEXT NOT NULL,
        channel              TEXT NOT NULL,
        chat_id              TEXT NOT NULL,
        chat_type            TEXT NOT NULL,
        prompt               TEXT NOT NULL,
        base_interval_sec    INTEGER NOT NULL,
        current_interval_sec INTEGER NOT NULL,
        backoff              INTEGER NOT NULL DEFAULT 1,
        status               TEXT NOT NULL,
        pause_reason         TEXT,
        runs                 INTEGER NOT NULL DEFAULT 0,
        max_runs             INTEGER NOT NULL,
        quiet_streak         INTEGER NOT NULL DEFAULT 0,
        error_streak         INTEGER NOT NULL DEFAULT 0,
        last_digest          TEXT,
        last_report          TEXT,
        next_run_at          INTEGER NOT NULL,
        expires_at           INTEGER NOT NULL,
        last_run_at          INTEGER,
        last_status          TEXT,
        created_by           TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL,
        ended_reason         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_loops_status_next ON loops (status, next_run_at);
    `);
    if (dbPath !== ":memory:") tightenMode(dbPath);
  }

  create(input: LoopCreateInput): LoopRecord {
    const now = input.now ?? Date.now();
    let id = newLoopId();
    for (let i = 0; i < 8 && this.get(id); i++) id = newLoopId();
    if (this.get(id)) throw new Error("could not allocate a loop id");
    this.db.prepare(`
      INSERT INTO loops (id, session_key, channel, chat_id, chat_type, prompt, base_interval_sec,
        current_interval_sec, backoff, status, runs, max_runs, next_run_at, expires_at, created_by,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.sessionKey, input.channel, input.chatId, input.chatType, input.prompt,
      input.intervalSec, input.intervalSec, input.backoff ? 1 : 0, input.status, input.maxRuns,
      input.nextRunAt ?? now, input.expiresAt, input.createdBy, now, now,
    );
    return this.get(id)!;
  }

  get(id: string): LoopRecord | null {
    const row = this.db.prepare("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** Newest first. */
  list(opts: { statuses?: readonly LoopStatus[]; sessionKey?: string; limit?: number } = {}): LoopRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(`status IN (${opts.statuses.map(() => "?").join(", ")})`);
      params.push(...opts.statuses);
    }
    if (opts.sessionKey) {
      where.push("session_key = ?");
      params.push(opts.sessionKey);
    }
    const sql = `SELECT * FROM loops${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`
      + ` ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    return (this.db.prepare(sql).all(...params) as LoopRow[]).map(fromRow);
  }

  count(status: LoopStatus): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM loops WHERE status = ?").get(status) as { n: number };
    return row.n;
  }

  /** Active loops whose next run is due, soonest first. */
  due(now: number): LoopRecord[] {
    return (this.db.prepare(
      "SELECT * FROM loops WHERE status = 'active' AND next_run_at <= ? ORDER BY next_run_at, id",
    ).all(now) as LoopRow[]).map(fromRow);
  }

  update(id: string, patch: LoopPatch, now: number = Date.now()): LoopRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    const withTime: LoopPatch = { ...patch, updatedAt: patch.updatedAt ?? now };
    for (const [key, value] of Object.entries(withTime) as Array<[keyof LoopPatch, unknown]>) {
      const column = COLUMN_OF[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    if (sets.length > 0) {
      params.push(id);
      this.db.prepare(`UPDATE loops SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    }
    return this.get(id);
  }

  /**
   * Compare-and-set status change: applies `patch` (which should set `status`)
   * only while the row is in one of `from`. Another process (loop_stop in the
   * stdio server) may have ended the loop since it was read; then nothing is
   * written and null is returned.
   */
  transition(id: string, from: readonly LoopStatus[], patch: LoopPatch, now: number = Date.now()): LoopRecord | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries({ ...patch, updatedAt: patch.updatedAt ?? now }) as Array<[keyof LoopPatch, unknown]>) {
      const column = COLUMN_OF[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    if (from.length === 0) return null;
    const res = this.db.prepare(
      `UPDATE loops SET ${sets.join(", ")} WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
    ).run(...params, id, ...from);
    return res.changes === 1 ? this.get(id) : null;
  }

  /**
   * Compare-and-set claim before a run: only an active loop whose next run is
   * still the one the caller saw is claimed. The provisional next run is
   * written now, so a crash mid-run never leaves the loop wedged.
   */
  claim(id: string, expectedNextRunAt: number, provisionalNextRunAt: number, now: number): boolean {
    const res = this.db.prepare(
      "UPDATE loops SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND next_run_at = ?",
    ).run(provisionalNextRunAt, now, now, id, expectedNextRunAt);
    return res.changes === 1;
  }

  /**
   * End a loop unless it has already ended. Returns the updated row, or null
   * when the loop does not exist or had already ended.
   */
  end(id: string, status: "done" | "expired" | "cancelled" | "declined", reason: string, now: number = Date.now()): LoopRecord | null {
    const res = this.db.prepare(
      `UPDATE loops SET status = ?, ended_reason = ?, pause_reason = NULL, updated_at = ?
       WHERE id = ? AND status NOT IN ('done', 'expired', 'cancelled', 'declined')`,
    ).run(status, reason, now, id);
    return res.changes === 1 ? this.get(id) : null;
  }

  /** After a restart: overdue active loops run once, `delayMs` from now (missed ticks coalesce). */
  reanchorOverdue(now: number, delayMs: number): number {
    const res = this.db.prepare(
      "UPDATE loops SET next_run_at = ?, updated_at = ? WHERE status = 'active' AND next_run_at < ?",
    ).run(now + delayMs, now, now);
    return res.changes;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
