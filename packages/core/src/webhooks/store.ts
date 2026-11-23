/**
 * WebhookStore: `~/.kirie/webhooks.db` (PLAN C.6, R3 "Data").
 *
 * Two tables. `hooks` holds definitions (never a secret value, only the
 * credential-store key). `deliveries` is the persisted replay cache and the
 * `/webhook log` source; rows are kept `deliveryRetentionDays`. Requests that
 * fail authentication are never stored here (they are attacker-controlled and
 * unbounded); they go to counters and sampled audit records.
 */

import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  WebhookAction,
  WebhookDefinition,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookSource,
  WebhookToolProfile,
} from "./types.js";

/** Owner-facing hook name: lower-case slug. */
export const WEBHOOK_NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
/** URL path segment. Checked before anything else on every request. */
export const WEBHOOK_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

interface HookRow {
  id: string;
  name: string;
  source: string;
  enabled: number;
  secret_ref: string;
  prev_secret_ref: string | null;
  prev_secret_expires_at: string | null;
  events: string;
  action: string;
  tool_profile: string;
  allow_full: number;
  instructions: string;
  fields: string;
  include_raw: number;
  ip_allowlist: string;
  rate_per_min: number | null;
  daily_cap: number | null;
  channel: string;
  chat_id: string;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: number;
  hook_id: string;
  dedupe_key: string;
  provider_id: string | null;
  event: string | null;
  status: string;
  task_id: string | null;
  note: string | null;
  body_bytes: number | null;
  remote_ip: string | null;
  received_at: string;
}

export interface NewWebhookInput {
  name: string;
  source: WebhookSource;
  action: WebhookAction;
  toolProfile: WebhookToolProfile;
  events?: string[];
  instructions?: string;
  fields?: string[];
  channel: string;
  chatId: string;
}

/** Fields `/webhook set` and enable/disable may change. */
export type WebhookPatch = Partial<Pick<WebhookDefinition,
  | "enabled" | "events" | "action" | "toolProfile" | "allowFull" | "instructions" | "fields"
  | "includeRaw" | "ipAllowlist" | "ratePerMin" | "dailyCap" | "prevSecretRef" | "prevSecretExpiresAt">>;

export interface WebhookClaimInput {
  hookId: string;
  dedupeKey: string;
  providerId?: string | null;
  event?: string | null;
  bodyBytes?: number;
  remoteIp?: string | null;
  receivedAt: string;
}

/** Credential-store key of a hook's current secret. */
export function webhookSecretRef(id: string): string {
  return `webhook.${id}.secret`;
}

/** Credential-store key of a hook's previous secret during a rotation grace window. */
export function webhookPrevSecretRef(id: string): string {
  return `webhook.${id}.secret-prev`;
}

/** "<name>-<8 hex>": the random suffix makes ids unguessable from the name. */
export function newWebhookId(name: string): string {
  return `${name}-${randomBytes(4).toString("hex")}`;
}

export class WebhookStore {
  private readonly db: Database.Database;

