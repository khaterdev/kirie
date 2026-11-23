/**
 * Proposals table access (PLAN B.7, R4 sections 0.3, 0.6, 0.8).
 *
 * The store never applies anything. State changes that matter for safety are
 * single conditional UPDATEs: `claimForApply` moves a row to `applying` only
 * from `pending` or `failed`, so double taps and command/button races decide
 * once; `expireDue` only moves `pending` to `expired`.
 */

import type { LearningDb } from "./learning-db.js";
import type { ProposalKind, ProposalOrigin, ProposalStatus, ProposalTrust, RiskFlag } from "./proposal-types.js";

export interface ProposalRecord {
  id: number;
  kind: ProposalKind;
  title: string;
  rationale: string;
  payload: unknown;
  payloadHash: string;
  origin: ProposalOrigin;
  trust: ProposalTrust;
  riskFlags: RiskFlag[];
  redactions: number;
  sourceSessionKey: string | null;
  sourceMsgFrom: number | null;
  sourceMsgTo: number | null;
  sourceTurnIds: number[];
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedVia: string | null;
  rejectReason: string | null;
  appliedAt: string | null;
  applyResult: Record<string, unknown> | null;
  error: string | null;
  notifiedAt: string | null;
  notifyMessageId: string | null;
}

interface ProposalRow {
  id: number;
  kind: string;
  title: string;
  rationale: string;
  payload: string;
  payload_hash: string;
  origin: string;
  trust: string;
  risk_flags: string;
  redactions: number;
  source_session_key: string | null;
  source_msg_from: number | null;
  source_msg_to: number | null;
  source_turn_ids: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_via: string | null;
  reject_reason: string | null;
  applied_at: string | null;
  apply_result: string | null;
  error: string | null;
  notified_at: string | null;
  notify_message_id: string | null;
}

export interface NewProposal {
  kind: ProposalKind;
  title: string;
  rationale: string;
  payload: unknown;
  payloadHash: string;
  origin: ProposalOrigin;
  trust: ProposalTrust;
  riskFlags: readonly RiskFlag[];
  redactions: number;
  sourceSessionKey?: string;
  sourceMsgFrom?: number;
  sourceMsgTo?: number;
  sourceTurnIds?: readonly number[];
  createdAt: string;
  expiresAt: string;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    kind: row.kind as ProposalKind,
    title: row.title,
    rationale: row.rationale,
    payload: parseJson<unknown>(row.payload, null),
    payloadHash: row.payload_hash,
    origin: row.origin as ProposalOrigin,
    trust: row.trust as ProposalTrust,
    riskFlags: parseJson<RiskFlag[]>(row.risk_flags, []),
    redactions: row.redactions,
    sourceSessionKey: row.source_session_key,
    sourceMsgFrom: row.source_msg_from,
    sourceMsgTo: row.source_msg_to,
    sourceTurnIds: parseJson<number[]>(row.source_turn_ids, []),
    status: row.status as ProposalStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decidedVia: row.decided_via,
    rejectReason: row.reject_reason,
    appliedAt: row.applied_at,
    applyResult: parseJson<Record<string, unknown> | null>(row.apply_result, null),
    error: row.error,
    notifiedAt: row.notified_at,
    notifyMessageId: row.notify_message_id,
  };
}

export interface ProposalDecision {
  by: string;
  via: "command" | "button";
  at: string;
}

export class ProposalStore {
  constructor(private readonly db: LearningDb) {}

