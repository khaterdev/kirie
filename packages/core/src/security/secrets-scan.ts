/**
 * SecretsAuditor: the one-time audit and owner-confirmed migration of
 * plaintext secrets already stored by Kirie (PLAN C.12, item 12 part 3).
 *
 * `scan` opens every store read-only and runs the scrubber's `detect()`.
 * A finding records where a secret is (store, row or file line, character or
 * byte span), the rule that matched and a keyed fingerprint. It never holds
 * the value, and nothing built from a finding (report file, chat summary,
 * audit record, MCP result) can contain one: locations are built from row
 * ids and column names, and any identifier shown (a memory key, a schedule
 * name) is masked with the same findings first.
 *
 * The fingerprint is an HMAC-SHA256 under a random key that lives only in
 * this process's memory for the latest scan. Equal secrets share a
 * fingerprint within one scan; the value cannot be recovered or confirmed
 * from the report. `redact` re-reads each location and only touches it when
 * the HMAC of what is there now still equals the fingerprint, so a row or
 * log line that changed since the scan is skipped, never damaged.
 *
 * Nothing stored is changed except by `redact`, which the owner command
 * calls only after an explicit confirmation (DECISIONS 12).
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync,
  readFileSync, readSync, statSync, writeFileSync, writeSync, chmodSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import Database from "better-sqlite3";
import type { AuditTrail } from "./audit-trail.js";
import { redactionMarker, type ScrubFinding, type SecretScrubber } from "./secret-scrubber.js";
import { createModuleLogger } from "../logging/logger.js";

const log = createModuleLogger("secrets-scan");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SecretsScanMode = "quick" | "full";

/** Where a finding lives. Databases and Markdown files are in both modes; logs only in `full`. */
export type SecretsStoreName =
  | "memory" | "chat-history" | "background-tasks" | "heartbeat-logs" | "markdown" | "logs" | "config";

/** Machine location of a database finding (character span inside one cell). */
export interface SecretsRowTarget {
  kind: "row";
  file: string;
  table: string;
  idColumn: string;
  id: string | number;
  column: string;
  start: number;
  end: number;
}

/** Machine location of a file finding (byte span inside one line). */
export interface SecretsFileTarget {
  kind: "file";
  file: string;
  line: number;
  byteOffset: number;
  byteLength: number;
}

export interface SecretsScanFinding {
  /** 1-based, unique within one scan */
  id: number;
  store: SecretsStoreName;
  /** Human-readable place. Never contains a value */
  location: string;
  /** Scrubber rule name */
  rule: string;
  /** For `auth-header`: which form fired (EXPERIMENTS E9) */
  variant?: "authorization" | "bare-bearer";
  /** First 16 hex chars of HMAC-SHA256(value) under the per-scan key */
  fingerprint: string;
  /** Whether `/secrets redact` can change it */
  redactable: boolean;
  /** Why not, when not redactable */
  note?: string;
  /** Memory content: the value can be moved into the credential store */
  vaultable: boolean;
  /** Memory row tagged `credential`: vault is the suggested way */
  suggestVault?: boolean;
  target: SecretsRowTarget | SecretsFileTarget | { kind: "none"; file: string; line?: number };
}

export interface SecretsStoreStatus {
  store: SecretsStoreName;
  /** File or directory, relative to the data dir when inside it */
  path: string;
  status: "scanned" | "missing" | "error";
  /** Rows or lines read */
  items: number;
  /** Error code or short reason; never file contents */
  error?: string;
}

export interface SecretsScanCounts {
  total: number;
  redactable: number;
  byStore: Record<string, number>;
  /** Keyed by rule, `auth-header` split into `auth-header (Authorization)` / `auth-header (bare Bearer)` */
  byRule: Record<string, number>;
}

export interface SecretsScanReport {
  version: 1;
  scanId: string;
  mode: SecretsScanMode;
  startedAt: string;
  finishedAt: string;
  stores: SecretsStoreStatus[];
  counts: SecretsScanCounts;
  findings: SecretsScanFinding[];
  /** full mode: places that may hold copies Kirie cannot clean. Listed, never opened */
  notCleanable: string[];
  /** Plain advice per provider rule that fired. Rotation is the owner's action */
  rotationAdvice: string[];
}

/** What the agent-facing tool returns: counts only. */
export interface SecretsScanSummary {
  mode: SecretsScanMode;
  counts: SecretsScanCounts;
  stores: Array<Pick<SecretsStoreStatus, "store" | "status" | "items">>;
}

export interface SecretsRedactionPlan {
  scanId: string;
  vault: boolean;
  findings: SecretsScanFinding[];
  skipped: Array<{ id: number; reason: string }>;
}

export interface SecretsRedactionResult {
  scanId: string;
  redacted: number[];
  vaulted: Array<{ id: number; key: string }>;
  skipped: Array<{ id: number; reason: string }>;
  /** Per database file: what the SQLite hygiene steps did */
  databases: Array<{
    file: string;
    rowsChanged: number;
    ftsRebuilt: string[];
    vectorsCleared: number;
    reembedded: number;
    checkpoint: "complete" | "partial" | "failed";
    vacuum: "ok" | "failed" | "skipped";
  }>;
  /** Per text file: same-length overwrite, size and inode kept */
  files: Array<{ file: string; masked: number; sizeKept: boolean; inodeKept: boolean }>;
  rotationAdvice: string[];
}

