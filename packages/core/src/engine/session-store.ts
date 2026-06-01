import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * A row in the sessions table.
 */
export interface SessionRow {
  session_key: string;
  sdk_session_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Default database path: ~/.kirie/sessions.db
 */
const DEFAULT_DB_PATH = join(homedir(), ".kirie", "sessions.db");

/**
 * SessionStore provides a SQLite-backed mapping from Kirie session keys
 * (channel:chatType:chatId) to Claude Agent SDK session IDs.
 *
 * This allows conversation continuity: when a user sends a follow-up
 * message in the same chat, Kirie can resume the existing Agent SDK
 * session instead of starting a new one.
 */
export class SessionStore {
  private readonly db: Database.Database;

  /**
   * @param dbPath - Path to the SQLite database file. Defaults to ~/.kirie/sessions.db
   */
  constructor(dbPath: string = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key     TEXT PRIMARY KEY,
        sdk_session_id  TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Index for listing sessions by channel prefix
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_channel
      ON sessions (session_key)
    `);

    this.migrate();
  }

  /**
   * Retrieve the Agent SDK session ID for a given session key.
   *
   * @param key - Session key (e.g. "telegram:dm:12345")
   * @returns The SDK session ID, or null if no session exists
   */
  get(key: string): string | null {
    const stmt = this.db.prepare<[string], SessionRow>(
      "SELECT sdk_session_id FROM sessions WHERE session_key = ?",
    );
    const row = stmt.get(key);
    return row?.sdk_session_id ?? null;
  }

  /**
   * Store or update a session key -> SDK session ID mapping.
   * Wrapped in a transaction for atomicity under concurrent access.
   *
   * @param key - Session key
   * @param sessionId - Agent SDK session ID
   */
  set(key: string, sessionId: string): void {
    // The connection can be closed during shutdown while a late agent task is
    // still finishing. Persisting a session ID at that point is moot — the
    // process is going away — so skip rather than throw a confusing
    // "database connection is not open" error up through the pipeline.
    if (!this.db.open) return;

    const upsert = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (session_key, sdk_session_id, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(session_key) DO UPDATE SET
          sdk_session_id = excluded.sdk_session_id,
          updated_at = datetime('now')
      `);
      stmt.run(key, sessionId);
    });
    upsert();
  }

  /**
   * Run a callback inside a SQLite transaction.
   * Useful for callers that need atomic read-modify-write sequences.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Delete a session mapping.
   *
   * @param key - Session key to remove
   * @returns true if a row was deleted, false if not found
   */
  delete(key: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM sessions WHERE session_key = ?",
    );
    const result = stmt.run(key);
    return result.changes > 0;
  }

  /**
   * List all session keys for a given channel.
   *
   * @param channel - Channel identifier (e.g. "telegram", "discord")
   * @returns Array of session keys belonging to the channel
   */
  listByChannel(channel: string): string[] {
    const prefix = `${channel}:`;
    const stmt = this.db.prepare<[string, string], SessionRow>(
      "SELECT session_key FROM sessions WHERE session_key >= ? AND session_key < ?",
    );
    // Range query: from "channel:" to "channel;" (colon + 1 in ASCII)
    const upperBound = `${channel};`;
    const rows = stmt.all(prefix, upperBound);
    return rows.map((r) => r.session_key);
  }

  /**
   * List all session keys, ordered by most recently updated first.
   *
   * @returns Array of all session keys
   */
  listAll(): string[] {
    const stmt = this.db.prepare<[], SessionRow>(
      "SELECT session_key FROM sessions ORDER BY updated_at DESC",
    );
    const rows = stmt.all();
    return rows.map((r) => r.session_key);
  }

  /**
   * Remove all session mappings.
   */
  clear(): void {
    this.db.exec("DELETE FROM sessions");
  }

  /**
   * Check whether a session key exists.
   *
   * @param key - Session key to check
   * @returns true if the key has a mapping
   */
  has(key: string): boolean {
    const stmt = this.db.prepare<[string], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM sessions WHERE session_key = ?",
    );
    const row = stmt.get(key);
    return (row?.cnt ?? 0) > 0;
  }

  /**
   * Get the total number of stored sessions.
   */
  count(): number {
    const stmt = this.db.prepare<[], { cnt: number }>(
      "SELECT COUNT(*) as cnt FROM sessions",
    );
    const row = stmt.get();
    return row?.cnt ?? 0;
  }

  /**
   * Get the full session row including timestamps.
   * Returns null if the session doesn't exist.
   */
  getRow(key: string): SessionRow | null {
    const stmt = this.db.prepare<[string], SessionRow>(
      "SELECT * FROM sessions WHERE session_key = ?",
    );
    return stmt.get(key) ?? null;
  }

  /**
   * Create a new session entry with an optional model and agentId stored
   * in the sdk_session_id field as a placeholder until a real SDK session
   * is established.
   */
  createSession(key: string, opts?: { model?: string; agentId?: string }): void {
    const placeholder = opts?.agentId
      ? `pending:${opts.agentId}:${opts.model ?? "default"}`
      : `pending:${opts?.model ?? "default"}`;
    this.set(key, placeholder);
  }

  /**
   * Resolve a session key by its human-readable label.
   * Returns the session key or null if not found.
   */
  resolveByLabel(label: string): string | null {
    const stmt = this.db.prepare<[string], { session_key: string }>(
      "SELECT session_key FROM session_labels WHERE label = ?",
    );
    const row = stmt.get(label);
    return row?.session_key ?? null;
  }

  /**
   * Set a human-readable label for a session key.
   */
  setLabel(key: string, label: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO session_labels (session_key, label)
      VALUES (?, ?)
      ON CONFLICT(session_key) DO UPDATE SET label = excluded.label
    `);
    stmt.run(key, label);
  }

  /**
   * List session keys that start with the given prefix.
   */
  listByPrefix(prefix: string): string[] {
    const stmt = this.db.prepare<[string, string], SessionRow>(
      "SELECT session_key FROM sessions WHERE session_key >= ? AND session_key < ?",
    );
    // Range query: from prefix to prefix with last char incremented
    const upperBound = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const rows = stmt.all(prefix, upperBound);
    return rows.map((r) => r.session_key);
  }

  /**
   * Run schema migrations for new columns/tables.
   * Called once during construction.
   */
  private migrate(): void {
    // Add session_labels table for human-readable labels
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_labels (
        session_key  TEXT PRIMARY KEY,
        label        TEXT NOT NULL,
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      )
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_labels_label
      ON session_labels (label)
    `);
  }

  /**
   * Close the database connection. Should be called during shutdown.
   */
  close(): void {
    this.db.close();
  }
}
