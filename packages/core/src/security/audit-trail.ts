/**
 * AuditTrail - the one append-only audit file (~/.kirie/logs/audit.jsonl).
 *
 * One JSON object per line. Every feature that needs history writes here
 * and reads back with `recent({ feature })`. Records hold ids, hashes,
 * counts and reasons, never payload bodies or secret values; every string
 * is passed through the injected scrubber and `detail` is capped at 2 KB.
 *
 * `record` never throws: an audit failure must not break the action that
 * is being audited.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import pino from "pino";

const log = pino({ name: "audit-trail" });

export interface AuditRecord {
  /** ISO timestamp */
  ts: string;
  /** "commands" | "settings" | "accounts" | "approvals" | "learning" | "webhooks" | ... */
  feature: string;
  /** Dotted, e.g. "proposal.applied", "gate.denied", "rotated" */
  action: string;
  /** "owner:telegram:<id>" | "agent:<sessionKey>" | "system" | "webhook:<hookId>" */
  actor: string;
  /** Ids, hashes, counts, reasons. Never payload bodies or secret values */
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  feature?: string;
  action?: string;
  /** Only records at or after this epoch ms */
  sinceMs?: number;
  /** Maximum records returned (default 100) */
  limit?: number;
}

export interface AuditTrailOptions {
  /** Applied to every string in a record. Default: identity (W1B passes scrubSecrets) */
  scrub?: (text: string) => string;
  /** Rotation threshold in bytes. Default 10 MB */
  maxBytes?: number;
  /** Rotated files kept (audit.jsonl.1 .. .N). Default 5 */
  keep?: number;
}

/** Maximum serialized size of `detail`. */
export const AUDIT_DETAIL_MAX_BYTES = 2048;
/** How much of the file tail `recent` reads. */
const TAIL_BYTES = 5 * 1024 * 1024;
const MAX_FIELD_CHARS = 200;
const MAX_DEPTH = 4;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;

export class AuditTrail {
  private readonly scrub: (text: string) => string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private dirReady = false;
  private lastWarnAt = 0;

  constructor(
    private readonly filePath: string,
    opts: AuditTrailOptions = {},
  ) {
    this.scrub = opts.scrub ?? ((t) => t);
    this.maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
    this.keep = Math.max(1, opts.keep ?? 5);
  }

  /** Path of the audit file. */
  get path(): string {
    return this.filePath;
  }

  /** Append one record. Never throws. */
  record(rec: Omit<AuditRecord, "ts">): void {
    try {
      const out: AuditRecord = {
        ts: new Date().toISOString(),
        feature: this.cleanField(rec.feature),
        action: this.cleanField(rec.action),
        actor: this.cleanField(rec.actor),
      };
      if (rec.detail !== undefined && rec.detail !== null) {
        out.detail = this.cleanDetail(rec.detail);
      }
      this.append(JSON.stringify(out) + "\n");
    } catch (err) {
      this.warn(err, "audit record failed");
    }
  }

  /** Matching records from the tail of the file, newest first. */
  recent(filter: AuditFilter = {}): AuditRecord[] {
    const limit = Math.max(0, filter.limit ?? 100);
    if (limit === 0) return [];
    let text: string;
    try {
      text = this.readTail();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.warn(err, "audit read failed");
      return [];
    }
    const out: AuditRecord[] = [];
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!;
      if (!line) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(line) as AuditRecord;
      } catch {
        continue;
      }
      if (!rec || typeof rec !== "object" || typeof rec.ts !== "string") continue;
      if (filter.feature !== undefined && rec.feature !== filter.feature) continue;
      if (filter.action !== undefined && rec.action !== filter.action) continue;
      if (filter.sinceMs !== undefined) {
        const t = Date.parse(rec.ts);
        if (!Number.isFinite(t) || t < filter.sinceMs) continue;
      }
      out.push(rec);
    }
    return out;
  }

  /** Daemon only: when the file reaches maxBytes, shift it to audit.jsonl.1 (keeping `keep` files). Never throws. */
  rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath)) return;
      if (statSync(this.filePath).size < this.maxBytes) return;
      const oldest = `${this.filePath}.${this.keep}`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.filePath}.${i + 1}`);
      }
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch (err) {
      this.warn(err, "audit rotation failed");
    }
  }

  // -------------------------------------------------------------------------

  private append(line: string): void {
    if (!this.dirReady) {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      this.dirReady = true;
    }
    const existed = existsSync(this.filePath);
    // One write per line with O_APPEND, so the daemon and the stdio subprocess can share the file.
    appendFileSync(this.filePath, line, { mode: 0o600, flag: "a" });
    if (!existed) chmodSync(this.filePath, 0o600);
  }

  private readTail(): string {
    const size = statSync(this.filePath).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(this.filePath, "r");
    try {
      let read = 0;
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read);
        if (n === 0) break;
        read += n;
      }
    } finally {
      closeSync(fd);
    }
    let text = buf.toString("utf8");
    if (start > 0) {
      // Drop the partial first line.
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return text;
  }

  private cleanField(value: unknown): string {
    const s = typeof value === "string" ? value : String(value ?? "");
    return truncate(this.scrub(s), MAX_FIELD_CHARS);
  }

  private cleanDetail(detail: Record<string, unknown>): Record<string, unknown> {
    const cleaned = this.cleanValue(detail, 0, new WeakSet());
    const obj = (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
      ? cleaned
      : { value: cleaned }) as Record<string, unknown>;
    const json = JSON.stringify(obj);
    if (Buffer.byteLength(json, "utf8") <= AUDIT_DETAIL_MAX_BYTES) return obj;
    return { truncated: true, preview: truncateBytes(json, AUDIT_DETAIL_MAX_BYTES - 64) };
  }

  private cleanValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (value === null || value === undefined) return value ?? null;
    switch (typeof value) {
      case "string":
        return this.scrub(value);
      case "number":
        return Number.isFinite(value) ? value : String(value);
      case "boolean":
        return value;
      case "bigint":
        return value.toString();
      case "object":
        break;
      default:
        return `[${typeof value}]`;
    }
    const obj = value as object;
    if (seen.has(obj)) return "[circular]";
    if (depth >= MAX_DEPTH) return "[truncated]";
    seen.add(obj);
    if (obj instanceof Error) return { name: obj.name, message: this.scrub(obj.message) };
    if (obj instanceof Date) return obj.toISOString();
    if (Array.isArray(obj)) {
      return obj.slice(0, MAX_ARRAY).map((v) => this.cleanValue(v, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (n++ >= MAX_KEYS) break;
      if (v === undefined) continue;
      out[this.scrub(k)] = this.cleanValue(v, depth + 1, seen);
    }
    return out;
  }

  private warn(err: unknown, msg: string): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, msg);
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function truncateBytes(s: string, maxBytes: number): string {
  let out = s;
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out;
}