  /**
   * @param dbPath ~/.kirie/webhooks.db. Created 0600 (directory 0700 when created here).
   * @param opts.readonly open an existing file read-only (the MCP tools)
   */
  constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
    if (opts.readonly) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.db.pragma("busy_timeout = 3000");
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    if (!existsSync(dbPath)) closeSync(openSync(dbPath, "a", 0o600));
    chmodSync(dbPath, 0o600);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hooks (
        id                     TEXT PRIMARY KEY,
        name                   TEXT NOT NULL UNIQUE,
        source                 TEXT NOT NULL,
        enabled                INTEGER NOT NULL DEFAULT 0,
        secret_ref             TEXT NOT NULL,
        prev_secret_ref        TEXT,
        prev_secret_expires_at TEXT,
        events                 TEXT NOT NULL DEFAULT '[]',
        action                 TEXT NOT NULL DEFAULT 'notify',
        tool_profile           TEXT NOT NULL DEFAULT 'summarize',
        allow_full             INTEGER NOT NULL DEFAULT 0,
        instructions           TEXT NOT NULL DEFAULT '',
        fields                 TEXT NOT NULL DEFAULT '[]',
        include_raw            INTEGER NOT NULL DEFAULT 1,
        ip_allowlist           TEXT NOT NULL DEFAULT '[]',
        rate_per_min           INTEGER,
        daily_cap              INTEGER,
        channel                TEXT NOT NULL,
        chat_id                TEXT NOT NULL,
        verified_at            TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        hook_id     TEXT NOT NULL,
        dedupe_key  TEXT NOT NULL,
        provider_id TEXT,
        event       TEXT,
        status      TEXT NOT NULL,
        task_id     TEXT,
        note        TEXT,
        body_bytes  INTEGER,
        remote_ip   TEXT,
        received_at TEXT NOT NULL,
        UNIQUE(hook_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_hook_time ON deliveries(hook_id, received_at);
    `);
  }

  // ── hooks ──────────────────────────────────────────────────────────────

  /** Creates the hook **disabled**. Throws on a bad or duplicate name. */
  createHook(input: NewWebhookInput, now: Date = new Date()): WebhookDefinition {
    if (!WEBHOOK_NAME_RE.test(input.name)) {
      throw new Error("Hook name must be 2 to 40 characters: lower-case letters, digits and dashes, starting with a letter or digit");
    }
    if (this.getHookByName(input.name)) throw new Error(`A hook named "${input.name}" already exists`);
    const id = newWebhookId(input.name);
    const ts = now.toISOString();
    this.db.prepare(`
      INSERT INTO hooks (id, name, source, enabled, secret_ref, events, action, tool_profile, instructions, fields,
                         channel, chat_id, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.source, webhookSecretRef(id), JSON.stringify(input.events ?? []),
      input.action, input.toolProfile, input.instructions ?? "", JSON.stringify(input.fields ?? []),
      input.channel, input.chatId, ts, ts,
    );
    return this.getHook(id)!;
  }

  getHook(id: string): WebhookDefinition | null {
    const row = this.db.prepare("SELECT * FROM hooks WHERE id = ?").get(id) as HookRow | undefined;
    return row ? hookFromRow(row) : null;
  }

  getHookByName(name: string): WebhookDefinition | null {
    const row = this.db.prepare("SELECT * FROM hooks WHERE name = ?").get(name) as HookRow | undefined;
    return row ? hookFromRow(row) : null;
  }

  /** By id, or by name when no id matches. */
  findHook(idOrName: string): WebhookDefinition | null {
    return this.getHook(idOrName) ?? this.getHookByName(idOrName);
  }

  listHooks(): WebhookDefinition[] {
    const rows = this.db.prepare("SELECT * FROM hooks ORDER BY created_at ASC, id ASC").all() as HookRow[];
    return rows.map(hookFromRow);
  }

  updateHook(id: string, patch: WebhookPatch, now: Date = new Date()): WebhookDefinition | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (col: string, v: unknown): void => { sets.push(`${col} = ?`); values.push(v); };
    if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
    if (patch.events !== undefined) put("events", JSON.stringify(patch.events));
    if (patch.action !== undefined) put("action", patch.action);
    if (patch.toolProfile !== undefined) put("tool_profile", patch.toolProfile);
    if (patch.allowFull !== undefined) put("allow_full", patch.allowFull ? 1 : 0);
    if (patch.instructions !== undefined) put("instructions", patch.instructions);
    if (patch.fields !== undefined) put("fields", JSON.stringify(patch.fields));
    if (patch.includeRaw !== undefined) put("include_raw", patch.includeRaw ? 1 : 0);
    if (patch.ipAllowlist !== undefined) put("ip_allowlist", JSON.stringify(patch.ipAllowlist));
    if (patch.ratePerMin !== undefined) put("rate_per_min", patch.ratePerMin);
    if (patch.dailyCap !== undefined) put("daily_cap", patch.dailyCap);
    if (patch.prevSecretRef !== undefined) put("prev_secret_ref", patch.prevSecretRef);
    if (patch.prevSecretExpiresAt !== undefined) put("prev_secret_expires_at", patch.prevSecretExpiresAt);
    if (sets.length === 0) return this.getHook(id);
    put("updated_at", now.toISOString());
    values.push(id);
    const res = this.db.prepare(`UPDATE hooks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return res.changes > 0 ? this.getHook(id) : null;
  }

  /** Sets verified_at once. Returns true when this call set it. */
  markVerified(id: string, now: Date = new Date()): boolean {
    const res = this.db.prepare("UPDATE hooks SET verified_at = ? WHERE id = ? AND verified_at IS NULL")
      .run(now.toISOString(), id);
    return res.changes > 0;
  }

  /** Deletes the hook. Its delivery rows stay until retention prunes them. */
  deleteHook(id: string): boolean {
    return this.db.prepare("DELETE FROM hooks WHERE id = ?").run(id).changes > 0;
  }

  // ── deliveries ─────────────────────────────────────────────────────────

  /**
   * The replay check: insert the dedupe row before any action. Returns
   * `claimed: false` when the same (hook, dedupe key) was already seen. A row
   * left `throttled` by a post-auth limit can be claimed again by a retry.
   */
  claimDelivery(input: WebhookClaimInput): { claimed: boolean; id: number } {
    const res = this.db.prepare(`
      INSERT INTO deliveries (hook_id, dedupe_key, provider_id, event, status, body_bytes, remote_ip, received_at)
      VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?)
      ON CONFLICT(hook_id, dedupe_key) DO UPDATE SET
        status = 'accepted', note = NULL, provider_id = excluded.provider_id, event = excluded.event,
        body_bytes = excluded.body_bytes, remote_ip = excluded.remote_ip, received_at = excluded.received_at
      WHERE deliveries.status = 'throttled'
    `).run(
      input.hookId, input.dedupeKey, input.providerId ?? null, input.event ?? null,
      input.bodyBytes ?? null, input.remoteIp ?? null, input.receivedAt,
    );
    const row = this.db.prepare("SELECT id FROM deliveries WHERE hook_id = ? AND dedupe_key = ?")
      .get(input.hookId, input.dedupeKey) as { id: number };
    return { claimed: res.changes > 0, id: row.id };
  }

  updateDelivery(id: number, patch: { status?: WebhookDeliveryStatus; taskId?: string | null; note?: string | null; event?: string | null }): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); values.push(patch.status); }
    if (patch.taskId !== undefined) { sets.push("task_id = ?"); values.push(patch.taskId); }
    if (patch.note !== undefined) { sets.push("note = ?"); values.push(patch.note === null ? null : patch.note.slice(0, 200)); }
    if (patch.event !== undefined) { sets.push("event = ?"); values.push(patch.event); }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  getDelivery(id: number): WebhookDelivery | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : null;
  }

  recentDeliveries(opts: { hookId?: string; limit?: number } = {}): WebhookDelivery[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
    const rows = opts.hookId
      ? this.db.prepare("SELECT * FROM deliveries WHERE hook_id = ? ORDER BY id DESC LIMIT ?").all(opts.hookId, limit)
      : this.db.prepare("SELECT * FROM deliveries ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as DeliveryRow[]).map(deliveryFromRow);
  }

  /** Deliveries that used the daily budget (accepted, done, failed) since `since`. */
  countActionsSince(hookId: string, since: Date): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM deliveries
      WHERE hook_id = ? AND received_at >= ? AND status IN ('accepted', 'done', 'failed')
    `).get(hookId, since.toISOString()) as { n: number };
    return row.n;
  }

  /** All deliveries since `since`, by status. */
  countByStatusSince(since: Date): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) AS n FROM deliveries WHERE received_at >= ? GROUP BY status")
      .all(since.toISOString()) as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  lastDeliveryAt(hookId: string): string | null {
    const row = this.db.prepare("SELECT MAX(received_at) AS t FROM deliveries WHERE hook_id = ?").get(hookId) as { t: string | null };
    return row.t;
  }

  /** `/webhook forget`: drop one dedupe row so a provider redelivery of that body is accepted again. */
  forgetDelivery(id: number): boolean {
    return this.db.prepare("DELETE FROM deliveries WHERE id = ?").run(id).changes > 0;
  }

  /** Drops rows older than the retention window. Returns the count removed. */
  pruneDeliveries(retentionDays: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM deliveries WHERE received_at < ?").run(cutoff).changes;
  }

  /**
   * Startup reconciliation: a delivery still `accepted` was interrupted by a
   * restart before its action finished. At-most-once: mark it failed, never re-run.
   */
  failInterruptedDeliveries(): WebhookDelivery[] {
    const rows = this.db.prepare("SELECT * FROM deliveries WHERE status = 'accepted'").all() as DeliveryRow[];
    if (rows.length > 0) {
      this.db.prepare("UPDATE deliveries SET status = 'failed', note = 'interrupted by a restart' WHERE status = 'accepted'").run();
    }
    return rows.map((r) => ({ ...deliveryFromRow(r), status: "failed" as const, note: "interrupted by a restart" }));
  }
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function hookFromRow(row: HookRow): WebhookDefinition {
  return {
    id: row.id,
    name: row.name,
    source: row.source as WebhookSource,
    enabled: row.enabled === 1,
    secretRef: row.secret_ref,
    prevSecretRef: row.prev_secret_ref,
    prevSecretExpiresAt: row.prev_secret_expires_at,
    events: parseList(row.events),
    action: row.action === "task" ? "task" : "notify",
    toolProfile: (["summarize", "investigate", "full"].includes(row.tool_profile) ? row.tool_profile : "summarize") as WebhookToolProfile,
    allowFull: row.allow_full === 1,
    instructions: row.instructions,
    fields: parseList(row.fields),
    includeRaw: row.include_raw === 1,
    ipAllowlist: parseList(row.ip_allowlist),
    ratePerMin: row.rate_per_min,
    dailyCap: row.daily_cap,
    channel: row.channel,
    chatId: row.chat_id,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryFromRow(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    hookId: row.hook_id,
    dedupeKey: row.dedupe_key,
    providerId: row.provider_id,
    event: row.event,
    status: row.status as WebhookDeliveryStatus,
    taskId: row.task_id,
    note: row.note,
    bodyBytes: row.body_bytes,
    remoteIp: row.remote_ip,
    receivedAt: row.received_at,
  };
}
