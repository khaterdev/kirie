/**
 * `user_facts` store (PLAN C.5, R4 item 5 "Tables"). The tables, the FTS index
 * and its sync triggers are created by W2-LEARN's migration in
 * `learning-db.ts`; this file only reads and writes them.
 *
 * - Statements are normalised and scrubbed by the callers before they get
 *   here; the store adds no text of its own.
 * - Evidence is a list of references (chat message ids and dates), never quotes.
 * - Forgetting a fact deletes its text (and the text of the facts it
 *   superseded) and leaves a tombstone with only the statement hash, the
 *   embedding and the category, so the fact is never derived again.
 * - Confidence values are set by code (deriver, consolidation, commands);
 *   nothing here accepts a confidence from a model.
 */

import { sha256Hex } from "../proposal-types.js";
import type { LearningDb } from "../learning-db.js";
import { invisibleCharsRegex } from "../invisible-chars.js";

export const USER_FACT_CATEGORIES = [
  "identity",
  "preference",
  "working_style",
  "project",
  "person",
  "schedule",
  "communication",
  "tooling",
  "goal",
  "constraint",
] as const;
export type UserFactCategory = (typeof USER_FACT_CATEGORIES)[number];
export type UserFactKind = "explicit" | "inferred";
export type UserFactStatus = "active" | "superseded" | "suppressed";

/** A reference to where a fact came from. Never a quote. */
export type UserFactEvidenceRef =
  | { t: "chat"; id: number; ts?: string }
  | { t: "command"; at: string };

export interface UserFact {
  id: number;
  category: UserFactCategory;
  statement: string;
  kind: UserFactKind;
  confidence: number;
  status: UserFactStatus;
  pinned: boolean;
  evidence: UserFactEvidenceRef[];
  evidenceDays: number;
  firstSeenAt: string;
  lastConfirmedAt: string;
  updatedAt: string;
  supersededBy: number | null;
  statementHash: string;
  embedding: Float32Array | null;
}

export interface UserFactTombstone {
  statementHash: string;
  embedding: Float32Array | null;
  category: string | null;
  forgottenAt: string;
}

interface UserFactRow {
  id: number;
  category: string;
  statement: string;
  kind: string;
  confidence: number;
  status: string;
  pinned: number;
  evidence: string;
  evidence_days: number;
  first_seen_at: string;
  last_confirmed_at: string;
  updated_at: string;
  superseded_by: number | null;
  statement_hash: string;
  embedding: Buffer | null;
}

const FORGOTTEN_EVIDENCE_KEY = "usermodel:forgotten_evidence";
const MAX_FORGOTTEN_EVIDENCE_PER_CATEGORY = 2000;

/** Facts keep at most this many evidence references (the newest). */
export const USER_FACT_MAX_EVIDENCE = 10;
export const USER_FACT_MAX_STATEMENT_CHARS = 240;

