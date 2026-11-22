/**
 * RuntimeSettings - owner-set overrides layered over config.yaml.
 *
 * Owner commands never rewrite config.yaml; they write an override here
 * (~/.kirie/state/runtime-settings.json, file 0600, dir 0700, written
 * atomically with tmp + rename). Keys are dotted and mirror the config path
 * ("approvals.mode"). Every set/delete writes an audit record.
 *
 * Only the daemon writes. The stdio MCP subprocess opens the file with
 * `{ readonly: true }` and re-reads it when the file's mtime changes.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import type { z } from "zod/v3";
import type { AuditTrail } from "../security/audit-trail.js";

const log = pino({ name: "runtime-settings" });

export interface RuntimeSettingsOptions {
  /** Never write; re-read when the file changes (stdio MCP subprocess) */
  readonly?: boolean;
  audit?: AuditTrail;
}

interface StoredSetting {
  value: unknown;
  setBy: string;
  setAt: string;
}

interface SettingsFile {
  version: 1;
  settings: Record<string, StoredSetting>;
}

const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$/;
const AUDIT_VALUE_MAX_CHARS = 300;

export class RuntimeSettings {
  private settings: Record<string, StoredSetting> = {};
  private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  private readonly warned = new Set<string>();
  private readonly readonly: boolean;
  private readonly audit: AuditTrail | undefined;
  private loadedMtimeMs = -1;
  private loadedSize = -1;
  /** The file existed but could not be parsed; set() keeps a copy before replacing it. */
  private corrupt = false;

  constructor(
    private readonly filePath: string,
    opts: RuntimeSettingsOptions = {},
  ) {
    this.readonly = opts.readonly ?? false;
    this.audit = opts.audit;
    this.load(false);
  }

  /** Path of the settings file. */
  get path(): string {
    return this.filePath;
  }

  /** The stored override, validated. An invalid stored value gives undefined and a warning. */
  get<T>(key: string, schema: z.ZodType<T>): T | undefined {
    this.refresh();
    const stored = this.settings[key];
    if (!stored) return undefined;
    const parsed = schema.safeParse(stored.value);
    if (!parsed.success) {
      const sig = `${key}:${JSON.stringify(stored.value)}`;
      if (!this.warned.has(sig)) {
        this.warned.add(sig);
        log.warn({ key }, "ignoring invalid runtime setting");
      }
      return undefined;
    }
    return parsed.data;
  }

  /** The override when one is set and valid, else the config value. */
  effective<T>(key: string, schema: z.ZodType<T>, configValue: T): T {
    const v = this.get(key, schema);
    return v === undefined ? configValue : v;
  }

  /** Store an override. `by` is the actor, e.g. "owner:telegram:<id>". */
  set<T>(key: string, value: T, by: string): void {
    this.assertWritable();
    assertKey(key);
    if (value === undefined) throw new Error(`Runtime setting "${key}": use delete() to remove a value`);
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error(`Runtime setting "${key}" is not JSON-serializable`);
    const stored: StoredSetting = { value: JSON.parse(json) as unknown, setBy: by, setAt: new Date().toISOString() };
    const old = this.settings[key];
    const next = { ...this.settings, [key]: stored };
    this.write(next);
    this.settings = next;
    this.audit?.record({
      feature: "settings",
      action: "set",
      actor: by,
      detail: { key, old: old ? preview(old.value) : null, new: preview(stored.value) },
    });
    this.emit(key, stored.value);
  }

  /** Drop an override (back to the config value). No-op when none is set. */
  delete(key: string, by: string): void {
    this.assertWritable();
    assertKey(key);
    const old = this.settings[key];
    if (!old) return;
    const next = { ...this.settings };
    delete next[key];
    this.write(next);
    this.settings = next;
    this.audit?.record({ feature: "settings", action: "delete", actor: by, detail: { key, old: preview(old.value) } });
    this.emit(key, undefined);
  }

  /** Keys with an override, sorted. With a prefix, only keys starting with it. */
  keys(prefix?: string): string[] {
    this.refresh();
    const all = Object.keys(this.settings).sort();
    return prefix === undefined ? all : all.filter((k) => k.startsWith(prefix));
  }

  /** Who set a key and when. */
  describe(key: string): { setBy: string; setAt: string } | undefined {
    this.refresh();
    const s = this.settings[key];
    return s ? { setBy: s.setBy, setAt: s.setAt } : undefined;
  }

  /** Called with the new value (undefined when deleted). Returns an unsubscribe function. */
  onChange(key: string, cb: (value: unknown) => void): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      this.listeners.get(key)?.delete(cb);
    };
  }

  // -------------------------------------------------------------------------

  private assertWritable(): void {
    if (this.readonly) throw new Error("Runtime settings are read-only in this process");
  }

  /** Read-only mode: reload when the file changed on disk. */
  private refresh(): void {
    if (!this.readonly) return;
    let mtimeMs = -1;
    let size = -1;
    try {
      const st = statSync(this.filePath);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // Missing file: treated as empty below.
    }
    if (mtimeMs === this.loadedMtimeMs && size === this.loadedSize) return;
    this.load(true);
  }

  private load(notify: boolean): void {
    const before = this.settings;
    let next: Record<string, StoredSetting> = {};
    try {
      const st = statSync(this.filePath);
      this.loadedMtimeMs = st.mtimeMs;
      this.loadedSize = st.size;
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<SettingsFile>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.settings !== "object" || parsed.settings === null) {
        throw new Error("unexpected shape");
      }
      for (const [k, v] of Object.entries(parsed.settings)) {
        if (!KEY_RE.test(k) || !v || typeof v !== "object" || !("value" in v)) continue;
        next[k] = { value: v.value, setBy: String(v.setBy ?? "unknown"), setAt: String(v.setAt ?? "") };
      }
      this.corrupt = false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.loadedMtimeMs = -1;
        this.loadedSize = -1;
        this.corrupt = false;
      } else {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "runtime settings file unreadable; using none");
        this.corrupt = true;
      }
      next = {};
    }
    this.settings = next;
    if (!notify) return;
    const keys = new Set([...Object.keys(before), ...Object.keys(next)]);
    for (const k of keys) {
      if (JSON.stringify(before[k]?.value) !== JSON.stringify(next[k]?.value)) this.emit(k, next[k]?.value);
    }
  }

  private write(settings: Record<string, StoredSetting>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (this.corrupt) {
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Nothing to keep.
      }
      this.corrupt = false;
    }
    const body: SettingsFile = { version: 1, settings };
    const tmp = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.filePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    try {
      const st = statSync(this.filePath);
      this.loadedMtimeMs = st.mtimeMs;
      this.loadedSize = st.size;
    } catch {
      // Stat failure only affects change detection.
    }
  }

  private emit(key: string, value: unknown): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(value);
      } catch (err) {
        log.warn({ key, err: err instanceof Error ? err.message : String(err) }, "runtime setting listener failed");
      }
    }
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || !KEY_RE.test(key)) throw new Error(`Invalid runtime setting key "${String(key)}"`);
}

function preview(value: unknown): string {
  const s = JSON.stringify(value) ?? "undefined";
  return s.length <= AUDIT_VALUE_MAX_CHARS ? s : s.slice(0, AUDIT_VALUE_MAX_CHARS - 1) + "…";
}
