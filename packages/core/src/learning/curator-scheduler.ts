/**
 * Curator runs and their schedule (PLAN C.4 "Schedule", R4 item 4).
 *
 * - `CuratorReport` is the stored result of one run (`curator_runs.report`).
 *   It names skills, detectors and proposal ids; it never holds file bodies.
 * - `CuratorRunStore` reads and writes `curator_runs`.
 * - `CuratorScheduler` is driven by the heartbeat tick, not by a row in
 *   `schedules` (the agent's `schedule_delete` tool can remove those, and
 *   croner jobs do not catch up after downtime). Every 360th tick (hourly) it
 *   checks: effective `curator.enabled`; at least `intervalHours` since the
 *   last scheduled run; the local hour is `preferredHour` (or the run is more
 *   than 24 h overdue); no chat turn in the last `minIdleMinutes`. The first
 *   check after the curator is turned on only seeds the timestamp, so the
 *   first automatic run is one interval later.
 *
 * A run only reports and files proposals. It never moves or edits a skill.
 */

import { createModuleLogger } from "../logging/logger.js";
import type { LearningDb } from "./learning-db.js";

const log = createModuleLogger("curator-scheduler");

export const CURATOR_ENABLED_SETTING = "curator.enabled";
/** kv: ISO time of the last scheduled run (or of the seeding check). */
export const CURATOR_LAST_RUN_KEY = "curator:last_run_at";
/** kv: set by the first inventory sync, which adopts every existing skill's current content. */
export const CURATOR_INVENTORY_INITIALIZED_KEY = "curator:inventory_initialized_at";
/** Heartbeat ticks are 10 s apart: 360 ticks is one hour. */
export const CURATOR_CHECK_TICKS = 360;

const HOUR_MS = 3_600_000;
const OVERDUE_GRACE_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CuratorTrigger = "schedule" | "command";
export type CuratorCategory = "broken" | "duplicate" | "stale" | "drift";

export interface CuratorFinding {
  skill: string;
  root: "project" | "user";
  /** B1..B10, D1..D4, stale, archive, drift */
  detector: string;
  category: CuratorCategory;
  severity: "error" | "warn" | "info";
  message: string;
  data?: Record<string, unknown>;
}

export interface CuratorProposalRef {
  id: number;
  kind: string;
  skill: string;
  title: string;
}

export interface CuratorReport {
  version: 1;
  trigger: CuratorTrigger;
  startedAt: string;
  finishedAt: string;
  /** The LLM merge pass ran (curator.llm, or /curator run merge) */
  merge: boolean;
  counts: {
    skills: number;
    broken: number;
    duplicates: number;
    stale: number;
    drift: number;
    proposals: number;
  };
  findings: CuratorFinding[];
  proposals: CuratorProposalRef[];
  /** Proposals the curator wanted to file but intake or a cap refused */
  dropped: Array<{ kind: string; skill: string; reason: string }>;
  /** Skills whose state became `stale` in this run */
  staleMarked: string[];
  /** Clusters of possible duplicates that were reported but not proposed */
  possibleDuplicates: string[][];
  llm: { calls: number; costUsd: number; errors: number };
  errors: string[];
}

export interface CuratorRunRecord {
  id: number;
  trigger: CuratorTrigger;
  startedAt: string;
  finishedAt: string | null;
  report: CuratorReport | null;
}

interface CuratorRunRow {
  id: number;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  report: string;
}

function parseReport(text: string): CuratorReport | null {
  try {
    const v = JSON.parse(text) as Partial<CuratorReport>;
    return v && v.version === 1 && Array.isArray(v.findings) ? (v as CuratorReport) : null;
  } catch {
    return null;
  }
}

function toRun(r: CuratorRunRow): CuratorRunRecord {
  return {
    id: r.id,
    trigger: r.trigger === "schedule" ? "schedule" : "command",
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    report: parseReport(r.report),
  };
}

export class CuratorRunStore {
  constructor(private readonly db: LearningDb) {}