/** The credential-store surface used by vault mode. */
export interface SecretsVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface SecretsAuditorOptions {
  /** ~/.kirie */
  dataDir: string;
  /** Home dir, for the `full` list of places Kirie cannot clean (only names are listed) */
  homeDir?: string;
  /** Defaults to <dataDir>/heartbeat-logs.db (proactive.heartbeatLogging.dbPath) */
  heartbeatLogDbPath?: string;
  /** Defaults to <dataDir>/config.yaml */
  configPath?: string;
  /** Defaults to <dataDir>/vectors.db */
  vectorDbPath?: string;
  /** Defaults to <dataDir>/reports */
  reportsDir?: string;
  scrubber: Pick<SecretScrubber, "detect">;
  /** Vault mode: the encrypted credential store */
  vault?: SecretsVault;
  /** Re-embed a redacted memory row (MemoryManager.store). Without it, stale vectors are deleted */
  reembedMemory?: (key: string, content: string, tags: string[]) => Promise<void>;
  audit?: Pick<AuditTrail, "record">;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

interface DbSource {
  store: SecretsStoreName;
  file: string;
  table: string;
  idColumn: string;
  columns: readonly string[];
  /** Extra columns read for the location label (never shown raw) */
  labelColumns?: readonly string[];
}

/** Provider-format rules whose findings mean a real key has sat on disk. */
const ROTATION_ADVICE: Readonly<Record<string, string>> = {
  "telegram-bot-token": "Telegram bot token: in @BotFather send /revoke for the bot, store the new token with `kirie credentials set <key> <new token>` under the key your config.yaml $credential: reference names (telegram.bot_token in config.example.yaml), then restart Kirie.",
  "linear-key": "Linear API key: revoke it in Linear (Settings, Security & access, API keys) and create a new one.",
  "github-token": "GitHub token: revoke it at github.com/settings/tokens and create a new one with the narrowest scopes.",
  "google-api-key": "Google API key or OAuth secret: rotate it in Google Cloud Console (APIs & Services, Credentials).",
  "anthropic-key": "Anthropic API key: revoke it in the Anthropic Console (API keys).",
  "openai-key": "OpenAI API key: revoke it in the OpenAI dashboard (API keys).",
  "slack-token": "Slack token or webhook: regenerate it in the Slack app settings.",
  "discord-token": "Discord token or webhook: reset it in the Discord developer portal or channel settings.",
  "stripe-key": "Stripe key: roll it in the Stripe dashboard (Developers, API keys).",
  "aws-access-key-id": "AWS access key: deactivate and delete it in IAM, then create a new one.",
  "gitlab-token": "GitLab token: revoke it in GitLab (Preferences, Access tokens).",
  "sentry-token": "Sentry token: revoke it in Sentry (Settings, Auth tokens).",
  "twilio-account-sid": "Twilio: an account SID is an identifier; if an auth token was stored with it, rotate the auth token in the Twilio console.",
  "vendor-prefixed": "Vendor API key (npm, Hugging Face, SendGrid, Groq, ...): revoke it with that vendor.",
  "private-key": "Private key: replace the key pair and remove the old public key wherever it is trusted.",
  "jwt": "JWT: if it is a long-lived token, revoke the session or rotate the signing secret that issued it.",
  "known-secret": "A value Kirie holds as a credential: rotate it with its provider, then `kirie credentials set <key> <new value>`.",
};

export const SECRETS_ROTATION_PREAMBLE =
  "These secrets have been on disk in plaintext, and probably also in SDK chat transcripts Kirie cannot clean. " +
  "Redaction only stops further spread; rotating them is the real fix, and only you can do it:";

/** kirie-tools env key: "1" when the daemon's secrets feature is set up; without it `secrets_scan` does not exist. */
export const SECRETS_TOOL_ENV = "KIRIE_SECRETS_SCAN_TOOL";
/** kirie-tools env key: the heartbeat log DB when `proactive.heartbeatLogging.dbPath` moves it. */
export const SECRETS_HEARTBEAT_DB_ENV = "KIRIE_HEARTBEAT_LOG_DB";

export const SECRETS_STALE_PLAN_MESSAGE = "a newer scan replaced the one this redaction was planned from";

const AUTH_LOOKBEHIND = 120;
const READ_CHUNK = 1 << 20;
const MAX_LINE_BYTES = 8 << 20;
const BUSY_TIMEOUT_MS = 5_000;
/** VACUUM blocks the daemon and needs about the file's size again in free disk: skip it above this. */
const VACUUM_MAX_BYTES = 256 << 20;
/** An idle database (no -wal) is read into memory so the scan creates no -wal/-shm; above this it is not scanned. */
const IDLE_SCAN_MAX_BYTES = 1 << 30;
const VAULT_KEY_RE = /[^a-z0-9._-]+/g;

/** `rule` plus the E9 split for `auth-header`, as shown in counts. */
export function secretsRuleLabel(f: Pick<SecretsScanFinding, "rule" | "variant">): string {
  if (f.rule !== "auth-header" || !f.variant) return f.rule;
  return f.variant === "authorization" ? "auth-header (Authorization)" : "auth-header (bare Bearer)";
}

/** Rotation advice lines for the rules present in `findings` (fixed text, no values). */
export function secretsRotationAdvice(findings: ReadonlyArray<Pick<SecretsScanFinding, "rule">>): string[] {
  const rules = [...new Set(findings.map((f) => f.rule))].filter((r) => ROTATION_ADVICE[r]).sort();
  return rules.map((r) => ROTATION_ADVICE[r]!);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace each finding's span with its marker (used for labels; never on stored data here). */
function maskSpans(text: string, findings: readonly ScrubFinding[]): string {
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  let out = text;
  for (const f of sorted) out = out.slice(0, f.start) + redactionMarker(f.rule) + out.slice(f.end);
  return out;
}

function sqlName(column: string): string {
  return column === "rowid" ? "rowid" : `"${column}"`;
}

/**
 * Open a store for scanning without changing any file. With a writer around (a -wal or
 * -shm exists) a plain read-only handle touches nothing. Without one, SQLite would create
 * -wal and -shm even read-only, so the checkpointed file is read into memory instead, with
 * the header switched from WAL to rollback mode (the in-memory copy has no WAL).
 */
function openForScan(file: string): Database.Database {
  if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) {
    return new Database(file, { readonly: true, fileMustExist: true });
  }
  if (statSync(file).size > IDLE_SCAN_MAX_BYTES) {
    throw Object.assign(new Error("idle database too large to read without touching it"), { code: "IDLE_DB_TOO_LARGE" });
  }
  const image = readFileSync(file);
  if (image.length >= 20 && image[18] === 2 && image[19] === 2) {
    image[18] = 1;
    image[19] = 1;
  }
  return new Database(image, { readonly: true });
}

function hmac(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, 16);
}

