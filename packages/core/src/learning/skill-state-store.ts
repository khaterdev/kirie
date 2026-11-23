/**
 * `skill_state` and `skill_usage` access (R4 item 4 "Tables" and "Usage tracking").
 *
 * W2-LEARN records usage from wave 2 on; the curator (W3-CUR) uses the full
 * CRUD below (insert, bump use, set state, pin, override, approved hash,
 * archive fields) and never edits this file.
 */

import type { LearningDb } from "./learning-db.js";

export type SkillRoot = "project" | "user";
export type SkillSource = "bundled" | "learned" | "local" | "user";
export type SkillLifecycleState = "active" | "stale" | "archived";

export interface SkillStateRecord {
  name: string;
  root: SkillRoot;
  source: SkillSource;
  state: SkillLifecycleState;
  pinned: boolean;
  override: boolean;
  firstSeenAt: string;
  lastUsedAt: string | null;
  useCount: number;
  approvedHash: string | null;
  approvedAt: string | null;
  archivedAt: string | null;
  archivePath: string | null;
  absorbedInto: string | null;
}

interface SkillStateRow {
  name: string;
  root: string;
  source: string;
  state: string;
  pinned: number;
  override: number;
  first_seen_at: string;
  last_used_at: string | null;
  use_count: number;
  approved_hash: string | null;
  approved_at: string | null;
  archived_at: string | null;
  archive_path: string | null;
  absorbed_into: string | null;
}

export interface SkillUsageRecord {
  id: number;
  skill: string;
  ts: string;
  sessionKey: string | null;
  source: string;
  via: "tool" | "read";
  turnLogId: number | null;
}

function toRecord(r: SkillStateRow): SkillStateRecord {
  return {
    name: r.name,
    root: r.root as SkillRoot,
    source: r.source as SkillSource,
    state: r.state as SkillLifecycleState,
    pinned: r.pinned === 1,
    override: r.override === 1,
    firstSeenAt: r.first_seen_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    approvedHash: r.approved_hash,
    approvedAt: r.approved_at,
    archivedAt: r.archived_at,
    archivePath: r.archive_path,
    absorbedInto: r.absorbed_into,
  };
}

export class SkillStateStore {
  constructor(private readonly db: LearningDb) {}

  get(root: SkillRoot, name: string): SkillStateRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_state WHERE root = ? AND name = ?").get(root, name) as SkillStateRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Project root first, then user root. */
  findByName(name: string): SkillStateRecord | null {
    return this.get("project", name) ?? this.get("user", name);
  }

