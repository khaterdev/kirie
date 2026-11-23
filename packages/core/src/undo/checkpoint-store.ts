/**
 * The undo ledger (PLAN C.11, R1 item 11 "Ledger"): one row per user message
 * that ran with SDK file checkpointing on, in `~/.kirie/checkpoints.db`.
 *
 * A row names the rewind target (the client-stamped user message uuid, E3),
 * the SDK session and the account config dir whose `file-history/` holds the
 * backups, and what the turn did: files written through Write / Edit /
 * NotebookEdit, files it created, file edits made by subagents, and the
 * shell commands it ran. It stores paths and scrubbed previews only, never
 * file contents. The file is created 0600.
 */

import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const UNDO_DB_FILE = "checkpoints.db";
/** Paths kept per list per row */
export const UNDO_MAX_PATHS_PER_ROW = 200;
/** Shell command samples kept per row */
export const UNDO_MAX_BASH_SAMPLES = 3;

/** `chat` or `task:<id>` */
export type UndoTurnSource = string;

export interface UndoCheckpoint {
  id: number;
  sessionKey: string;
  /** Null until the first SDK message of a brand-new session names it */
  sdkSessionId: string | null;
  userMessageUuid: string;
  accountId: string | null;
  /** Config dir the turn ran under (null = the default login, CLAUDE_CONFIG_DIR unset) */
  configDir: string | null;
  cwd: string;
  source: UndoTurnSource;
  promptPreview: string | null;
  filesChanged: string[];
  filesCreated: string[];
  subagentFiles: string[];
  bashCount: number;
  bashSamples: string[];
  createdAt: number;
  completedAt: number | null;
  undoneAt: number | null;
  /** False for a gap marker: a turn of this session that ran with checkpointing off */
  checkpointed: boolean;
}

export interface NewUndoCheckpoint {
  sessionKey: string;
  sdkSessionId: string | null;
  userMessageUuid: string;
  accountId: string | null;
  configDir: string | null;
  cwd: string;
  source: UndoTurnSource;
  promptPreview: string | null;
  createdAt: number;
  /** Default true. False records a gap marker (see UndoCheckpoint.checkpointed) */
  checkpointed?: boolean;
}

export interface UndoTurnActivity {
  filesChanged: readonly string[];
  filesCreated: readonly string[];
  subagentFiles: readonly string[];
  bashCount: number;
  bashSamples: readonly string[];
}

interface Row {
  id: number;
  session_key: string;
  sdk_session_id: string | null;
  user_message_uuid: string;
  account_id: string | null;
  config_dir: string | null;
  cwd: string;
  source: string;
  prompt_preview: string | null;
  files_changed: string;
  files_created: string;
  subagent_files: string;
  bash_count: number;
  bash_samples: string;
  created_at: number;
  completed_at: number | null;
  undone_at: number | null;
  checkpointed: number;
}