function authVariant(text: string, start: number): "authorization" | "bare-bearer" {
  const before = text.slice(Math.max(0, start - AUTH_LOOKBEHIND), start).toLowerCase();
  return before.includes("authorization") ? "authorization" : "bare-bearer";
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  if (typeof e?.code === "string") return e.code;
  return typeof e?.name === "string" ? e.name : "error";
}

/** Byte-exact mask: the marker padded with `*`, or only `*` when the marker is longer. */
export function secretsSameLengthMask(rule: string, byteLength: number): Buffer {
  const marker = Buffer.from(redactionMarker(rule), "utf8");
  if (marker.length <= byteLength) {
    return Buffer.concat([marker, Buffer.alloc(byteLength - marker.length, "*")]);
  }
  return Buffer.alloc(byteLength, "*");
}

/**
 * Calls `fn` for every `\n`-terminated line of a file with its byte offset, reading in
 * chunks so large logs are never loaded whole. Lines longer than MAX_LINE_BYTES are split.
 */
function forEachLine(file: string, fn: (line: Buffer, lineNo: number, offset: number) => void): number {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let carry: Buffer = Buffer.alloc(0);
    let carryOffset = 0;
    let position = 0;
    let lineNo = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, position);
      if (n === 0) break;
      position += n;
      // Always a copy, so `carry` stays valid when `buf` is reused.
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const dataOffset = carry.length ? carryOffset : position - n;
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) break;
        lineNo++;
        fn(data.subarray(start, nl), lineNo, dataOffset + start);
        start = nl + 1;
      }
      carry = data.subarray(start);
      carryOffset = dataOffset + start;
      if (carry.length > MAX_LINE_BYTES) {
        lineNo++;
        fn(carry, lineNo, carryOffset);
        carryOffset += carry.length;
        carry = Buffer.alloc(0);
      }
    }
    if (carry.length) {
      lineNo++;
      fn(carry, lineNo, carryOffset);
    }
    return lineNo;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// SecretsAuditor
// ---------------------------------------------------------------------------

interface ActiveScan {
  report: SecretsScanReport;
  key: Buffer;
  reportPath: string | null;
}

export class SecretsAuditor {
  private readonly opts: SecretsAuditorOptions;
  private readonly reportsDir: string;
  private active: ActiveScan | null = null;