  list(filter: { root?: SkillRoot; state?: SkillLifecycleState } = {}): SkillStateRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.root) { where.push("root = ?"); args.push(filter.root); }
    if (filter.state) { where.push("state = ?"); args.push(filter.state); }
    const sql = `SELECT * FROM skill_state${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY root, name`;
    return (this.db.prepare(sql).all(...args) as SkillStateRow[]).map(toRecord);
  }

  /** Insert when missing; an existing row is left unchanged. Returns true when inserted. */
  insert(row: { name: string; root: SkillRoot; source: SkillSource; firstSeenAt?: string; approvedHash?: string | null; approvedAt?: string | null }): boolean {
    const now = new Date().toISOString();
    return (
      this.db
        .prepare(
          `INSERT OR IGNORE INTO skill_state (name, root, source, state, first_seen_at, approved_hash, approved_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(row.name, row.root, row.source, row.firstSeenAt ?? now, row.approvedHash ?? null, row.approvedAt ?? null).changes === 1
    );
  }

  /** Insert or update source and approved hash (an approved create or patch). */
  upsertApproved(row: { name: string; root: SkillRoot; source: SkillSource; approvedHash: string; at: string }): void {
    this.db
      .prepare(
        `INSERT INTO skill_state (name, root, source, state, first_seen_at, approved_hash, approved_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(root, name) DO UPDATE SET approved_hash = excluded.approved_hash, approved_at = excluded.approved_at,
           state = CASE skill_state.state WHEN 'archived' THEN skill_state.state ELSE 'active' END`,
      )
      .run(row.name, row.root, row.source, row.at, row.approvedHash, row.at);
  }

  /** One use: count, last-used, and stale -> active. Returns true when a row existed. */
  bumpUse(root: SkillRoot, name: string, ts: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE skill_state SET use_count = use_count + 1, last_used_at = ?,
             state = CASE state WHEN 'stale' THEN 'active' ELSE state END
           WHERE root = ? AND name = ?`,
        )
        .run(ts, root, name).changes === 1
    );
  }

  setState(root: SkillRoot, name: string, state: SkillLifecycleState): boolean {
    return this.db.prepare("UPDATE skill_state SET state = ? WHERE root = ? AND name = ?").run(state, root, name).changes === 1;
  }

  setPinned(root: SkillRoot, name: string, pinned: boolean): boolean {
    return this.db.prepare("UPDATE skill_state SET pinned = ? WHERE root = ? AND name = ?").run(pinned ? 1 : 0, root, name).changes === 1;
  }

  setOverride(root: SkillRoot, name: string, override: boolean): boolean {
    return this.db.prepare("UPDATE skill_state SET override = ? WHERE root = ? AND name = ?").run(override ? 1 : 0, root, name).changes === 1;
  }

  setSource(root: SkillRoot, name: string, source: SkillSource): boolean {
    return this.db.prepare("UPDATE skill_state SET source = ? WHERE root = ? AND name = ?").run(source, root, name).changes === 1;
  }

  setApprovedHash(root: SkillRoot, name: string, hash: string | null, at: string): boolean {
    return (
      this.db.prepare("UPDATE skill_state SET approved_hash = ?, approved_at = ? WHERE root = ? AND name = ?").run(hash, at, root, name).changes === 1
    );
  }

  markArchived(root: SkillRoot, name: string, fields: { archivedAt: string; archivePath: string | null; absorbedInto?: string | null }): boolean {
    return (
      this.db
        .prepare("UPDATE skill_state SET state = 'archived', archived_at = ?, archive_path = ?, absorbed_into = ? WHERE root = ? AND name = ?")
        .run(fields.archivedAt, fields.archivePath, fields.absorbedInto ?? null, root, name).changes === 1
    );
  }

  markRestored(root: SkillRoot, name: string): boolean {
    return (
      this.db
        .prepare("UPDATE skill_state SET state = 'active', archived_at = NULL, archive_path = NULL, absorbed_into = NULL WHERE root = ? AND name = ?")
        .run(root, name).changes === 1
    );
  }

  delete(root: SkillRoot, name: string): boolean {
    return this.db.prepare("DELETE FROM skill_state WHERE root = ? AND name = ?").run(root, name).changes === 1;
  }

  // ── skill_usage ─────────────────────────────────────────────────────────

  recordUsage(u: { skill: string; ts: string; sessionKey?: string | null; source: string; via: "tool" | "read"; turnLogId?: number | null }): number {
    return Number(
      this.db
        .prepare("INSERT INTO skill_usage (skill, ts, session_key, source, via, turn_log_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(u.skill, u.ts, u.sessionKey ?? null, u.source, u.via, u.turnLogId ?? null).lastInsertRowid,
    );
  }

  usage(filter: { skill?: string; sinceIso?: string; limit?: number } = {}): SkillUsageRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.skill) { where.push("skill = ?"); args.push(filter.skill); }
    if (filter.sinceIso) { where.push("ts >= ?"); args.push(filter.sinceIso); }
    args.push(Math.max(1, Math.min(filter.limit ?? 100, 10_000)));
    const rows = this.db
      .prepare(`SELECT * FROM skill_usage${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...args) as Array<{ id: number; skill: string; ts: string; session_key: string | null; source: string; via: string; turn_log_id: number | null }>;
    return rows.map((r) => ({
      id: r.id, skill: r.skill, ts: r.ts, sessionKey: r.session_key, source: r.source,
      via: r.via as "tool" | "read", turnLogId: r.turn_log_id,
    }));
  }

  /** Use counts per skill since a time (all time when omitted). */
  usageCounts(sinceIso?: string): Record<string, number> {
    const rows = (sinceIso
      ? this.db.prepare("SELECT skill, COUNT(*) AS n FROM skill_usage WHERE ts >= ? GROUP BY skill").all(sinceIso)
      : this.db.prepare("SELECT skill, COUNT(*) AS n FROM skill_usage GROUP BY skill").all()) as Array<{ skill: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.skill, r.n]));
  }

  pruneUsageBefore(beforeIso: string): number {
    return this.db.prepare("DELETE FROM skill_usage WHERE ts < ?").run(beforeIso).changes;
  }
}