  start(trigger: CuratorTrigger, startedAt: string): number {
    return Number(this.db.prepare("INSERT INTO curator_runs (trigger, started_at) VALUES (?, ?)").run(trigger, startedAt).lastInsertRowid);
  }

  finish(id: number, report: CuratorReport): void {
    this.db.prepare("UPDATE curator_runs SET finished_at = ?, report = ? WHERE id = ?").run(report.finishedAt, JSON.stringify(report), id);
  }

  /** The newest finished run. */
  last(): CuratorRunRecord | null {
    const row = this.db.prepare("SELECT * FROM curator_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1").get() as CuratorRunRow | undefined;
    return row ? toRun(row) : null;
  }

  list(limit = 10): CuratorRunRecord[] {
    const n = Math.max(1, Math.min(limit, 100));
    return (this.db.prepare("SELECT * FROM curator_runs ORDER BY id DESC LIMIT ?").all(n) as CuratorRunRow[]).map(toRun);
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Hour of day (0-23) in an IANA time zone; UTC when the zone is unknown. */
export function curatorLocalHour(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) return hour;
  } catch {
    // unknown zone: fall through
  }
  return at.getUTCHours();
}

export type CuratorCheckResult = "disabled" | "seeded" | "not_due" | "not_hour" | "busy" | "running" | "started";

export interface CuratorSchedulerDeps {
  kv: { get(key: string): string | undefined; set(key: string, value: string): void };
  /** Effective curator.enabled (runtime override ?? config) */
  enabled: () => boolean;
  config: () => { intervalHours: number; preferredHour: number; minIdleMinutes: number };
  /** proactive.activeHours.timezone */
  timeZone: () => string;
  /** Epoch ms of the most recent chat turn, or null when none is known */
  lastActivityAt: () => number | null;
  isRunning: () => boolean;
  /** Starts a scheduled run. Must not reject (errors are logged by the caller). */
  run: () => Promise<unknown>;
  now?: () => Date;
}

export class CuratorScheduler {
  constructor(private readonly deps: CuratorSchedulerDeps) {}

  /** Heartbeat tick listener: one check per hour. */
  readonly onTick = (ev: { tickNumber: number }): void => {
    if (ev.tickNumber % CURATOR_CHECK_TICKS !== 0) return;
    try {
      this.check();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "curator schedule check failed");
    }
  };

  /** One schedule check. Exposed for tests and for the status line. */
  check(): CuratorCheckResult {
    if (!this.deps.enabled()) return "disabled";
    const now = this.deps.now?.() ?? new Date();
    const last = Date.parse(this.deps.kv.get(CURATOR_LAST_RUN_KEY) ?? "");
    if (!Number.isFinite(last)) {
      this.deps.kv.set(CURATOR_LAST_RUN_KEY, now.toISOString());
      return "seeded";
    }
    const cfg = this.deps.config();
    const interval = cfg.intervalHours * HOUR_MS;
    const elapsed = now.getTime() - last;
    if (elapsed < interval) return "not_due";
    const overdue = elapsed >= interval + OVERDUE_GRACE_MS;
    if (!overdue && curatorLocalHour(now, this.deps.timeZone()) !== cfg.preferredHour) return "not_hour";
    const activity = this.deps.lastActivityAt();
    if (activity !== null && now.getTime() - activity < cfg.minIdleMinutes * 60_000) return "busy";
    if (this.deps.isRunning()) return "running";
    // Stamp first, so a run that fails is retried next interval and not every hour.
    this.deps.kv.set(CURATOR_LAST_RUN_KEY, now.toISOString());
    void this.deps.run().catch((err: unknown) => {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "scheduled curator run failed");
    });
    return "started";
  }

  /** When the next scheduled run becomes eligible, or null when it is not scheduled (off, or not seeded yet). */
  nextEligibleAt(): Date | null {
    if (!this.deps.enabled()) return null;
    const last = Date.parse(this.deps.kv.get(CURATOR_LAST_RUN_KEY) ?? "");
    if (!Number.isFinite(last)) return null;
    return new Date(last + this.deps.config().intervalHours * HOUR_MS);
  }
}
