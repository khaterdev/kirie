import Database from "better-sqlite3";
import { Cron } from "croner";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import type { BackgroundTaskStore } from "../../engine/background-task-store.js";

const DEFAULT_DB_PATH = join(homedir(), ".kirie", "memory.db");

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
  active_hours: string | null;
  session_target: string;
  at: string | null;
  timezone: string | null;
}

export interface ActiveHoursConfig {
  start: string;  // "09:00"
  end: string;    // "17:00"
  timezone?: string;
  days?: number[]; // [1,2,3,4,5] = weekdays
}

export interface WebhookEntry {
  name: string;
  path: string;
  method: string;
  handler_message: string;
  channel: string;
  chat_id: string;
  created_at: string;
}

export interface WebhookFireEvent {
  name: string;
  path: string;
  handlerMessage: string;
  channel: string;
  chatId: string;
  requestBody?: unknown;
  requestHeaders?: Record<string, string>;
}

interface ScheduleRow {
  name: string;
  cron: string;
  message: string;
  channel: string;
  chat_id: string;
  created_at: string;
  max_runs: number | null;
  run_count: number;
  active_hours: string | null;
  session_target: string;
  at: string | null;
  timezone: string | null;
  delivery: string | null;
}

interface WebhookRow {
  name: string;
  path: string;
  method: string;
  handler_message: string;
  channel: string;
  chat_id: string;
  created_at: string;
}

export type ScheduleDeliveryMode = "announce" | "post-to-main" | "payload" | "none";

export interface ScheduleFireEvent {
  name: string;
  message: string;
  channel: string;
  chatId: string;
  sessionKey?: string;
  delivery: ScheduleDeliveryMode;
}

/**
 * ScheduleStore manages cron-based scheduled reminders backed by SQLite.
 * Emits "fire" events when a schedule triggers so the caller can route messages.
 */
export class ScheduleStore extends EventEmitter {
  private db: Database.Database;
  private jobs: Map<string, Cron> = new Map();
  private backgroundTaskStore: BackgroundTaskStore | null = null;