function parseList(text: string): string[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toCheckpoint(r: Row): UndoCheckpoint {
  return {
    id: r.id,
    sessionKey: r.session_key,
    sdkSessionId: r.sdk_session_id,
    userMessageUuid: r.user_message_uuid,
    accountId: r.account_id,
    configDir: r.config_dir,
    cwd: r.cwd,
    source: r.source,
    promptPreview: r.prompt_preview,
    filesChanged: parseList(r.files_changed),
    filesCreated: parseList(r.files_created),
    subagentFiles: parseList(r.subagent_files),
    bashCount: r.bash_count,
    bashSamples: parseList(r.bash_samples),
    createdAt: r.created_at,
    completedAt: r.completed_at,
    undoneAt: r.undone_at,
    checkpointed: r.checkpointed !== 0,
  };
}

function capList(list: readonly string[], max: number): string {
  return JSON.stringify(list.slice(0, max));
}

/** A row counts as "changed files" when the turn wrote a file itself or through a subagent. */
const HAS_FILES = "(files_changed <> '[]' OR subagent_files <> '[]')";
const CHECKPOINTED = "checkpointed = 1";

export class UndoCheckpointStore {
  private readonly db: Database.Database;
  private closed = false;
  readonly path: string;

  constructor(dbPath: string = join(homedir(), ".kirie", UNDO_DB_FILE)) {
    this.path = dbPath;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.migrate();
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(file)) chmodSync(file, 0o600);
      } catch {
        // best effort; the main file is checked by tests
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_checkpoints (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key       TEXT NOT NULL,
        sdk_session_id    TEXT,
        user_message_uuid TEXT NOT NULL UNIQUE,
        account_id        TEXT,
        config_dir        TEXT,
        cwd               TEXT NOT NULL,
        source            TEXT NOT NULL,
        prompt_preview    TEXT,
        files_changed     TEXT NOT NULL DEFAULT '[]',
        files_created     TEXT NOT NULL DEFAULT '[]',
        subagent_files    TEXT NOT NULL DEFAULT '[]',
        bash_count        INTEGER NOT NULL DEFAULT 0,
        bash_samples      TEXT NOT NULL DEFAULT '[]',
        created_at        INTEGER NOT NULL,
        completed_at      INTEGER,
        undone_at         INTEGER,
        checkpointed      INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS turn_checkpoints_session ON turn_checkpoints(session_key, id DESC);
      CREATE INDEX IF NOT EXISTS turn_checkpoints_source ON turn_checkpoints(source, id DESC);
    `);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Insert a row for a turn that just started. Returns its id (an existing row with the same uuid is reused). */
  insert(row: NewUndoCheckpoint): number {
    const existing = this.db
      .prepare("SELECT id FROM turn_checkpoints WHERE user_message_uuid = ?")
      .get(row.userMessageUuid) as { id: number } | undefined;
    if (existing) return existing.id;
    const res = this.db
      .prepare(
        `INSERT INTO turn_checkpoints
           (session_key, sdk_session_id, user_message_uuid, account_id, config_dir, cwd, source, prompt_preview, created_at, checkpointed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.sessionKey,
        row.sdkSessionId,
        row.userMessageUuid,
        row.accountId,
        row.configDir,
        row.cwd,
        row.source,
        row.promptPreview,
        row.createdAt,
        row.checkpointed === false ? 0 : 1,
      );
    return Number(res.lastInsertRowid);
  }

  /** Fill the SDK session id of a row that has none yet. */
  setSdkSessionId(id: number, sdkSessionId: string): void {
    this.db
      .prepare("UPDATE turn_checkpoints SET sdk_session_id = ? WHERE id = ? AND sdk_session_id IS NULL")
      .run(sdkSessionId, id);
  }

  /** Overwrite the SDK session id with the one the engine reported at turn end (authoritative). */
  correctSdkSessionId(id: number, sdkSessionId: string): void {
    this.db.prepare("UPDATE turn_checkpoints SET sdk_session_id = ? WHERE id = ?").run(sdkSessionId, id);
  }

  /** True when this session has any row (gap markers are written only for sessions with undo history). */
  hasRows(sessionKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM turn_checkpoints WHERE session_key = ? LIMIT 1").get(sessionKey) !== undefined;
  }

  /** True when a gap marker of this session and source lies strictly between two row ids. */
  gapBetween(sessionKey: string, source: UndoTurnSource, olderId: number, newerId: number): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM turn_checkpoints WHERE session_key = ? AND source = ? AND checkpointed = 0 AND id > ? AND id < ? LIMIT 1",
        )
        .get(sessionKey, source, olderId, newerId) !== undefined
    );
  }

  /** Replace what the turn did so far. */
  setActivity(id: number, a: UndoTurnActivity): void {
    this.db
      .prepare(
        `UPDATE turn_checkpoints
            SET files_changed = ?, files_created = ?, subagent_files = ?, bash_count = ?, bash_samples = ?
          WHERE id = ?`,
      )
      .run(
        capList(a.filesChanged, UNDO_MAX_PATHS_PER_ROW),
        capList(a.filesCreated, UNDO_MAX_PATHS_PER_ROW),
        capList(a.subagentFiles, UNDO_MAX_PATHS_PER_ROW),
        a.bashCount,
        capList(a.bashSamples, UNDO_MAX_BASH_SAMPLES),
        id,
      );
  }

  /** Mark the turn finished. The first completion time wins. */
  complete(id: number, at: number): void {
    this.db.prepare("UPDATE turn_checkpoints SET completed_at = ? WHERE id = ? AND completed_at IS NULL").run(at, id);
  }

  get(id: number): UndoCheckpoint | null {
    const r = this.db.prepare("SELECT * FROM turn_checkpoints WHERE id = ?").get(id) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  getByUuid(uuid: string): UndoCheckpoint | null {
    const r = this.db.prepare("SELECT * FROM turn_checkpoints WHERE user_message_uuid = ?").get(uuid) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  /** Newest first: every row of a chat session (chat turns and its tasks' turns). */
  recent(sessionKey: string, limit: number): UndoCheckpoint[] {
    const rows = this.db
      .prepare(`SELECT * FROM turn_checkpoints WHERE session_key = ? AND ${CHECKPOINTED} ORDER BY id DESC LIMIT ?`)
      .all(sessionKey, limit) as Row[];
    return rows.map(toCheckpoint);
  }

  /** Newest first: rows of one source of one session that changed files and are not undone yet. */
  undoCandidates(sessionKey: string, source: UndoTurnSource, limit: number): UndoCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turn_checkpoints
          WHERE session_key = ? AND source = ? AND undone_at IS NULL AND ${CHECKPOINTED} AND ${HAS_FILES}
          ORDER BY id DESC LIMIT ?`,
      )
      .all(sessionKey, source, limit) as Row[];
    return rows.map(toCheckpoint);
  }

  /** Task ids with rows whose id starts with `prefix` (newest first, distinct). */
  findTaskIds(prefix: string, limit = 5): string[] {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = this.db
      .prepare(
        `SELECT source, MAX(id) AS last FROM turn_checkpoints
          WHERE source LIKE ? ESCAPE '\\' AND ${CHECKPOINTED}
          GROUP BY source ORDER BY last DESC LIMIT ?`,
      )
      .all(`task:${escaped}%`, limit) as Array<{ source: string }>;
    return rows.map((r) => r.source.slice("task:".length));
  }

  /** Session key of a task's rows (the chat that started it). */
  taskSessionKey(taskId: string): string | null {
    const r = this.db
      .prepare("SELECT session_key FROM turn_checkpoints WHERE source = ? ORDER BY id DESC LIMIT 1")
      .get(`task:${taskId}`) as { session_key: string } | undefined;
    return r?.session_key ?? null;
  }

  markUndone(ids: readonly number[], at: number): void {
    const stmt = this.db.prepare("UPDATE turn_checkpoints SET undone_at = ? WHERE id = ? AND undone_at IS NULL");
    const tx = this.db.transaction((list: readonly number[]) => {
      for (const id of list) stmt.run(at, id);
    });
    tx(ids);
  }

  /**
   * Retention: drop rows older than `olderThanMs` (epoch ms), then keep the
   * newest `maxPerSession` rows of each session. Returns the rows deleted.
   */
  prune(opts: { maxPerSession: number; olderThanMs: number }): number {
    const byAge = this.db.prepare("DELETE FROM turn_checkpoints WHERE created_at < ?").run(opts.olderThanMs).changes;
    const byCount = this.db
      .prepare(
        `DELETE FROM turn_checkpoints WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY id DESC) AS n FROM turn_checkpoints
           ) WHERE n > ?
         )`,
      )
      .run(opts.maxPerSession).changes;
    return byAge + byCount;
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM turn_checkpoints").get() as { n: number }).n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
