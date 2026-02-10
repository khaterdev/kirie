import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "background-tasks.db");

export type BackgroundTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type BackgroundTaskCommandAction = "kill" | "send_message";

export interface BackgroundTaskCommand {
  id: string;
  task_id: string;
  action: BackgroundTaskCommandAction;
  data: string | null;
  interrupt: boolean;
  processed: boolean;
  created_at: string;
}

interface BackgroundTaskCommandRow {
  id: string;
  task_id: string;
  action: string;
  data: string | null;
  interrupt: number;
  processed: number;
  created_at: string;
}

export interface BackgroundTask {
  id: string;
  session_key: string;
  description: string;
  prompt: string;
  status: BackgroundTaskStatus;
  result: string | null;
  error: string | null;
  cost_usd: number;
  num_turns: number;
  created_at: string;
  updated_at: string;
  sdk_session_id: string | null;
}

interface BackgroundTaskRow {
  id: string;
  session_key: string;
  description: string;
  prompt: string;
  status: string;
  result: string | null;
  error: string | null;
  cost_usd: number;
  num_turns: number;
  created_at: string;
  updated_at: string;
  sdk_session_id: string | null;
}

/**
 * BackgroundTaskStore manages background task metadata in SQLite.
 * Tasks are created via MCP tool calls and picked up by the
 * BackgroundTaskManager in the daemon process.
 */
export class BackgroundTaskStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        id              TEXT PRIMARY KEY,
        session_key     TEXT NOT NULL,
        description     TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        result          TEXT,
        error           TEXT,
        cost_usd        REAL NOT NULL DEFAULT 0,
        num_turns       INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        sdk_session_id  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_background_tasks_session_key
        ON background_tasks(session_key);
      CREATE INDEX IF NOT EXISTS idx_background_tasks_status
        ON background_tasks(status);

      CREATE TABLE IF NOT EXISTS background_task_commands (
        id          TEXT PRIMARY KEY,
        task_id     TEXT NOT NULL,
        action      TEXT NOT NULL,
        data        TEXT,
        interrupt   INTEGER NOT NULL DEFAULT 0,
        processed   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_btc_unprocessed
        ON background_task_commands(processed) WHERE processed = 0;
    `);
  }

  private rowToTask(row: BackgroundTaskRow): BackgroundTask {
    return {
      ...row,
      status: row.status as BackgroundTaskStatus,
    };
  }

  /**
   * Create a new background task in pending state.
   */
  create(sessionKey: string, description: string, prompt: string): BackgroundTask {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO background_tasks (id, session_key, description, prompt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, sessionKey, description, prompt, now, now);

    return {
      id,
      session_key: sessionKey,
      description,
      prompt,
      status: "pending",
      result: null,
      error: null,
      cost_usd: 0,
      num_turns: 0,
      created_at: now,
      updated_at: now,
      sdk_session_id: null,
    };
  }

  /**
   * Get a task by ID.
   */
  get(id: string): BackgroundTask | null {
    const row = this.db
      .prepare("SELECT * FROM background_tasks WHERE id = ?")
      .get(id) as BackgroundTaskRow | undefined;

    return row ? this.rowToTask(row) : null;
  }

  /**
   * List tasks for a session key, optionally filtered by status.
   */
  list(sessionKey: string, status?: BackgroundTaskStatus): BackgroundTask[] {
    let rows: BackgroundTaskRow[];

    if (status) {
      rows = this.db
        .prepare(
          "SELECT * FROM background_tasks WHERE session_key = ? AND status = ? ORDER BY created_at DESC",
        )
        .all(sessionKey, status) as BackgroundTaskRow[];
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM background_tasks WHERE session_key = ? ORDER BY created_at DESC",
        )
        .all(sessionKey) as BackgroundTaskRow[];
    }

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Get all tasks with a given status (used by the poller to find pending tasks).
   */
  listByStatus(status: BackgroundTaskStatus): BackgroundTask[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM background_tasks WHERE status = ? ORDER BY created_at ASC",
      )
      .all(status) as BackgroundTaskRow[];

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Find tasks whose description starts with the given prefix.
   * Optionally filter to only active (pending/running) tasks.
   */
  listByDescription(descriptionPrefix: string, activeOnly = false): BackgroundTask[] {
    const pattern = descriptionPrefix + "%";
    let rows: BackgroundTaskRow[];

    if (activeOnly) {
      rows = this.db
        .prepare(
          "SELECT * FROM background_tasks WHERE description LIKE ? AND status IN ('pending', 'running') ORDER BY created_at DESC",
        )
        .all(pattern) as BackgroundTaskRow[];
    } else {
      rows = this.db
        .prepare(
          "SELECT * FROM background_tasks WHERE description LIKE ? ORDER BY created_at DESC",
        )
        .all(pattern) as BackgroundTaskRow[];
    }

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * Update task status to running and set the SDK session ID.
   */
  markRunning(id: string, sdkSessionId?: string): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET status = 'running', sdk_session_id = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(sdkSessionId ?? null, id);
  }

  /**
   * Update task with completion result.
   */
  markCompleted(id: string, result: string, costUsd: number, numTurns: number): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET status = 'completed', result = ?, cost_usd = ?, num_turns = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(result, costUsd, numTurns, id);
  }

  /**
   * Update task with failure info.
   */
  markFailed(id: string, error: string): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET status = 'failed', error = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(error, id);
  }

  /**
   * Mark a task as cancelled.
   */
  markCancelled(id: string): void {
    this.db
      .prepare(
        `UPDATE background_tasks
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(id);
  }

  // ── Command methods ──────────────────────────────────────────────────────

  private rowToCommand(row: BackgroundTaskCommandRow): BackgroundTaskCommand {
    return {
      ...row,
      action: row.action as BackgroundTaskCommandAction,
      interrupt: row.interrupt === 1,
      processed: row.processed === 1,
    };
  }

  /**
   * Insert a command for a background task.
   * Returns the command ID.
   */
  addCommand(
    taskId: string,
    action: BackgroundTaskCommandAction,
    data?: string,
    interrupt?: boolean,
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO background_task_commands (id, task_id, action, data, interrupt)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, action, data ?? null, interrupt ? 1 : 0);
    return id;
  }

  /**
   * Fetch all unprocessed commands, ordered by creation time.
   */
  getUnprocessedCommands(): BackgroundTaskCommand[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM background_task_commands WHERE processed = 0 ORDER BY created_at ASC",
      )
      .all() as BackgroundTaskCommandRow[];
    return rows.map((row) => this.rowToCommand(row));
  }

  /**
   * Mark a command as processed.
   */
  markCommandProcessed(id: string): void {
    this.db
      .prepare("UPDATE background_task_commands SET processed = 1 WHERE id = ?")
      .run(id);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