export function isUserFactCategory(value: unknown): value is UserFactCategory {
  return typeof value === "string" && (USER_FACT_CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Text and vectors
// ---------------------------------------------------------------------------

/** NFKC, invisible characters removed, angle brackets neutralised (the card is wrapped in a tag), whitespace collapsed. */
export function normalizeUserFactStatement(text: string): string {
  return text
    .normalize("NFKC")
    .replace(invisibleCharsRegex(), "")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\s+/g, " ")
    .trim();
}

/** sha256 of the lowercased statement without trailing punctuation. Used for dedupe and tombstones. */
export function userFactStatementHash(statement: string): string {
  const key = normalizeUserFactStatement(statement).toLowerCase().replace(/[\s.!?;:,]+$/u, "");
  return sha256Hex(key);
}

export function encodeUserFactEmbedding(vector: ArrayLike<number> | null | undefined): Buffer | null {
  if (!vector || vector.length === 0) return null;
  const f32 = Float32Array.from(vector as ArrayLike<number>);
  if (!f32.some((v) => v !== 0)) return null;
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeUserFactEmbedding(buf: Buffer | null | undefined): Float32Array | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
  const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(copy);
}

/** Cosine similarity; 0 when either vector is missing, zero or of another dimension. */
export function userModelCosine(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function parseEvidence(text: string): UserFactEvidenceRef[] {
  try {
    const v = JSON.parse(text) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((e): e is UserFactEvidenceRef =>
      typeof e === "object" && e !== null &&
      ((e as { t?: unknown }).t === "chat" ? Number.isInteger((e as { id?: unknown }).id) : (e as { t?: unknown }).t === "command"),
    );
  } catch {
    return [];
  }
}

function toFact(r: UserFactRow): UserFact {
  return {
    id: r.id,
    category: (isUserFactCategory(r.category) ? r.category : "preference"),
    statement: r.statement,
    kind: r.kind === "explicit" ? "explicit" : "inferred",
    confidence: r.confidence,
    status: r.status === "superseded" || r.status === "suppressed" ? r.status : "active",
    pinned: r.pinned === 1,
    evidence: parseEvidence(r.evidence),
    evidenceDays: r.evidence_days,
    firstSeenAt: r.first_seen_at,
    lastConfirmedAt: r.last_confirmed_at,
    updatedAt: r.updated_at,
    supersededBy: r.superseded_by,
    statementHash: r.statement_hash,
    embedding: decodeUserFactEmbedding(r.embedding),
  };
}

/** Keep the newest refs (chat refs by id, command refs last), deduplicated. */
export function mergeUserFactEvidence(
  existing: readonly UserFactEvidenceRef[],
  added: readonly UserFactEvidenceRef[],
): UserFactEvidenceRef[] {
  const seen = new Set<string>();
  const out: UserFactEvidenceRef[] = [];
  for (const ref of [...existing, ...added]) {
    const key = ref.t === "chat" ? `c:${ref.id}` : `cmd:${ref.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  const order = (r: UserFactEvidenceRef): number => (r.t === "chat" ? r.id : Number.MAX_SAFE_INTEGER);
  out.sort((a, b) => order(a) - order(b));
  return out.slice(-USER_FACT_MAX_EVIDENCE);
}

/** Calendar days (UTC, YYYY-MM-DD) named by chat evidence refs. */
export function userFactEvidenceDays(refs: readonly UserFactEvidenceRef[]): Set<string> {
  const days = new Set<string>();
  for (const r of refs) {
    if (r.t === "chat" && r.ts) days.add(r.ts.slice(0, 10));
    if (r.t === "command") days.add(r.at.slice(0, 10));
  }
  return days;
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "has", "have", "how", "i", "in", "is",
  "it", "me", "my", "of", "on", "or", "owner", "owners", "s", "the", "their", "them", "they", "this", "to", "what",
  "when", "where", "which", "who", "why", "with", "you", "your", "about", "know", "known", "user", "like", "likes",
]);

/** An FTS5 query that ORs quoted word tokens, so no FTS syntax from the caller is ever interpreted. */
export function userFactFtsQuery(text: string): string {
  const tokens = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  // Light stemming plus prefix match ("deploys" and "deploy" both find "deployed").
  const stems = tokens.map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
  const unique = [...new Set(stems)].slice(0, 12);
  return unique.map((t) => `"${t.replace(/"/g, '""')}"${t.length >= 4 ? "*" : ""}`).join(" OR ");
}

export interface UserFactSearchOptions {
  text: string;
  category?: UserFactCategory;
  limit: number;
  /** Include facts below 0.60 that are not pinned (and suppressed ones). Default false. */
  includeLowConfidence?: boolean;
  /** A local embedding of `text`, for the vector half of the hybrid search. */
  queryEmbedding?: ArrayLike<number> | null;
}

export interface UserFactSearchResult {
  facts: UserFact[];
  /** "hybrid" | "keyword" | "vector" | "top" (no match: the strongest facts are returned) */
  mode: "hybrid" | "keyword" | "vector" | "top";
}

/** Card and query threshold: an unconfirmed inference (0.40) never qualifies. */
export const USER_FACT_CARD_MIN_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface NewUserFact {
  category: UserFactCategory;
  statement: string;
  kind: UserFactKind;
  confidence: number;
  pinned?: boolean;
  evidence: UserFactEvidenceRef[];
  evidenceDays?: number;
  embedding?: ArrayLike<number> | null;
  now: Date;
}

export class UserFactStore {
  /** A read-write connection gets `secure_delete`, so forgotten text is overwritten, not just unlinked. */
  constructor(private readonly db: LearningDb) {
    if (!db.readonly) db.pragma("secure_delete = ON");
  }

  insert(input: NewUserFact): UserFact {
    const at = input.now.toISOString();
    const statement = normalizeUserFactStatement(input.statement);
    const res = this.db
      .prepare(
        `INSERT INTO user_facts (category, statement, kind, confidence, status, pinned, evidence, evidence_days,
           first_seen_at, last_confirmed_at, updated_at, statement_hash, embedding)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.category,
        statement,
        input.kind,
        clampConfidence(input.confidence),
        input.pinned ? 1 : 0,
        JSON.stringify(mergeUserFactEvidence([], input.evidence)),
        Math.max(1, input.evidenceDays ?? 1),
        at,
        at,
        at,
        userFactStatementHash(statement),
        encodeUserFactEmbedding(input.embedding),
      );
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): UserFact | null {
    const row = this.db.prepare("SELECT * FROM user_facts WHERE id = ?").get(id) as UserFactRow | undefined;
    return row ? toFact(row) : null;
  }

  /** Facts with this status (default active), optionally one category, strongest first. */
  list(opts: { status?: UserFactStatus | "all"; category?: UserFactCategory; limit?: number } = {}): UserFact[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status !== "all") {
      where.push("status = ?");
      args.push(opts.status ?? "active");
    }
    if (opts.category) {
      where.push("category = ?");
      args.push(opts.category);
    }
    const sql = `SELECT * FROM user_facts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY pinned DESC, confidence DESC, last_confirmed_at DESC, id ASC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, opts.limit ?? 10_000) as UserFactRow[]).map(toFact);
  }

  findActiveByHash(hash: string): UserFact | null {
    const row = this.db
      .prepare("SELECT * FROM user_facts WHERE statement_hash = ? AND status = 'active' ORDER BY id LIMIT 1")
      .get(hash) as UserFactRow | undefined;
    return row ? toFact(row) : null;
  }

  /** Facts changed (added, confirmed, updated) at or after `sinceIso`. */
  changedSince(sinceIso: string, limit = 100): UserFact[] {
    return (this.db
      .prepare("SELECT * FROM user_facts WHERE updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(sinceIso, limit) as UserFactRow[]).map(toFact);
  }

  /** Record new supporting evidence. Confidence and kind are computed by the caller. */
  confirm(id: number, fields: { evidence: UserFactEvidenceRef[]; evidenceDays: number; confidence: number; kind: UserFactKind; now: Date }): void {
    const at = fields.now.toISOString();
    this.db
      .prepare(
        `UPDATE user_facts SET evidence = ?, evidence_days = ?, confidence = ?, kind = ?, last_confirmed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(fields.evidence), Math.max(1, fields.evidenceDays), clampConfidence(fields.confidence), fields.kind, at, at, id);
  }

  /** `oldId` is replaced by `newId`. */
  supersede(oldId: number, newId: number, now: Date): void {
    this.db
      .prepare("UPDATE user_facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(newId, now.toISOString(), oldId);
  }

  /** Undo of a supersede: the fact becomes active again. */
  reactivate(id: number, now: Date): void {
    this.db
      .prepare("UPDATE user_facts SET status = 'active', superseded_by = NULL, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), id);
  }

  setPinned(id: number, pinned: boolean, now: Date): boolean {
    return this.db
      .prepare("UPDATE user_facts SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'")
      .run(pinned ? 1 : 0, now.toISOString(), id).changes > 0;
  }

  setConfidence(id: number, confidence: number, now: Date): void {
    this.db.prepare("UPDATE user_facts SET confidence = ?, updated_at = ? WHERE id = ?").run(clampConfidence(confidence), now.toISOString(), id);
  }

  setStatus(id: number, status: UserFactStatus, now: Date): void {
    this.db.prepare("UPDATE user_facts SET status = ?, updated_at = ? WHERE id = ?").run(status, now.toISOString(), id);
  }

  setEmbedding(id: number, embedding: ArrayLike<number> | null): void {
    this.db.prepare("UPDATE user_facts SET embedding = ? WHERE id = ?").run(encodeUserFactEmbedding(embedding), id);
  }

  /** Delete a fact without a tombstone (undo of an approved add). */
  delete(id: number): boolean {
    return this.db.prepare("DELETE FROM user_facts WHERE id = ?").run(id).changes > 0;
  }

  /**
   * Forget a fact: delete its text and the text of every fact it superseded,
   * and tombstone each statement so it is never derived again. Returns the
   * rows forgotten (0 when the id does not exist) and their statement hashes.
   */
  forget(id: number, now: Date): { rows: number; hashes: string[] } {
    const tx = this.db.transaction((): { rows: number; hashes: string[] } => {
      const hashes: string[] = [];
      const forgottenEvidence = this.forgottenEvidence();
      const ids: number[] = [];
      const queue = [id];
      while (queue.length > 0 && ids.length < 1000) {
        const cur = queue.shift()!;
        if (ids.includes(cur)) continue;
        if (!this.get(cur)) continue;
        ids.push(cur);
        const prev = this.db.prepare("SELECT id FROM user_facts WHERE superseded_by = ?").all(cur) as { id: number }[];
        for (const p of prev) queue.push(p.id);
      }
      const at = now.toISOString();
      const insertTomb = this.db.prepare(
        `INSERT INTO user_fact_tombstones (statement_hash, embedding, category, forgotten_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(statement_hash) DO UPDATE SET embedding = COALESCE(excluded.embedding, embedding), forgotten_at = excluded.forgotten_at`,
      );
      for (const fid of ids) {
        const row = this.db.prepare("SELECT statement_hash, embedding, category FROM user_facts WHERE id = ?").get(fid) as
          | { statement_hash: string; embedding: Buffer | null; category: string }
          | undefined;
        if (!row) continue;
        insertTomb.run(row.statement_hash, row.embedding, row.category, at);
        hashes.push(row.statement_hash);
        // The messages it came from, so a reworded version from the same messages is not derived again.
        const fact = this.get(fid);
        const seen = forgottenEvidence.get(row.category) ?? new Set<number>();
        for (const e of fact?.evidence ?? []) if (e.t === "chat") seen.add(e.id);
        forgottenEvidence.set(row.category, seen);
        this.db.prepare("DELETE FROM user_facts WHERE id = ?").run(fid);
      }
      this.saveForgottenEvidence(forgottenEvidence);
      return { rows: ids.length, hashes };
    });
    const out = tx();
    if (out.rows > 0) this.purgeFreedText();
    return out;
  }

  /** Chat message ids that supported forgotten facts, per category. */
  forgottenEvidence(): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(FORGOTTEN_EVIDENCE_KEY) as { value: string } | undefined;
    if (!row) return out;
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      for (const [cat, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) out.set(cat, new Set(ids.filter((v): v is number => Number.isInteger(v))));
      }
    } catch {
      // unreadable: treat as empty
    }
    return out;
  }

  private saveForgottenEvidence(map: Map<string, Set<number>>): void {
    const obj: Record<string, number[]> = {};
    for (const [cat, ids] of map) obj[cat] = [...ids].sort((a, b) => a - b).slice(-MAX_FORGOTTEN_EVIDENCE_PER_CATEGORY);
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(FORGOTTEN_EVIDENCE_KEY, JSON.stringify(obj), new Date().toISOString());
  }

  /**
   * After a delete: merge the FTS index (drops deleted terms from its segments)
   * and checkpoint the WAL, so deleted text does not linger on disk. Best
   * effort; `secure_delete` on the connection zeroes freed pages.
   */
  purgeFreedText(): void {
    try {
      this.db.prepare("INSERT INTO user_facts_fts(user_facts_fts) VALUES ('optimize')").run();
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // a busy reader can block the checkpoint; the next one completes it
    }
  }

  isTombstoned(hash: string): boolean {
    return this.db.prepare("SELECT 1 FROM user_fact_tombstones WHERE statement_hash = ?").get(hash) !== undefined;
  }

  tombstones(limit = 5000): UserFactTombstone[] {
    return (this.db
      .prepare("SELECT statement_hash, embedding, category, forgotten_at FROM user_fact_tombstones ORDER BY forgotten_at DESC LIMIT ?")
      .all(limit) as Array<{ statement_hash: string; embedding: Buffer | null; category: string | null; forgotten_at: string }>)
      .map((r) => ({ statementHash: r.statement_hash, embedding: decodeUserFactEmbedding(r.embedding), category: r.category, forgottenAt: r.forgotten_at }));
  }

  /** `/profile add` of a statement the owner had forgotten lifts that tombstone. */
  removeTombstone(hash: string): boolean {
    return this.db.prepare("DELETE FROM user_fact_tombstones WHERE statement_hash = ?").run(hash).changes > 0;
  }

  /** Rebuild: delete every fact that is not pinned. Tombstones stay. */
  clearUnpinned(): number {
    return this.db.prepare("DELETE FROM user_facts WHERE pinned = 0").run().changes;
  }

  /** Wipe: delete every fact and every tombstone. */
  wipe(): { facts: number; tombstones: number } {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(FORGOTTEN_EVIDENCE_KEY);
      return {
        facts: this.db.prepare("DELETE FROM user_facts").run().changes,
        tombstones: this.db.prepare("DELETE FROM user_fact_tombstones").run().changes,
      };
    });
    const r = tx();
    this.purgeFreedText();
    return r;
  }

  counts(): {
    active: number; superseded: number; suppressed: number; pinned: number; tombstones: number;
    byCategory: Record<string, number>; explicit: number; inferred: number; cardEligible: number;
  } {
    const byStatus = this.db.prepare("SELECT status, COUNT(*) AS n FROM user_facts GROUP BY status").all() as { status: string; n: number }[];
    const status = (s: string): number => byStatus.find((r) => r.status === s)?.n ?? 0;
    const byCategory: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT category, COUNT(*) AS n FROM user_facts WHERE status = 'active' GROUP BY category").all() as { category: string; n: number }[]) {
      byCategory[r.category] = r.n;
    }
    const kinds = this.db.prepare("SELECT kind, COUNT(*) AS n FROM user_facts WHERE status = 'active' GROUP BY kind").all() as { kind: string; n: number }[];
    const one = (sql: string, ...args: unknown[]): number => (this.db.prepare(sql).get(...args) as { n: number }).n;
    return {
      active: status("active"),
      superseded: status("superseded"),
      suppressed: status("suppressed"),
      pinned: one("SELECT COUNT(*) AS n FROM user_facts WHERE status = 'active' AND pinned = 1"),
      tombstones: one("SELECT COUNT(*) AS n FROM user_fact_tombstones"),
      byCategory,
      explicit: kinds.find((k) => k.kind === "explicit")?.n ?? 0,
      inferred: kinds.find((k) => k.kind === "inferred")?.n ?? 0,
      cardEligible: one(
        "SELECT COUNT(*) AS n FROM user_facts WHERE status = 'active' AND (pinned = 1 OR confidence >= ?)",
        USER_FACT_CARD_MIN_CONFIDENCE,
      ),
    };
  }

  /**
   * Hybrid retrieval (R4 "Dialectic query"): FTS5 over the statements plus
   * cosine over local embeddings, merged with reciprocal rank fusion. With no
   * match at all, the strongest facts are returned (mode "top") so a vague
   * question still gets the core profile.
   */
  search(opts: UserFactSearchOptions): UserFactSearchResult {
    const limit = Math.max(1, Math.min(50, Math.floor(opts.limit)));
    const visible = (f: UserFact): boolean =>
      (opts.category === undefined || f.category === opts.category) &&
      (opts.includeLowConfidence ? f.status !== "superseded" : f.status === "active" && (f.pinned || f.confidence >= USER_FACT_CARD_MIN_CONFIDENCE));

    const keyword: UserFact[] = [];
    const fts = userFactFtsQuery(opts.text);
    if (fts) {
      try {
        const rows = this.db
          .prepare(
            `SELECT f.* FROM user_facts_fts JOIN user_facts f ON f.id = user_facts_fts.rowid
             WHERE user_facts_fts MATCH ? ORDER BY bm25(user_facts_fts) LIMIT 100`,
          )
          .all(fts) as UserFactRow[];
        for (const r of rows) {
          const f = toFact(r);
          if (visible(f)) keyword.push(f);
        }
      } catch {
        // A malformed MATCH cannot happen with quoted tokens; treat any error as no keyword hits.
      }
    }

    const vector: UserFact[] = [];
    if (opts.queryEmbedding && opts.queryEmbedding.length > 0) {
      const scored: Array<{ f: UserFact; s: number }> = [];
      for (const f of this.list({ status: "all", limit: 5000 })) {
        if (!visible(f) || !f.embedding) continue;
        const s = userModelCosine(opts.queryEmbedding, f.embedding);
        if (s >= 0.3) scored.push({ f, s });
      }
      scored.sort((a, b) => b.s - a.s);
      for (const x of scored.slice(0, 100)) vector.push(x.f);
    }

    if (keyword.length === 0 && vector.length === 0) {
      const top = this.list({ status: opts.includeLowConfidence ? "all" : "active", ...(opts.category ? { category: opts.category } : {}), limit: 500 })
        .filter(visible)
        .slice(0, limit);
      return { facts: top, mode: "top" };
    }

    const K = 60;
    const scores = new Map<number, { f: UserFact; score: number }>();
    const addRanks = (list: UserFact[]): void => {
      list.forEach((f, i) => {
        const cur = scores.get(f.id) ?? { f, score: 0 };
        cur.score += 1 / (K + i + 1);
        scores.set(f.id, cur);
      });
    };
    addRanks(keyword);
    addRanks(vector);
    const merged = [...scores.values()].sort((a, b) => b.score - a.score || b.f.confidence - a.f.confidence).map((x) => x.f);
    const mode = keyword.length > 0 && vector.length > 0 ? "hybrid" : keyword.length > 0 ? "keyword" : "vector";
    return { facts: merged.slice(0, limit), mode };
  }
}

function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, Math.round(v * 1000) / 1000));
}