  constructor(opts: SecretsAuditorOptions) {
    this.opts = opts;
    this.reportsDir = opts.reportsDir ?? join(opts.dataDir, "reports");
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private rel(path: string): string {
    const r = relative(this.opts.dataDir, path);
    return r && !r.startsWith("..") ? r : path;
  }

  private dbSources(): DbSource[] {
    const d = this.opts.dataDir;
    const memory = join(d, "memory.db");
    return [
      { store: "memory", file: memory, table: "memories", idColumn: "id", columns: ["key", "content", "tags"], labelColumns: ["key"] },
      // Name-keyed tables are targeted by rowid, so a report never stores a name raw.
      { store: "memory", file: memory, table: "schedules", idColumn: "rowid", columns: ["name", "message"] },
      { store: "memory", file: memory, table: "webhooks", idColumn: "rowid", columns: ["name", "path", "handler_message"] },
      { store: "chat-history", file: join(d, "chat-history.db"), table: "messages", idColumn: "id", columns: ["content"], labelColumns: ["role", "created_at"] },
      { store: "background-tasks", file: join(d, "background-tasks.db"), table: "background_tasks", idColumn: "id", columns: ["description", "prompt", "result", "error"], labelColumns: ["status"] },
      { store: "heartbeat-logs", file: this.opts.heartbeatLogDbPath ?? join(d, "heartbeat-logs.db"), table: "heartbeat_logs", idColumn: "id", columns: ["title", "content", "metadata"] },
    ];
  }

  private markdownFiles(): string[] {
    return ["MEMORY.md", "SOUL.md", "TOOLS.md", "HEARTBEAT.md", "USER.md"].map((f) => join(this.opts.dataDir, f));
  }

  private logFiles(): string[] {
    const dir = join(this.opts.dataDir, "logs");
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => /\.(log|jsonl)(\.\d+)?$/.test(f))
        .sort()
        .map((f) => join(dir, f))
        .filter((f) => statSync(f).isFile());
    } catch {
      return [];
    }
  }

  private notCleanable(): string[] {
    const out: string[] = [];
    const home = this.opts.homeDir;
    if (home && existsSync(home)) {
      try {
        for (const name of readdirSync(home).sort()) {
          if (!/^\.claude/.test(name)) continue;
          const projects = join(home, name, "projects");
          if (existsSync(projects)) out.push(`${projects} (SDK chat transcripts)`);
        }
      } catch {
        // An unreadable home dir only shortens the list.
      }
    }
    const backups = join(this.opts.dataDir, "backups");
    if (existsSync(backups)) out.push(`${backups} (backups)`);
    return out;
  }

  // -- Scan -------------------------------------------------------------------

  /**
   * Read-only audit. Opens every database with `readonly: true` and every file with `r`.
   * With `writeReport` (the owner command) the report goes to
   * `<dataDir>/reports/secrets-scan-<ts>.json` (0600) and becomes the redact target.
   */
  scan(mode: SecretsScanMode, opts?: { writeReport?: boolean; actor?: string }): { report: SecretsScanReport; reportPath: string | null } {
    const key = randomBytes(32);
    const startedAt = this.now().toISOString();
    const findings: SecretsScanFinding[] = [];
    const stores: SecretsStoreStatus[] = [];
    const add = (f: Omit<SecretsScanFinding, "id">): void => {
      findings.push({ id: findings.length + 1, ...f });
    };

    for (const src of this.dbSources()) stores.push(this.scanDb(src, key, add));
    for (const file of this.markdownFiles()) {
      if (existsSync(file)) stores.push(this.scanTextFile("markdown", file, key, add));
    }
    if (mode === "full") {
      for (const file of this.logFiles()) stores.push(this.scanTextFile("logs", file, key, add));
    }
    stores.push(this.scanConfig(key, add));

    const report: SecretsScanReport = {
      version: 1,
      scanId: randomUUID(),
      mode,
      startedAt,
      finishedAt: this.now().toISOString(),
      stores,
      counts: countFindings(findings),
      findings,
      notCleanable: mode === "full" ? this.notCleanable() : [],
      rotationAdvice: secretsRotationAdvice(findings),
    };

    let reportPath: string | null = null;
    if (opts?.writeReport) {
      reportPath = this.writeReport(report);
      // The auditor's own copy: redact updates it, never the object handed to the caller.
      this.active = { report: structuredClone(report), key, reportPath };
      this.opts.audit?.record({
        feature: "secrets",
        action: "scan",
        actor: opts.actor ?? "system",
        detail: { scanId: report.scanId, mode, total: report.counts.total, byStore: report.counts.byStore, byRule: report.counts.byRule },
      });
    }
    log.info({ mode, total: report.counts.total, byStore: report.counts.byStore }, "secrets scan finished");
    return { report, reportPath };
  }

  /** Counts only (for the agent-facing tool). Writes nothing and keeps no state. */
  summarize(mode: SecretsScanMode = "quick"): SecretsScanSummary {
    const { report } = this.scan(mode);
    return {
      mode,
      counts: report.counts,
      stores: report.stores.map((s) => ({ store: s.store, status: s.status, items: s.items })),
    };
  }

  private scanDb(src: DbSource, key: Buffer, add: (f: Omit<SecretsScanFinding, "id">) => void): SecretsStoreStatus {
    const status: SecretsStoreStatus = { store: src.store, path: `${this.rel(src.file)} ${src.table}`, status: "scanned", items: 0 };
    if (!existsSync(src.file)) return { ...status, status: "missing" };
    let db: Database.Database | null = null;
    try {
      db = openForScan(src.file);
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(src.table);
      if (!exists) return { ...status, status: "missing" };
      const present = new Set((db.prepare(`PRAGMA table_info("${src.table}")`).all() as Array<{ name: string }>).map((c) => c.name));
      const cols = src.columns.filter((c) => present.has(c));
      if ((src.idColumn !== "rowid" && !present.has(src.idColumn)) || cols.length === 0) return { ...status, status: "missing" };
      const labels = (src.labelColumns ?? []).filter((c) => present.has(c) && !cols.includes(c));
      const tags = src.table === "memories" && present.has("tags") && !cols.includes("tags") ? ["tags"] : [];
      const select = [src.idColumn, ...cols, ...labels, ...tags].map(sqlName).join(", ");
      const stmt = db.prepare(`SELECT ${select} FROM "${src.table}"`);
      for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
        status.items++;
        const perColumn: Array<{ column: string; text: string; found: ScrubFinding[] }> = [];
        for (const column of cols) {
          const value = row[column];
          if (typeof value !== "string" || value.length === 0) continue;
          const found = this.opts.scrubber.detect(value, { fingerprintKey: key });
          if (found.length) perColumn.push({ column, text: value, found });
        }
        if (perColumn.length === 0) continue;
        const id = row[src.idColumn] as string | number;
        const label = this.rowLabel(src, row, key);
        for (const { column, text, found } of perColumn) {
          for (const f of found) {
            const { redactable, note } = rowRedactable(src, column, row);
            const memContent = src.table === "memories" && column === "content";
            add({
              store: src.store,
              location: `${label} (${column})`,
              rule: f.rule,
              ...(f.rule === "auth-header" ? { variant: authVariant(text, f.start) } : {}),
              fingerprint: f.fingerprint,
              redactable,
              ...(note ? { note } : {}),
              vaultable: memContent,
              ...(memContent && hasCredentialTag(row.tags) ? { suggestVault: true } : {}),
              target: { kind: "row", file: src.file, table: src.table, idColumn: src.idColumn, id, column, start: f.start, end: f.end },
            });
          }
        }
      }
      return status;
    } catch (err) {
      return { ...status, status: "error", error: errorCode(err) };
    } finally {
      db?.close();
    }
  }

  /** A location label built from ids and column names; any identifier text is masked first. */
  private rowLabel(src: DbSource, row: Record<string, unknown>, key: Buffer): string {
    const file = basename(src.file);
    const masked = (v: unknown): string => {
      const s = String(v ?? "");
      return maskSpans(s, this.opts.scrubber.detect(s, { fingerprintKey: key })).slice(0, 80);
    };
    const id = row[src.idColumn];
    switch (src.table) {
      case "memories":
        return `${file} memories id=${String(id)} key="${masked(row.key)}"`;
      case "messages":
        return `${file} messages id=${String(id)} ${masked(row.role)} ${masked(row.created_at)}`.trimEnd();
      case "background_tasks":
        return `${file} task ${masked(id).slice(0, 8)}`;
      case "schedules":
      case "webhooks":
        return `${file} ${src.table} rowid=${String(id)} name="${masked(row.name)}"`;
      default:
        return `${file} ${src.table} id=${masked(id)}`;
    }
  }

  private scanTextFile(store: SecretsStoreName, file: string, key: Buffer, add: (f: Omit<SecretsScanFinding, "id">) => void): SecretsStoreStatus {
    const status: SecretsStoreStatus = { store, path: this.rel(file), status: "scanned", items: 0 };
    try {
      status.items = forEachLine(file, (buf, lineNo, offset) => {
        const text = buf.toString("utf8");
        const found = this.opts.scrubber.detect(text, { fingerprintKey: key });
        if (found.length === 0) return;
        // Byte offsets are exact only when the line is valid UTF-8 (decoding is lossless).
        const lossless = Buffer.byteLength(text, "utf8") === buf.length;
        for (const f of found) {
          const byteOffset = offset + Buffer.byteLength(text.slice(0, f.start), "utf8");
          const byteLength = Buffer.byteLength(text.slice(f.start, f.end), "utf8");
          add({
            store,
            location: `${this.rel(file)}:${lineNo}`,
            rule: f.rule,
            ...(f.rule === "auth-header" ? { variant: authVariant(text, f.start) } : {}),
            fingerprint: f.fingerprint,
            redactable: lossless,
            ...(lossless ? {} : { note: "line is not valid UTF-8; edit it by hand" }),
            vaultable: false,
            target: { kind: "file", file, line: lineNo, byteOffset, byteLength },
          });
        }
      });
      return status;
    } catch (err) {
      return { ...status, status: "error", error: errorCode(err) };
    }
  }

  private scanConfig(key: Buffer, add: (f: Omit<SecretsScanFinding, "id">) => void): SecretsStoreStatus {
    const file = this.opts.configPath ?? join(this.opts.dataDir, "config.yaml");
    const status: SecretsStoreStatus = { store: "config", path: this.rel(file), status: "scanned", items: 0 };
    if (!existsSync(file)) return { ...status, status: "missing" };
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      status.items = lines.length;
      lines.forEach((text, i) => {
        for (const f of this.opts.scrubber.detect(text, { fingerprintKey: key })) {
          add({
            store: "config",
            location: `${this.rel(file)}:${i + 1}`,
            rule: f.rule,
            ...(f.rule === "auth-header" ? { variant: authVariant(text, f.start) } : {}),
            fingerprint: f.fingerprint,
            redactable: false,
            note: "move it to the credential store (kirie credentials set <key>) and reference it as $credential:<key>",
            vaultable: false,
            target: { kind: "none", file, line: i + 1 },
          });
        }
      });
      return status;
    } catch (err) {
      return { ...status, status: "error", error: errorCode(err) };
    }
  }

  private writeReport(report: SecretsScanReport): string {
    mkdirSync(this.reportsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.reportsDir, 0o700);
    } catch {
      // Best effort: the file itself is 0600.
    }
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    const path = join(this.reportsDir, `secrets-scan-${stamp}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }

  // -- Reports ----------------------------------------------------------------

  /** The newest report on disk (this process's scan, or one from before a restart). */
  latestReport(): { report: SecretsScanReport; path: string; current: boolean } | null {
    if (this.active?.reportPath) {
      return { report: this.active.report, path: this.active.reportPath, current: true };
    }
    if (!existsSync(this.reportsDir)) return null;
    try {
      const files = readdirSync(this.reportsDir).filter((f) => /^secrets-scan-.*\.json$/.test(f)).sort();
      const last = files[files.length - 1];
      if (!last) return null;
      const path = join(this.reportsDir, last);
      const report = JSON.parse(readFileSync(path, "utf8")) as SecretsScanReport;
      if (report?.version !== 1 || !Array.isArray(report.findings)) return null;
      return { report, path, current: false };
    } catch (err) {
      log.warn({ err: errorCode(err) }, "could not read the last secrets scan report");
      return null;
    }
  }

  // -- Redact -----------------------------------------------------------------

  /**
   * Which findings of the current scan `ids` ("all" or numbers) would change. Pure: reads
   * nothing. Needs a scan from this process, because the fingerprint key is never stored.
   */
  planRedaction(ids: "all" | readonly number[], opts?: { vault?: boolean }): SecretsRedactionPlan | { error: string } {
    const active = this.active;
    if (!active) return { error: "No scan in this run of Kirie. Send /secrets scan first, then redact by the new ids." };
    const vault = opts?.vault === true;
    const byId = new Map(active.report.findings.map((f) => [f.id, f]));
    const wanted = ids === "all" ? active.report.findings.map((f) => f.id) : [...new Set(ids)];
    const findings: SecretsScanFinding[] = [];
    const skipped: Array<{ id: number; reason: string }> = [];
    for (const id of wanted) {
      const f = byId.get(id);
      if (!f) {
        skipped.push({ id, reason: "no such finding in the last scan" });
      } else if (!f.redactable) {
        if (ids !== "all") skipped.push({ id, reason: f.note ?? "not redactable" });
      } else {
        findings.push(f);
      }
    }
    return { scanId: active.report.scanId, vault, findings, skipped };
  }

  /**
   * Change stored data. The caller (the owner command) must have the owner's explicit
   * confirmation first. Every location is re-verified against its fingerprint; databases
   * use secure_delete, an FTS rebuild, a WAL checkpoint and VACUUM; text files get a
   * same-length positional overwrite (size and inode unchanged, so launchd's open log
   * keeps working). One audit record, without values.
   */
  async redact(plan: SecretsRedactionPlan, actor: string): Promise<SecretsRedactionResult> {
    const active = this.active;
    if (!active || active.report.scanId !== plan.scanId) throw new Error(SECRETS_STALE_PLAN_MESSAGE);
    const result: SecretsRedactionResult = {
      scanId: plan.scanId, redacted: [], vaulted: [], skipped: [...plan.skipped], databases: [], files: [], rotationAdvice: [],
    };

    const rowGroups = new Map<string, SecretsScanFinding[]>();
    const fileGroups = new Map<string, SecretsScanFinding[]>();
    for (const f of plan.findings) {
      const groups = f.target.kind === "row" ? rowGroups : f.target.kind === "file" ? fileGroups : null;
      if (!groups) {
        result.skipped.push({ id: f.id, reason: f.note ?? "not redactable" });
        continue;
      }
      const list = groups.get(f.target.file) ?? [];
      list.push(f);
      groups.set(f.target.file, list);
    }

    for (const [file, list] of rowGroups) {
      await this.redactDatabase(file, list, plan.vault, active.key, result);
    }
    for (const [file, list] of fileGroups) {
      this.redactTextFile(file, list, active.key, result);
    }

    const done = new Set(result.redacted);
    result.rotationAdvice = secretsRotationAdvice(plan.findings.filter((f) => done.has(f.id)));
    for (const f of active.report.findings) {
      if (!done.has(f.id)) continue;
      f.redactable = false;
      f.note = "already redacted";
    }
    active.report.counts = countFindings(active.report.findings);
    if (active.reportPath) {
      try {
        writeFileSync(active.reportPath, JSON.stringify(active.report, null, 2) + "\n", { mode: 0o600 });
      } catch (err) {
        log.warn({ err: errorCode(err) }, "could not update the secrets scan report");
      }
    }

    this.opts.audit?.record({
      feature: "secrets",
      action: "redact",
      actor,
      detail: {
        scanId: plan.scanId,
        vault: plan.vault,
        redacted: result.redacted,
        vaultKeys: result.vaulted.map((v) => v.key),
        skipped: result.skipped,
        databases: result.databases.map((d) => ({ ...d, file: this.rel(d.file) })),
        files: result.files.map((f) => ({ ...f, file: this.rel(f.file) })),
      },
    });
    log.info({ redacted: result.redacted.length, skipped: result.skipped.length, vaulted: result.vaulted.length }, "secrets redact finished");
    return result;
  }

  private async redactDatabase(
    file: string, findings: SecretsScanFinding[], vault: boolean, key: Buffer, result: SecretsRedactionResult,
  ): Promise<void> {
    const dbResult: SecretsRedactionResult["databases"][number] = {
      file, rowsChanged: 0, ftsRebuilt: [], vectorsCleared: 0, reembedded: 0, checkpoint: "failed", vacuum: "skipped",
    };
    result.databases.push(dbResult);
    let db: Database.Database;
    try {
      db = new Database(file, { fileMustExist: true });
    } catch (err) {
      for (const f of findings) result.skipped.push({ id: f.id, reason: `cannot open ${basename(file)} (${errorCode(err)})` });
      return;
    }
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.pragma("secure_delete = ON");

      // Group by cell. Phase 1 reads and verifies, and stores vault values (async).
      const cells = new Map<string, { target: SecretsRowTarget; findings: SecretsScanFinding[] }>();
      for (const f of findings) {
        const t = f.target as SecretsRowTarget;
        const k = `${t.table}\u0000${String(t.id)}\u0000${t.column}`;
        const cell = cells.get(k) ?? { target: t, findings: [] };
        cell.findings.push(f);
        cells.set(k, cell);
      }

      interface CellEdit {
        target: SecretsRowTarget;
        original: string;
        updated: string;
        applied: SecretsScanFinding[];
        vaulted: Array<{ id: number; key: string }>;
        tags: string[];
        memoryKey?: string;
      }
      const edits: CellEdit[] = [];
      const usedVaultKeys = new Set<string>();
      for (const { target, findings: cellFindings } of cells.values()) {
        const row = db.prepare(`SELECT * FROM "${target.table}" WHERE ${sqlName(target.idColumn)} = ?`).get(target.id) as Record<string, unknown> | undefined;
        const original = row?.[target.column];
        if (typeof original !== "string") {
          for (const f of cellFindings) result.skipped.push({ id: f.id, reason: "row no longer exists" });
          continue;
        }
        const verified: SecretsScanFinding[] = [];
        for (const f of cellFindings) {
          const t = f.target as SecretsRowTarget;
          if (t.end <= original.length && hmac(key, original.slice(t.start, t.end)) === f.fingerprint) verified.push(f);
          else result.skipped.push({ id: f.id, reason: "changed since the scan" });
        }
        if (verified.length === 0) continue;
        const replacements = new Map<number, string>();
        const vaulted: Array<{ id: number; key: string }> = [];
        const memoryKey = target.table === "memories" && typeof row?.key === "string" ? row.key : undefined;
        const useVault = vault && target.table === "memories" && target.column === "content" && this.opts.vault && memoryKey !== undefined;
        for (const f of verified) {
          const t = f.target as SecretsRowTarget;
          if (!useVault) {
            replacements.set(f.id, redactionMarker(f.rule));
            continue;
          }
          try {
            const vaultKey = await this.freeVaultKey(memoryKey!, target.id, usedVaultKeys);
            await this.opts.vault!.set(vaultKey, original.slice(t.start, t.end));
            usedVaultKeys.add(vaultKey);
            vaulted.push({ id: f.id, key: vaultKey });
            replacements.set(f.id, `«stored in credential store: ${vaultKey}»`);
          } catch (err) {
            result.skipped.push({ id: f.id, reason: `vault write failed (${errorCode(err)}); not redacted` });
          }
        }
        const applied = verified.filter((f) => replacements.has(f.id));
        if (applied.length === 0) continue;
        let updated = original;
        for (const f of [...applied].sort((a, b) => (b.target as SecretsRowTarget).start - (a.target as SecretsRowTarget).start)) {
          const t = f.target as SecretsRowTarget;
          updated = updated.slice(0, t.start) + replacements.get(f.id)! + updated.slice(t.end);
        }
        edits.push({ target, original, updated, applied, vaulted, tags: parseTags(row?.tags), ...(memoryKey !== undefined ? { memoryKey } : {}) });
      }

      // Phase 2: one transaction. A cell that changed between the phases is skipped.
      // BEGIN IMMEDIATE takes the write lock up front (honouring busy_timeout), and nothing
      // is caught inside: any error rolls the whole transaction back, and only a committed
      // transaction counts as redacted.
      const committed: CellEdit[] = [];
      const changed: Array<{ id: number; reason: string }> = [];
      const apply = db.transaction(() => {
        for (const e of edits) {
          const t = e.target;
          const now = db.prepare(`SELECT "${t.column}" AS v FROM "${t.table}" WHERE ${sqlName(t.idColumn)} = ?`).get(t.id) as { v?: unknown } | undefined;
          if (now?.v !== e.original) {
            for (const f of e.applied) changed.push({ id: f.id, reason: "changed since the scan" });
            continue;
          }
          if (t.table === "memories" && t.column === "content") {
            db.prepare(`UPDATE memories SET content = ?, content_hash = ?, updated_at = datetime('now') WHERE id = ?`)
              .run(e.updated, createHash("sha256").update(e.updated).digest("hex"), t.id);
          } else {
            db.prepare(`UPDATE "${t.table}" SET "${t.column}" = ? WHERE ${sqlName(t.idColumn)} = ?`).run(e.updated, t.id);
          }
          committed.push(e);
        }
      });
      try {
        apply.immediate();
      } catch (err) {
        log.error({ file: basename(file), err: errorCode(err) }, "secrets redact transaction rolled back");
        for (const e of edits) {
          for (const f of e.applied) result.skipped.push({ id: f.id, reason: `update failed, nothing in ${basename(file)} changed (${errorCode(err)})` });
        }
        dbResult.checkpoint = "complete";
        return;
      }
      result.skipped.push(...changed);
      const changedIds = new Map<string, Set<string | number>>();
      const memoryRows: Array<{ key: string; content: string; tags: string[] }> = [];
      for (const e of committed) {
        const t = e.target;
        dbResult.rowsChanged++;
        for (const f of e.applied) result.redacted.push(f.id);
        result.vaulted.push(...e.vaulted);
        const set = changedIds.get(t.table) ?? new Set();
        set.add(t.id);
        changedIds.set(t.table, set);
        // Memory keys are never rewritten (a key finding is not redactable), so the vector key stays.
        if (t.table === "memories" && t.column === "content" && e.memoryKey !== undefined) {
          memoryRows.push({ key: e.memoryKey, content: e.updated, tags: e.tags });
        }
      }

      if (dbResult.rowsChanged > 0) {
        await this.afterDatabaseEdit(db, file, changedIds, memoryRows, dbResult);
      } else {
        dbResult.checkpoint = "complete";
      }
    } finally {
      db.close();
    }
  }

  /** FTS rebuild, stale vectors, re-embed, WAL checkpoint, VACUUM. Each step reports, none throws. */
  private async afterDatabaseEdit(
    db: Database.Database,
    file: string,
    changedIds: Map<string, Set<string | number>>,
    memoryRows: Array<{ key: string; content: string; tags: string[] }>,
    out: SecretsRedactionResult["databases"][number],
  ): Promise<void> {
    const tableExists = (name: string): boolean =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

    for (const fts of ["memories_fts", "messages_fts", "heartbeat_logs_fts"]) {
      if (!tableExists(fts)) continue;
      try {
        db.prepare(`INSERT INTO "${fts}"("${fts}") VALUES('rebuild')`).run();
        out.ftsRebuilt.push(fts);
      } catch (err) {
        log.warn({ file: basename(file), fts, err: errorCode(err) }, "FTS rebuild failed");
      }
    }

    // Vectors embedded from the old text: delete them (chat history, heartbeat logs).
    const vectorTables: Array<{ table: string; source: string; column: string }> = [
      { table: "message_vectors", source: "messages", column: "message_id" },
      { table: "heartbeat_log_vectors", source: "heartbeat_logs", column: "log_id" },
    ];
    for (const v of vectorTables) {
      const ids = changedIds.get(v.source);
      if (!ids || !tableExists(v.table)) continue;
      const del = db.prepare(`DELETE FROM "${v.table}" WHERE "${v.column}" = ?`);
      for (const id of ids) out.vectorsCleared += del.run(id).changes;
    }

    // Memory vectors live in vectors.db: re-embed from the redacted text, or delete.
    if (memoryRows.length > 0) await this.refreshMemoryVectors(memoryRows, out);

    try {
      const rows = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
      const r = rows[0];
      out.checkpoint = r && r.busy === 0 && r.log === r.checkpointed ? "complete" : "partial";
    } catch (err) {
      out.checkpoint = "failed";
      log.warn({ file: basename(file), err: errorCode(err) }, "WAL checkpoint failed");
    }
    const size = statSync(file).size;
    if (size > VACUUM_MAX_BYTES) {
      out.vacuum = "skipped";
      return;
    }
    try {
      db.exec("VACUUM");
      out.vacuum = "ok";
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      out.vacuum = "failed";
      log.warn({ file: basename(file), err: errorCode(err) }, "VACUUM failed");
    }
  }

  private async refreshMemoryVectors(
    rows: Array<{ key: string; content: string; tags: string[] }>,
    out: SecretsRedactionResult["databases"][number],
  ): Promise<void> {
    const stale: string[] = [];
    for (const r of rows) {
      if (this.opts.reembedMemory) {
        try {
          await this.opts.reembedMemory(r.key, r.content, r.tags);
          out.reembedded++;
          continue;
        } catch (err) {
          log.warn({ err: errorCode(err) }, "re-embedding a redacted memory failed; its vector is deleted instead");
        }
      }
      stale.push(r.key);
    }
    const vectorDb = this.opts.vectorDbPath ?? join(this.opts.dataDir, "vectors.db");
    if (stale.length === 0 || !existsSync(vectorDb)) return;
    let vdb: Database.Database | null = null;
    try {
      vdb = new Database(vectorDb, { fileMustExist: true });
      vdb.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      vdb.pragma("secure_delete = ON");
      if (!vdb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_vectors'").get()) return;
      const del = vdb.prepare("DELETE FROM memory_vectors WHERE key = ?");
      for (const k of stale) out.vectorsCleared += del.run(k).changes;
      vdb.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      log.warn({ err: errorCode(err) }, "could not clear stale memory vectors");
    } finally {
      vdb?.close();
    }
  }

  /**
   * `vault.<slug of the memory key>`, or `vault.memory-<row id>` when the key itself matches a
   * rule (the vault key is shown in chat, the audit trail and the rewritten row).
   */
  private async freeVaultKey(memoryKey: string, rowId: string | number, used: ReadonlySet<string>): Promise<string> {
    const keyIsSecret = this.opts.scrubber.detect(memoryKey).length > 0;
    const slug = keyIsSecret
      ? `memory-${String(rowId).replace(VAULT_KEY_RE, "")}`
      : memoryKey.toLowerCase().replace(VAULT_KEY_RE, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "memory";
    const base = `vault.${slug}`;
    for (let n = 1; n < 100; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      if (used.has(candidate)) continue;
      if ((await this.opts.vault!.get(candidate)) === undefined) return candidate;
    }
    throw new Error("no free vault key");
  }

  private redactTextFile(file: string, findings: SecretsScanFinding[], key: Buffer, result: SecretsRedactionResult): void {
    const out = { file, masked: 0, sizeKept: true, inodeKept: true };
    result.files.push(out);
    let fd: number;
    try {
      fd = openSync(file, "r+");
    } catch (err) {
      for (const f of findings) result.skipped.push({ id: f.id, reason: `cannot open ${basename(file)} (${errorCode(err)})` });
      return;
    }
    try {
      const before = fstatSync(fd);
      for (const f of findings) {
        const t = f.target as SecretsFileTarget;
        const buf = Buffer.alloc(t.byteLength);
        const n = readSync(fd, buf, 0, t.byteLength, t.byteOffset);
        if (n !== t.byteLength || hmac(key, buf.toString("utf8")) !== f.fingerprint) {
          result.skipped.push({ id: f.id, reason: "changed since the scan" });
          continue;
        }
        const mask = secretsSameLengthMask(f.rule, t.byteLength);
        writeSync(fd, mask, 0, mask.length, t.byteOffset);
        out.masked++;
        result.redacted.push(f.id);
      }
      fsyncSync(fd);
      const after = fstatSync(fd);
      out.sizeKept = after.size >= before.size;
      out.inodeKept = after.ino === before.ino;
    } finally {
      closeSync(fd);
    }
  }
}

function rowRedactable(src: DbSource, column: string, row: Record<string, unknown>): { redactable: boolean; note?: string } {
  if (src.table === "memories" && column === "key") {
    return { redactable: false, note: "the memory key itself matches; delete or rename that memory by hand" };
  }
  if ((src.table === "schedules" || src.table === "webhooks") && (column === "name" || column === "path")) {
    return { redactable: false, note: `the ${src.table === "schedules" ? "schedule" : "webhook"} ${column} matches; delete and recreate it by hand` };
  }
  if (src.table === "memories" && column === "tags") {
    return { redactable: false, note: "a memory tag matches; edit that memory's tags by hand" };
  }
  if (src.table === "background_tasks" && (row.status === "pending" || row.status === "running")) {
    return { redactable: false, note: "the task is still pending or running; scan again after it ends" };
  }
  return { redactable: true };
}

function parseTags(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function hasCredentialTag(raw: unknown): boolean {
  return parseTags(raw).some((t) => /^(credential|credentials|secret|api-?key)$/i.test(t));
}

function countFindings(findings: readonly SecretsScanFinding[]): SecretsScanCounts {
  const byStore: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  let redactable = 0;
  for (const f of findings) {
    byStore[f.store] = (byStore[f.store] ?? 0) + 1;
    const label = secretsRuleLabel(f);
    byRule[label] = (byRule[label] ?? 0) + 1;
    if (f.redactable) redactable++;
  }
  return { total: findings.length, redactable, byStore, byRule };
}