  constructor(dbPath?: string) {
    super();
    const path = dbPath ?? DEFAULT_DB_PATH;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  /**
   * Set the BackgroundTaskStore reference for auto-canceling spawned tasks
   * when a schedule is deleted.
   */
  setBackgroundTaskStore(store: BackgroundTaskStore): void {
    this.backgroundTaskStore = store;
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

    // Add max_runs and run_count columns for one-time / N-times schedules
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

    // Add active_hours column for time-gated schedules
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN active_hours TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }

    // Add session_target column for isolated job agents
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN session_target TEXT NOT NULL DEFAULT 'main'`);
    } catch {
      // Column already exists
    }

    // Add at column for one-shot ISO 8601 scheduling
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN at TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }

    // Add timezone column
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN timezone TEXT DEFAULT NULL`);
    } catch {
      // Column already exists
    }

    // Add delivery column (announce, post-to-main, payload, none)
    try {
      this.db.exec(`ALTER TABLE schedules ADD COLUMN delivery TEXT DEFAULT 'announce'`);
    } catch {
      // Column already exists
    }

    // Webhooks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        name            TEXT PRIMARY KEY,
        path            TEXT NOT NULL UNIQUE,
        method          TEXT NOT NULL DEFAULT 'POST',
        handler_message TEXT NOT NULL,
        channel         TEXT NOT NULL,
        chat_id         TEXT NOT NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private startCronJob(row: ScheduleRow): void {
    if (this.jobs.has(row.name)) {
      this.jobs.get(row.name)!.stop();
    }

    const cronOptions: Record<string, unknown> = {};
    if (row.max_runs != null) {
      const remaining = row.max_runs - row.run_count;
      if (remaining <= 0) {
        // Already exhausted — clean up instead of starting
        this.delete(row.name);
        return;
      }
      cronOptions.maxRuns = remaining;
    }

    // Handle `at` parameter: one-shot scheduling at a specific ISO 8601 time
    let cronExpr = row.cron;
    if (row.at) {
      const targetDate = new Date(row.at);
      if (targetDate.getTime() <= Date.now()) {
        // Target time already passed, clean up
        this.delete(row.name);
        return;
      }
      // Use per-second cron with startAt so it fires at the exact target time
      cronExpr = `${targetDate.getUTCSeconds()} ${targetDate.getUTCMinutes()} ${targetDate.getUTCHours()} ${targetDate.getUTCDate()} ${targetDate.getUTCMonth() + 1} *`;
      cronOptions.maxRuns = 1;
      cronOptions.timezone = "UTC";
    }

    if (row.timezone && !row.at) {
      cronOptions.timezone = row.timezone;
    }

    const job = new Cron(cronExpr, cronOptions, () => {
      // Check active hours gating before firing
      if (row.active_hours) {
        try {
          const config = JSON.parse(row.active_hours) as ActiveHoursConfig;
          if (!isWithinActiveHours(config)) {
            return; // Outside active hours, skip this run
          }
        } catch {
          // Invalid config, fire anyway
        }
      }

      const event: ScheduleFireEvent = {
        name: row.name,
        message: row.message,
        channel: row.channel,
        chatId: row.chat_id,
        delivery: (row.delivery as ScheduleDeliveryMode) || "announce",
      };

      // For isolated sessions, generate a unique session key
      if (row.session_target === "isolated") {
        event.sessionKey = `cron:${row.name}:${Date.now()}`;
      }

      this.emit("fire", event);

      if (row.max_runs != null) {
        this.db
          .prepare("UPDATE schedules SET run_count = run_count + 1 WHERE name = ?")
          .run(row.name);

        const updated = this.db
          .prepare("SELECT run_count FROM schedules WHERE name = ?")
          .get(row.name) as { run_count: number } | undefined;

        if (updated && updated.run_count >= row.max_runs) {
          this.delete(row.name);
        }
      }
    });

    this.jobs.set(row.name, job);
  }

  private rowToEntry(row: ScheduleRow): ScheduleEntry {
    const job = this.jobs.get(row.name);
    const nextRun = job?.nextRun();

    return {
      name: row.name,
      cron: row.cron,
      message: row.message,
      channel: row.channel,
      chatId: row.chat_id,
      created_at: row.created_at,
      next_run: nextRun ? nextRun.toISOString() : null,
      max_runs: row.max_runs,
      run_count: row.run_count,
      remaining: row.max_runs != null ? row.max_runs - row.run_count : null,
      active_hours: row.active_hours,
      session_target: row.session_target,
      at: row.at ?? null,
      timezone: row.timezone ?? null,
    };
  }

  /**
   * Reload all persisted schedules from the database and start their cron jobs.
   * Should be called once on startup.
   */
  loadAll(): void {
    const rows = this.db
      .prepare("SELECT * FROM schedules")
      .all() as ScheduleRow[];

    for (const row of rows) {
      try {
        this.startCronJob(row);
      } catch {
        // Invalid cron expression - skip but leave in DB for user to fix
      }
    }
  }

  create(
    name: string,
    cron: string,
    message: string,
    channel: string,
    chatId: string,
    maxRuns?: number,
    activeHours?: ActiveHoursConfig,
    sessionTarget?: "main" | "isolated",
    options?: { at?: string; timezone?: string },
  ): ScheduleEntry {
    // Validate the cron expression by creating a temporary Cron instance
    const testJob = new Cron(cron);
    testJob.stop();

    const now = new Date().toISOString();
    const maxRunsValue = maxRuns ?? null;
    const activeHoursJson = activeHours ? JSON.stringify(activeHours) : null;
    const sessionTargetValue = sessionTarget ?? "main";
    const atValue = options?.at ?? null;
    const timezoneValue = options?.timezone ?? null;

    this.db
      .prepare(
        `INSERT INTO schedules (name, cron, message, channel, chat_id, created_at, max_runs, run_count, active_hours, session_target, at, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           cron            = excluded.cron,
           message         = excluded.message,
           channel         = excluded.channel,
           chat_id         = excluded.chat_id,
           max_runs        = excluded.max_runs,
           run_count       = 0,
           active_hours    = excluded.active_hours,
           session_target  = excluded.session_target,
           at              = excluded.at,
           timezone        = excluded.timezone`,
      )
      .run(name, cron, message, channel, chatId, now, maxRunsValue, activeHoursJson, sessionTargetValue, atValue, timezoneValue);

    const row: ScheduleRow = {
      name, cron, message, channel, chat_id: chatId, created_at: now,
      max_runs: maxRunsValue, run_count: 0,
      active_hours: activeHoursJson, session_target: sessionTargetValue,
      at: atValue, timezone: timezoneValue,
    };
    this.startCronJob(row);

    return this.rowToEntry(row);
  }

  // ── Webhook methods ──────────────────────────────────────────────────────

  createWebhook(
    name: string,
    path: string,
    method: string,
    handlerMessage: string,
    channel: string,
    chatId: string,
  ): WebhookEntry {
    this.db
      .prepare(
        `INSERT INTO webhooks (name, path, method, handler_message, channel, chat_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path            = excluded.path,
           method          = excluded.method,
           handler_message = excluded.handler_message,
           channel         = excluded.channel,
           chat_id         = excluded.chat_id`,
      )
      .run(name, path, method, handlerMessage, channel, chatId);

    return this.db.prepare("SELECT * FROM webhooks WHERE name = ?").get(name) as WebhookEntry;
  }

  getWebhook(nameOrPath: string): WebhookEntry | null {
    const row = this.db
      .prepare("SELECT * FROM webhooks WHERE name = ? OR path = ?")
      .get(nameOrPath, nameOrPath) as WebhookRow | undefined;
    return row ?? null;
  }

  listWebhooks(): WebhookEntry[] {
    return this.db
      .prepare("SELECT * FROM webhooks ORDER BY created_at ASC")
      .all() as WebhookEntry[];
  }

  deleteWebhook(name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM webhooks WHERE name = ?")
      .run(name);
    return result.changes > 0;
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
    // Auto-cancel any running/pending background tasks spawned by this schedule.
    // Payload-delivery crons create background tasks with description "Scheduled task: <name>".
    if (this.backgroundTaskStore) {
      const row = this.db
        .prepare("SELECT delivery FROM schedules WHERE name = ?")
        .get(name) as { delivery: string | null } | undefined;

      if (row?.delivery === "payload") {
        const prefix = `Scheduled task: ${name}`;
        const activeTasks = this.backgroundTaskStore.listByDescription(prefix, true);
        for (const task of activeTasks) {
          this.backgroundTaskStore.addCommand(task.id, "kill");
          this.backgroundTaskStore.markCancelled(task.id);
        }
      }
    }

    const job = this.jobs.get(name);
    if (job) {
      job.stop();
      this.jobs.delete(name);
    }

    const result = this.db
      .prepare("DELETE FROM schedules WHERE name = ?")
      .run(name);

    return result.changes > 0;
  }

  /**
   * Sync schedules from the database that were created externally
   * (e.g., by the stdio MCP server's ScheduleCrudStore).
   * Starts cron jobs for any DB entries that don't have a running job.
   * Also stops jobs for entries that were deleted from the DB.
   */
  syncFromDb(): void {
    const rows = this.db
      .prepare("SELECT * FROM schedules")
      .all() as ScheduleRow[];

    const dbNames = new Set(rows.map((r) => r.name));

    // Start jobs for new schedules not yet tracked
    for (const row of rows) {
      if (!this.jobs.has(row.name)) {
        try {
          this.startCronJob(row);
        } catch {
          // Invalid cron — skip
        }
      }
    }

    // Stop jobs for schedules deleted from DB
    for (const name of this.jobs.keys()) {
      if (!dbNames.has(name)) {
        this.jobs.get(name)!.stop();
        this.jobs.delete(name);
      }
    }
  }

  stopAll(): void {
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
  }

  /** Expose the underlying database for shared access (e.g., LabelStore). */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.stopAll();
    this.db.close();
  }
}

