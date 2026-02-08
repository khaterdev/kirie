import Database from "better-sqlite3";
import { Cron } from "croner";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "memory.db");

export type DeliveryMode = "announce" | "post-to-main" | "payload" | "none";

export interface ScheduleEntry {
  name: string;
  cron: string;
  message: string;
  channel: string;
  chatId: string;
  created_at: string;
  next_run: string | null;
  max_runs: number | null;
  run_count: number;
  remaining: number | null;
  at: string | null;
  delivery: DeliveryMode;
  keepAfterRun: boolean;
  timezone: string | null;
}

export interface ScheduleRow {
  name: string;
  cron: string;
  message: string;
  channel: string;
  chat_id: string;
  created_at: string;
  max_runs: number | null;
  run_count: number;
  at: string | null;
  delivery: string | null;
  keep_after_run: number | null;
  timezone: string | null;
}

/**
 * ScheduleCrudStore provides pure CRUD operations on the schedules table
 * without managing any Cron jobs. This is used by the stdio MCP server
 * so that multiple subprocesses don't each start their own cron jobs.
 *
 * The daemon process uses the full ScheduleStore (which extends this)
 * to also manage cron job lifecycle.
 */
export class ScheduleCrudStore {
  protected db: Database.Database;

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
      CREATE TABLE IF NOT EXISTS schedules (
        name       TEXT PRIMARY KEY,
        cron       TEXT NOT NULL,
        message    TEXT NOT NULL,
        channel    TEXT NOT NULL,
        chat_id    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN max_runs INTEGER DEFAULT NULL`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN at TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN delivery TEXT DEFAULT 'announce'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN keep_after_run INTEGER DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN timezone TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }
  }

  protected rowToEntry(row: ScheduleRow): ScheduleEntry {
    // Without cron jobs, we compute next_run from the cron expression
    let nextRun: string | null = null;
    try {
      const cron = new Cron(row.cron);
      const next = cron.nextRun();
      nextRun = next ? next.toISOString() : null;
      cron.stop();
    } catch {
      // Invalid cron — leave next_run null
    }

    return {
      name: row.name,
      cron: row.cron,
      message: row.message,
      channel: row.channel,
      chatId: row.chat_id,
      created_at: row.created_at,
      next_run: nextRun,
      max_runs: row.max_runs,
      run_count: row.run_count,
      remaining: row.max_runs != null ? row.max_runs - row.run_count : null,
      at: row.at ?? null,
      delivery: (row.delivery as DeliveryMode) ?? "announce",
      keepAfterRun: row.keep_after_run === 1,
      timezone: row.timezone ?? null,
    };
  }

  create(
    name: string,
    cron: string,
    message: string,
    channel: string,
    chatId: string,
    maxRuns?: number,
    options?: { at?: string; delivery?: DeliveryMode; keepAfterRun?: boolean; timezone?: string },
  ): ScheduleEntry {
    // Validate the cron expression
    const testJob = new Cron(cron);
    testJob.stop();

    const now = new Date().toISOString();
    const maxRunsValue = maxRuns ?? null;
    const atValue = options?.at ?? null;
    const deliveryValue = options?.delivery ?? "announce";
    const keepAfterRunValue = options?.keepAfterRun ?? false;
    const timezoneValue = options?.timezone ?? null;

    this.db
      .prepare(
        `INSERT INTO schedules (name, cron, message, channel, chat_id, created_at, max_runs, run_count, at, delivery, keep_after_run, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           cron           = excluded.cron,
           message        = excluded.message,
           channel        = excluded.channel,
           chat_id        = excluded.chat_id,
           max_runs       = excluded.max_runs,
           run_count      = 0,
           at             = excluded.at,
           delivery       = excluded.delivery,
           keep_after_run = excluded.keep_after_run,
           timezone       = excluded.timezone`,
      )
      .run(name, cron, message, channel, chatId, now, maxRunsValue, atValue, deliveryValue, keepAfterRunValue ? 1 : 0, timezoneValue);

    const row: ScheduleRow = {
      name, cron, message, channel, chat_id: chatId, created_at: now,
      max_runs: maxRunsValue, run_count: 0,
      at: atValue, delivery: deliveryValue, keep_after_run: keepAfterRunValue ? 1 : 0, timezone: timezoneValue,
    };

    return this.rowToEntry(row);
  }

  list(): ScheduleEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM schedules ORDER BY created_at ASC")
      .all() as ScheduleRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  get(name: string): ScheduleEntry | null {
    const row = this.db
      .prepare("SELECT * FROM schedules WHERE name = ?")
      .get(name) as ScheduleRow | undefined;

    return row ? this.rowToEntry(row) : null;
  }

  delete(name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM schedules WHERE name = ?")
      .run(name);

    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Creates schedule tool handlers that use a ScheduleCrudStore (CRUD-only, no cron jobs).
 * Used by the stdio MCP server.
 */
export function createScheduleCrudToolHandlers(store: ScheduleCrudStore) {
  return {
    schedule_create: {
      description: "Create a cron-based scheduled reminder. Uses standard cron syntax (e.g., '0 9 * * *' for 9 AM daily). Supports one-time (maxRuns=1), limited-run (maxRuns=N), and recurring (omit maxRuns) schedules. Use 'at' for ISO 8601 one-shot scheduling.",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Unique name for this schedule" },
          cron: { type: "string" as const, description: "Cron expression (e.g., '0 9 * * *')" },
          message: { type: "string" as const, description: "Message to send when the schedule fires" },
          channel: { type: "string" as const, description: "Channel to send through (telegram, discord, etc.)" },
          chatId: { type: "string" as const, description: "Chat/conversation ID to send to" },
          maxRuns: { type: "number" as const, description: "Maximum number of times to fire. 1 = one-time, N = fire N times then auto-delete. Omit for unlimited recurring." },
          at: { type: "string" as const, description: "ISO 8601 datetime for one-shot scheduling (e.g., '2025-03-15T09:00:00Z'). Alternative to cron for single-fire schedules." },
          delivery: { type: "string" as const, enum: ["announce", "post-to-main", "payload", "none"], description: "Delivery mode: 'announce' (default), 'post-to-main', 'payload', or 'none'." },
          keepAfterRun: { type: "boolean" as const, description: "Whether to keep the schedule entry after it fires (default false for one-shot)." },
          timezone: { type: "string" as const, description: "IANA timezone for schedule evaluation (e.g., 'America/New_York')." },
        },
        required: ["name", "cron", "message", "channel", "chatId"] as const,
      },
      handler(params: {
        name: string;
        cron: string;
        message: string;
        channel: string;
        chatId: string;
        maxRuns?: number;
        at?: string;
        delivery?: DeliveryMode;
        keepAfterRun?: boolean;
        timezone?: string;
      }): ScheduleEntry {
        return store.create(
          params.name,
          params.cron,
          params.message,
          params.channel,
          params.chatId,
          params.maxRuns,
          {
            at: params.at,
            delivery: params.delivery,
            keepAfterRun: params.keepAfterRun,
            timezone: params.timezone,
          },
        );
      },
    },

    schedule_list: {
      description: "List all scheduled tasks with their next run times.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler(): ScheduleEntry[] {
        return store.list();
      },
    },

    schedule_delete: {
      description: "Delete a scheduled task by name.",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Name of the schedule to delete" },
        },
        required: ["name"] as const,
      },
      handler(params: { name: string }): { deleted: boolean } {
        return { deleted: store.delete(params.name) };
      },
    },
  };
}