  /** Insert a pending row. Returns null when a pending row with the same hash exists (unique index). */
  insert(p: NewProposal): number | null {
    try {
      const res = this.db
        .prepare(
          `INSERT INTO proposals (kind, title, rationale, payload, payload_hash, origin, trust, risk_flags, redactions,
             source_session_key, source_msg_from, source_msg_to, source_turn_ids, status, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          p.kind, p.title, p.rationale, JSON.stringify(p.payload), p.payloadHash, p.origin, p.trust,
          JSON.stringify(p.riskFlags), p.redactions, p.sourceSessionKey ?? null, p.sourceMsgFrom ?? null,
          p.sourceMsgTo ?? null, JSON.stringify(p.sourceTurnIds ?? []), p.createdAt, p.expiresAt,
        );
      return Number(res.lastInsertRowid);
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) return null;
      throw err;
    }
  }

  get(id: number): ProposalRecord | null {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Newest first. */
  list(filter: { status?: ProposalStatus | readonly ProposalStatus[]; limit?: number } = {}): ProposalRecord[] {
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
    const statuses = filter.status === undefined ? [] : Array.isArray(filter.status) ? filter.status : [filter.status];
    const rows = statuses.length > 0
      ? this.db
          .prepare(`SELECT * FROM proposals WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id DESC LIMIT ?`)
          .all(...statuses, limit) as ProposalRow[]
      : this.db.prepare("SELECT * FROM proposals ORDER BY id DESC LIMIT ?").all(limit) as ProposalRow[];
    return rows.map(rowToRecord);
  }

  countByStatus(status: ProposalStatus): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = ?").get(status) as { n: number }).n;
  }

  countPending(): number {
    return this.countByStatus("pending");
  }

  /** Rows of this origin created at or after `sinceIso` (any status): the daily cap. */
  countByOriginSince(origin: ProposalOrigin, sinceIso: string): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE origin = ? AND created_at >= ?").get(origin, sinceIso) as { n: number }
    ).n;
  }

  hasPendingHash(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM proposals WHERE payload_hash = ? AND status = 'pending'").get(hash) !== undefined;
  }

  /** Same content rejected at or after `sinceIso`: rejected ideas do not come back. */
  wasRejectedSince(hash: string, sinceIso: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM proposals WHERE payload_hash = ? AND status = 'rejected' AND decided_at >= ?")
        .get(hash, sinceIso) !== undefined
    );
  }

  /** Atomic claim. True when this caller moved the row from pending/failed to applying. */
  claimForApply(id: number, decision: ProposalDecision): boolean {
    return (
      this.db
        .prepare(
          `UPDATE proposals SET status = 'applying', decided_at = ?, decided_by = ?, decided_via = ?, error = NULL
           WHERE id = ? AND status IN ('pending', 'failed')`,
        )
        .run(decision.at, decision.by, decision.via, id).changes === 1
    );
  }

  /** Put a claimed row back where it was when apply did not start (validation refused it). */
  releaseClaim(id: number, status: "pending" | "failed", error: string | null): void {
    this.db.prepare("UPDATE proposals SET status = ?, error = ? WHERE id = ? AND status = 'applying'").run(status, error, id);
  }

  /** Persist a re-scrubbed payload on a claimed row before applying it. */
  updateClaimedPayload(id: number, payload: unknown, payloadHash: string, redactions: number): void {
    this.db
      .prepare("UPDATE proposals SET payload = ?, payload_hash = ?, redactions = ? WHERE id = ? AND status = 'applying'")
      .run(JSON.stringify(payload), payloadHash, redactions, id);
  }

  markApplied(id: number, applyResult: Record<string, unknown>, at: string): void {
    this.db
      .prepare("UPDATE proposals SET status = 'applied', applied_at = ?, apply_result = ?, error = NULL WHERE id = ? AND status = 'applying'")
      .run(at, JSON.stringify(applyResult), id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare("UPDATE proposals SET status = 'failed', error = ? WHERE id = ? AND status = 'applying'").run(error.slice(0, 500), id);
  }

  /** pending or failed -> rejected. */
  markRejected(id: number, decision: ProposalDecision, reason: string | null): boolean {
    return (
      this.db
        .prepare(
          `UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = ?, decided_via = ?, reject_reason = ?
           WHERE id = ? AND status IN ('pending', 'failed')`,
        )
        .run(decision.at, decision.by, decision.via, reason, id).changes === 1
    );
  }

  /** Code-side drop of a pending row (an untrusted skill proposal once its trust is known). */
  markDroppedBySystem(id: number, reason: string, at: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE proposals SET status = 'rejected', decided_at = ?, decided_by = 'system', decided_via = NULL, reject_reason = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(at, reason.slice(0, 300), id).changes === 1
    );
  }

  /** applied -> applying (undo claim). */
  claimForUndo(id: number): boolean {
    return this.db.prepare("UPDATE proposals SET status = 'applying' WHERE id = ? AND status = 'applied'").run(id).changes === 1;
  }

  releaseUndo(id: number, error: string): void {
    this.db.prepare("UPDATE proposals SET status = 'applied', error = ? WHERE id = ? AND status = 'applying'").run(error.slice(0, 500), id);
  }

  markUndone(id: number, decision: ProposalDecision): void {
    this.db
      .prepare("UPDATE proposals SET status = 'undone', decided_at = ?, decided_by = ?, decided_via = ? WHERE id = ? AND status = 'applying'")
      .run(decision.at, decision.by, decision.via, id);
  }

  /**
   * Rows left in `applying` by a crash or restart mid-apply (or mid-undo) become
   * `failed`, so the owner sees them and can retry; a retry re-runs the stale
   * and conflict checks. Call once at startup, before anything is applied.
   */
  recoverInterrupted(): number[] {
    const tx = this.db.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM proposals WHERE status = 'applying'").all() as { id: number }[]).map((r) => r.id);
      this.db
        .prepare("UPDATE proposals SET status = 'failed', error = 'interrupted by a restart; check the target before retrying' WHERE status = 'applying'")
        .run();
      return ids;
    });
    return tx();
  }

  /** pending past expires_at -> expired. Never applies anything. */
  expireDue(nowIso: string): number[] {
    const tx = this.db.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM proposals WHERE status = 'pending' AND expires_at <= ?").all(nowIso) as { id: number }[])
        .map((r) => r.id);
      if (ids.length > 0) {
        this.db.prepare("UPDATE proposals SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?").run(nowIso);
      }
      return ids;
    });
    return tx();
  }

  /**
   * Trust finalization for agent-tool proposals (R4 section 0.6): rows still
   * `unverified` filed for this session inside the turn's window take the
   * turn's trust. Returns the ids changed.
   */
  finalizeUnverified(sessionKey: string, startedIso: string, endedIso: string, trust: ProposalTrust, turnId: number): number[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT id, source_turn_ids FROM proposals
           WHERE origin = 'agent_tool' AND trust = 'unverified' AND source_session_key = ?
             AND created_at >= ? AND created_at <= ?`,
        )
        .all(sessionKey, startedIso, endedIso) as { id: number; source_turn_ids: string }[];
      const update = this.db.prepare("UPDATE proposals SET trust = ?, source_turn_ids = ? WHERE id = ? AND trust = 'unverified'");
      for (const r of rows) {
        const turns = parseJson<number[]>(r.source_turn_ids, []);
        update.run(trust, JSON.stringify([...turns, turnId]), r.id);
      }
      return rows.map((r) => r.id);
    });
    return tx();
  }

  /**
   * A non-chat turn (background task, goal, webhook) ran for this session key:
   * any pending agent-tool proposal filed for that key in its window is
   * untrusted, whatever trust it was given meanwhile. Downgrade only.
   */
  downgradeAgentToolInWindow(sessionKey: string, startedIso: string, endedIso: string): number[] {
    const tx = this.db.transaction(() => {
      const ids = (this.db
        .prepare(
          `SELECT id FROM proposals
           WHERE origin = 'agent_tool' AND status = 'pending' AND trust IN ('unverified', 'owner', 'mixed')
             AND source_session_key = ? AND created_at >= ? AND created_at <= ?`,
        )
        .all(sessionKey, startedIso, endedIso) as { id: number }[]).map((r) => r.id);
      const update = this.db.prepare("UPDATE proposals SET trust = 'untrusted' WHERE id = ?");
      for (const id of ids) update.run(id);
      return ids;
    });
    return tx();
  }

  /** Pending rows of these origins that were never delivered, oldest first. */
  listUnnotified(origins: readonly ProposalOrigin[], limit = 50): ProposalRecord[] {
    if (origins.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM proposals WHERE status = 'pending' AND notified_at IS NULL
           AND origin IN (${origins.map(() => "?").join(",")}) ORDER BY id ASC LIMIT ?`,
      )
      .all(...origins, limit) as ProposalRow[];
    return rows.map(rowToRecord);
  }

  markNotified(id: number, at: string, messageId: string | null): void {
    this.db.prepare("UPDATE proposals SET notified_at = ?, notify_message_id = ? WHERE id = ?").run(at, messageId, id);
  }
}
