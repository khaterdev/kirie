/**
 * `~/.kirie/accounts.db` (PLAN C.1): imported Claude accounts, per-model
 * benches (item 2) and the active account id. WAL, file mode 0600.
 *
 * The store holds a path, a masked label and an account uuid per account.
 * Never a token. History is in the shared AuditTrail, not here.
 */

import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ClaudeAccountKind } from "./account-env.js";

export const ACCOUNTS_DB_FILE = "accounts.db";

export type ClaudeAccountStatus = "ok" | "limited" | "auth_error";

/** Account ids: lower-case slug. */
export const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ClaudeAccount {
  id: string;
  kind: ClaudeAccountKind;
  /** Exact absolute path, no trailing slash; null for the default account */
  configDir: string | null;
  accountUuid: string | null;
  /** Masked email */
  label: string | null;
  /** Display string from accountInfo ("Claude Max"), or the organization type */
  subscription: string | null;
  enabled: boolean;
  /** Lower first */
  priority: number;
  status: ClaudeAccountStatus;
  /** Epoch ms */
  limitedUntil: number | null;
  limitType: string | null;
  /** Scrubbed, at most 200 chars */
  limitMessage: string | null;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  /** Scrubbed, at most 200 chars */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AccountModelLimit {
  /** "" = the ambient account (no account imported) */
  accountId: string;
  model: string;
  limitedUntil: number;
  reason: string | null;
}

interface AccountRow {
  id: string;
  kind: string;
  config_dir: string | null;
  account_uuid: string | null;
  label: string | null;
  subscription: string | null;
  enabled: number;
  priority: number;
  status: string;
  limited_until: number | null;
  limit_type: string | null;
  limit_message: string | null;
  last_used_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMN_BY_FIELD: Record<string, string> = {
  kind: "kind",
  configDir: "config_dir",
  accountUuid: "account_uuid",
  label: "label",
  subscription: "subscription",
  enabled: "enabled",
  priority: "priority",
  status: "status",
  limitedUntil: "limited_until",
  limitType: "limit_type",
  limitMessage: "limit_message",
  lastUsedAt: "last_used_at",
  lastErrorAt: "last_error_at",
  lastError: "last_error",
};

export type ClaudeAccountPatch = Partial<Omit<ClaudeAccount, "id" | "createdAt" | "updatedAt">>;

function rowToAccount(row: AccountRow): ClaudeAccount {
  return {
    id: row.id,
    kind: row.kind === "default" ? "default" : "config_dir",
    configDir: row.config_dir,
    accountUuid: row.account_uuid,
    label: row.label,
    subscription: row.subscription,
    enabled: row.enabled === 1,
    priority: row.priority,
    status: row.status === "limited" || row.status === "auth_error" ? row.status : "ok",
    limitedUntil: row.limited_until,
    limitType: row.limit_type,
    limitMessage: row.limit_message,
    lastUsedAt: row.last_used_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toColumnValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ?? null;
}

/**
 * After close() every read returns empty and every write is a no-op, so a turn
 * still finishing during shutdown never throws from here.
 */
export class AccountStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  readonly path: string;

  constructor(dbPath: string = join(homedir(), ".kirie", ACCOUNTS_DB_FILE), opts: { now?: () => number } = {}) {
    this.path = dbPath;
    this.now = opts.now ?? Date.now;
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
      CREATE TABLE IF NOT EXISTS accounts (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        config_dir    TEXT,
        account_uuid  TEXT,
        label         TEXT,
        subscription  TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        priority      INTEGER NOT NULL DEFAULT 100,
        status        TEXT NOT NULL DEFAULT 'ok',
        limited_until INTEGER,
        limit_type    TEXT,
        limit_message TEXT,
        last_used_at  INTEGER,
        last_error_at INTEGER,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_uuid ON accounts(account_uuid) WHERE account_uuid IS NOT NULL;

      CREATE TABLE IF NOT EXISTS account_model_limits (
        account_id    TEXT NOT NULL,
        model         TEXT NOT NULL,
        limited_until INTEGER NOT NULL,
        reason        TEXT,
        PRIMARY KEY (account_id, model)
      );

      CREATE TABLE IF NOT EXISTS account_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  list(): ClaudeAccount[] {
    if (!this.db.open) return [];
    const rows = this.db.prepare("SELECT * FROM accounts ORDER BY priority ASC, id ASC").all() as AccountRow[];
    return rows.map(rowToAccount);
  }

  get(id: string): ClaudeAccount | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
    return row ? rowToAccount(row) : null;
  }

  findByUuid(uuid: string): ClaudeAccount | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT * FROM accounts WHERE account_uuid = ?").get(uuid) as AccountRow | undefined;
    return row ? rowToAccount(row) : null;
  }

  count(): number {
    if (!this.db.open) return 0;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  }

  /** Highest priority number in use, or 0. */
  maxPriority(): number {
    if (!this.db.open) return 0;
    const row = this.db.prepare("SELECT MAX(priority) AS p FROM accounts").get() as { p: number | null };
    return row.p ?? 0;
  }

  insert(account: Omit<ClaudeAccount, "createdAt" | "updatedAt">): ClaudeAccount {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, kind, config_dir, account_uuid, label, subscription, enabled, priority, status,
           limited_until, limit_type, limit_message, last_used_at, last_error_at, last_error, created_at, updated_at)
         VALUES (@id, @kind, @config_dir, @account_uuid, @label, @subscription, @enabled, @priority, @status,
           @limited_until, @limit_type, @limit_message, @last_used_at, @last_error_at, @last_error, @ts, @ts)`,
      )
      .run({
        id: account.id,
        kind: account.kind,
        config_dir: account.configDir,
        account_uuid: account.accountUuid,
        label: account.label,
        subscription: account.subscription,
        enabled: account.enabled ? 1 : 0,
        priority: account.priority,
        status: account.status,
        limited_until: account.limitedUntil,
        limit_type: account.limitType,
        limit_message: account.limitMessage,
        last_used_at: account.lastUsedAt,
        last_error_at: account.lastErrorAt,
        last_error: account.lastError,
        ts,
      });
    return this.get(account.id)!;
  }

  update(id: string, patch: ClaudeAccountPatch): ClaudeAccount | null {
    if (!this.db.open) return null;
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = COLUMN_BY_FIELD[field];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(toColumnValue(value));
    }
    sets.push("updated_at = ?");
    values.push(this.now());
    values.push(id);
    this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  remove(id: string): boolean {
    if (!this.db.open) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM account_model_limits WHERE account_id = ?").run(id);
      return this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id).changes > 0;
    });
    return tx();
  }

  getActiveId(): string | null {
    if (!this.db.open) return null;
    const row = this.db.prepare("SELECT value FROM account_state WHERE key = 'active_account_id'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setActiveId(id: string | null): void {
    if (!this.db.open) return;
    if (id === null) {
      this.db.prepare("DELETE FROM account_state WHERE key = 'active_account_id'").run();
      return;
    }
    this.db
      .prepare(
        `INSERT INTO account_state (key, value) VALUES ('active_account_id', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(id);
  }

  // ── Per-model benches (item 2) ────────────────────────────────────────────

  modelLimits(): AccountModelLimit[] {
    if (!this.db.open) return [];
    const rows = this.db
      .prepare("SELECT account_id, model, limited_until, reason FROM account_model_limits ORDER BY limited_until ASC")
      .all() as Array<{ account_id: string; model: string; limited_until: number; reason: string | null }>;
    return rows.map((r) => ({ accountId: r.account_id, model: r.model, limitedUntil: r.limited_until, reason: r.reason }));
  }

  getModelLimit(accountId: string, model: string): AccountModelLimit | null {
    if (!this.db.open) return null;
    const row = this.db
      .prepare("SELECT account_id, model, limited_until, reason FROM account_model_limits WHERE account_id = ? AND model = ?")
      .get(accountId, model) as { account_id: string; model: string; limited_until: number; reason: string | null } | undefined;
    return row ? { accountId: row.account_id, model: row.model, limitedUntil: row.limited_until, reason: row.reason } : null;
  }

  setModelLimit(accountId: string, model: string, limitedUntil: number, reason: string | null): void {
    if (!this.db.open) return;
    this.db
      .prepare(
        `INSERT INTO account_model_limits (account_id, model, limited_until, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, model) DO UPDATE SET
           limited_until = MAX(account_model_limits.limited_until, excluded.limited_until),
           reason = excluded.reason`,
      )
      .run(accountId, model, limitedUntil, reason);
  }

  clearModelLimits(accountId?: string): number {
    if (!this.db.open) return 0;
    const info = accountId === undefined
      ? this.db.prepare("DELETE FROM account_model_limits").run()
      : this.db.prepare("DELETE FROM account_model_limits WHERE account_id = ?").run(accountId);
    return info.changes;
  }

  /** Drop benches whose time has passed. */
  pruneModelLimits(now: number): number {
    if (!this.db.open) return 0;
    return this.db.prepare("DELETE FROM account_model_limits WHERE limited_until <= ?").run(now).changes;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
