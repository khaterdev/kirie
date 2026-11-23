/**
 * `~/.kirie/learning.db` (PLAN B.7, R4 sections 0.3, item 4 "Tables", item 5 "Tables").
 *
 * One migration creates every learning table, including the ones the curator
 * (W3-CUR: skill_usage, skill_state, curator_runs) and the user model (W3-UM:
 * user_facts, user_facts_fts, user_fact_tombstones) use, so neither edits this
 * file. There is no learning_audit table: audit records go to `AuditTrail`.
 *
 * Opened read-write by the daemon and by the stdio subprocess (for
 * `learning_propose` and `proposals_list` only). WAL, busy_timeout 3000, 0600.
 */

import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";

export type LearningDb = Database.Database;

export const LEARNING_DB_FILE = "learning.db";

export function learningDbPath(dataDir: string): string {
  return join(dataDir, LEARNING_DB_FILE);
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turn_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key      TEXT NOT NULL,
  sdk_session_id   TEXT,
  source           TEXT NOT NULL,
  origin           TEXT NOT NULL,
  sender_id        TEXT,
  sender_role      TEXT,
  user_msg_id      INTEGER,
  assistant_msg_id INTEGER,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  num_turns        INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  is_error         INTEGER NOT NULL DEFAULT 0,
  was_aborted      INTEGER NOT NULL DEFAULT 0,
  tools            TEXT NOT NULL DEFAULT '{}',
  skills           TEXT NOT NULL DEFAULT '[]',
  untrusted_input  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turn_log_session ON turn_log(session_key, id);
CREATE INDEX IF NOT EXISTS idx_turn_log_user_msg ON turn_log(user_msg_id);

CREATE TABLE IF NOT EXISTS proposals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  rationale          TEXT NOT NULL DEFAULT '',
  payload            TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  origin             TEXT NOT NULL,
  trust              TEXT NOT NULL,
  risk_flags         TEXT NOT NULL DEFAULT '[]',
  redactions         INTEGER NOT NULL DEFAULT 0,
  source_session_key TEXT,
  source_msg_from    INTEGER,
  source_msg_to      INTEGER,
  source_turn_ids    TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'pending',
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  decided_at         TEXT,
  decided_by         TEXT,
  decided_via        TEXT,
  reject_reason      TEXT,
  applied_at         TEXT,
  apply_result       TEXT,
  error              TEXT,
  notified_at        TEXT,
  notify_message_id  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_pending_hash
  ON proposals(payload_hash) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(source_session_key, created_at);

CREATE TABLE IF NOT EXISTS skill_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  skill       TEXT NOT NULL,
  ts          TEXT NOT NULL,
  session_key TEXT,
  source      TEXT NOT NULL,
  via         TEXT NOT NULL,
  turn_log_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skill_usage_skill_ts ON skill_usage(skill, ts);

CREATE TABLE IF NOT EXISTS skill_state (
  name          TEXT NOT NULL,
  root          TEXT NOT NULL,
  source        TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'active',
  pinned        INTEGER NOT NULL DEFAULT 0,
  override      INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_used_at  TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  approved_hash TEXT,
  approved_at   TEXT,
  archived_at   TEXT,
  archive_path  TEXT,
  absorbed_into TEXT,
  PRIMARY KEY (root, name)
);

CREATE TABLE IF NOT EXISTS curator_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  report      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS user_facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category          TEXT NOT NULL,
  statement         TEXT NOT NULL,
  kind              TEXT NOT NULL,
  confidence        REAL NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  pinned            INTEGER NOT NULL DEFAULT 0,
  evidence          TEXT NOT NULL DEFAULT '[]',
  evidence_days     INTEGER NOT NULL DEFAULT 1,
  first_seen_at     TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  superseded_by     INTEGER,
  statement_hash    TEXT NOT NULL,
  embedding         BLOB
);
CREATE INDEX IF NOT EXISTS idx_user_facts_cat ON user_facts(status, category);
CREATE INDEX IF NOT EXISTS idx_user_facts_hash ON user_facts(statement_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS user_facts_fts
  USING fts5(statement, content=user_facts, content_rowid=id);

CREATE TRIGGER IF NOT EXISTS user_facts_ai AFTER INSERT ON user_facts BEGIN
  INSERT INTO user_facts_fts(rowid, statement) VALUES (new.id, new.statement);
END;
CREATE TRIGGER IF NOT EXISTS user_facts_ad AFTER DELETE ON user_facts BEGIN
  INSERT INTO user_facts_fts(user_facts_fts, rowid, statement) VALUES ('delete', old.id, old.statement);
END;
CREATE TRIGGER IF NOT EXISTS user_facts_au AFTER UPDATE ON user_facts BEGIN
  INSERT INTO user_facts_fts(user_facts_fts, rowid, statement) VALUES ('delete', old.id, old.statement);
  INSERT INTO user_facts_fts(rowid, statement) VALUES (new.id, new.statement);
END;

CREATE TABLE IF NOT EXISTS user_fact_tombstones (
  statement_hash TEXT PRIMARY KEY,
  embedding      BLOB,
  category       TEXT,
  forgotten_at   TEXT NOT NULL
);
`;

/** Idempotent: CREATE ... IF NOT EXISTS for every table, index and trigger. */
export function migrateLearningDb(db: LearningDb): void {
  db.exec(MIGRATION_SQL);
}

function tightenModes(path: string): void {
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(p)) chmodSync(p, 0o600);
    } catch {
      // best effort: the main file mode is what matters
    }
  }
}

/**
 * Open (and migrate) the learning DB. Creates the directory 0700 and the file
 * 0600 when missing. `readonly` opens an existing file without migrating.
 */
export function openLearningDb(path: string, opts: { readonly?: boolean } = {}): LearningDb {
  if (opts.readonly) {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 3000");
    return db;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Create the file 0600 before SQLite opens it, so it never exists with a wider mode.
  if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  migrateLearningDb(db);
  tightenModes(path);
  return db;
}

// ---------------------------------------------------------------------------
// kv: watermarks, day counters, first-boot stamps
// ---------------------------------------------------------------------------

export class LearningKv {
  constructor(private readonly db: LearningDb) {}

  get(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  /** Set only when absent. Returns the stored value. */
  setIfAbsent(key: string, value: string): string {
    this.db
      .prepare("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, value, new Date().toISOString());
    return this.get(key) ?? value;
  }

  getNumber(key: string): number {
    const v = Number(this.get(key));
    return Number.isFinite(v) ? v : 0;
  }

  /** Atomic add; returns the new value. */
  add(key: string, delta: number): number {
    const tx = this.db.transaction(() => {
      const next = this.getNumber(key) + delta;
      this.set(key, String(next));
      return next;
    });
    return tx();
  }

  delete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }

  /** Delete keys with this prefix whose key sorts before `before` (used to prune day counters). */
  deletePrefixBefore(prefix: string, before: string): number {
    return this.db.prepare("DELETE FROM kv WHERE key >= ? AND key < ?").run(prefix, before).changes;
  }
}

/** `kv` key set on the first boot with usage tracking (R4 item 4). */
export const USAGE_TRACKING_STARTED_KEY = "usage:tracking_started_at";