// ── Active hours helper ─────────────────────────────────────────────────────

export function isWithinActiveHours(config: ActiveHoursConfig): boolean {
  const now = new Date();

  // Check day of week if days are specified
  if (config.days && config.days.length > 0) {
    const currentDay = now.getDay(); // 0=Sun, 1=Mon, ...
    if (!config.days.includes(currentDay)) {
      return false;
    }
  }

  // Parse start/end times
  const [startH, startM] = config.start.split(":").map(Number);
  const [endH, endM] = config.end.split(":").map(Number);

  // Get current time in the specified timezone or local
  let currentMinutes: number;
  if (config.timezone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    currentMinutes = hour * 60 + minute;
  } else {
    currentMinutes = now.getHours() * 60 + now.getMinutes();
  }

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wraps midnight (e.g., 22:00 - 06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// ── MCP tool definitions ────────────────────────────────────────────────────

export function createScheduleToolHandlers(store: ScheduleStore) {
  return {
    schedule_create: {
      description: "Create a cron-based scheduled reminder. Uses standard cron syntax (e.g., '0 9 * * *' for 9 AM daily). Supports one-time (maxRuns=1), limited-run (maxRuns=N), and recurring (omit maxRuns) schedules. Use 'at' for ISO 8601 one-shot scheduling. Supports active hours gating and isolated session targets.",
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
          timezone: { type: "string" as const, description: "IANA timezone for schedule evaluation (e.g., 'America/New_York')." },
          activeHours: { type: "string" as const, description: 'JSON object with active hours config: {"start":"09:00","end":"17:00","timezone":"America/New_York","days":[1,2,3,4,5]}. Schedule will only fire within these hours.' },
          sessionTarget: { type: "string" as const, description: '"main" (default) uses the shared session, "isolated" creates a unique session per run.' },
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
        timezone?: string;
        activeHours?: string;
        sessionTarget?: string;
      }): ScheduleEntry {
        let activeHoursConfig: ActiveHoursConfig | undefined;
        if (params.activeHours) {
          activeHoursConfig = JSON.parse(params.activeHours) as ActiveHoursConfig;
        }
        return store.create(
          params.name,
          params.cron,
          params.message,
          params.channel,
          params.chatId,
          params.maxRuns,
          activeHoursConfig,
          (params.sessionTarget as "main" | "isolated") ?? undefined,
          { at: params.at, timezone: params.timezone },
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

    schedule_webhook: {
      description: "Create a webhook endpoint that triggers an agent task when called. The webhook URL will be /webhooks/<path>.",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Unique name for this webhook" },
          path: { type: "string" as const, description: "URL path for the webhook (e.g., 'deploy-notify')" },
          method: { type: "string" as const, description: "HTTP method: GET or POST (default: POST)" },
          handlerMessage: { type: "string" as const, description: "Message/task to send to the agent when webhook is triggered" },
          channel: { type: "string" as const, description: "Channel to route response through" },
          chatId: { type: "string" as const, description: "Chat ID to route response to" },
        },
        required: ["name", "path", "handlerMessage", "channel", "chatId"] as const,
      },
      handler(params: {
        name: string;
        path: string;
        method?: string;
        handlerMessage: string;
        channel: string;
        chatId: string;
      }): WebhookEntry {
        return store.createWebhook(
          params.name,
          params.path,
          params.method ?? "POST",
          params.handlerMessage,
          params.channel,
          params.chatId,
        );
      },
    },

    webhook_list: {
      description: "List all registered webhooks.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler(): WebhookEntry[] {
        return store.listWebhooks();
      },
    },

    webhook_delete: {
      description: "Delete a webhook by name.",
      parameters: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Name of the webhook to delete" },
        },
        required: ["name"] as const,
      },
      handler(params: { name: string }): { deleted: boolean } {
        return { deleted: store.deleteWebhook(params.name) };
      },
    },
  };
}
