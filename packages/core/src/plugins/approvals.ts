/**
 * Owner approvals of plugins, pinned to a content hash (PLAN C.15).
 *
 * File: ~/.kirie/state/plugin-approvals.json, mode 0600 in a 0700 directory,
 * written atomically (temp file + rename). Only the daemon writes it, and only
 * from an owner command handler. No MCP tool and no HTTP route can.
 *
 * The file is a plain file the agent could edit (same user, unrestricted
 * shell), so approvals are tamper-evident, not tamper-proof: every write also
 * writes `<file>.seal` (the file's SHA-256), and at boot an approvals file that
 * does not match its seal is not trusted; while running, the store remembers
 * what it last read or wrote and the manager reports any outside change. An
 * attacker who reads this source can forge both files; the owner still gets the
 * "Plugins loaded" notice and every load is audited.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod/v3";
import { HOOK_EVENT_TYPES, type HookEventType } from "../hooks/types.js";
import { createModuleLogger } from "../logging/logger.js";
import { PLUGIN_CAPABILITIES, PLUGIN_NAME_RE, type PluginCapability } from "./types.js";

const log = createModuleLogger("plugin-approvals");

export const PLUGIN_APPROVALS_FILE = "plugin-approvals.json";

/** Default location: `<dataDir>/state/plugin-approvals.json`. */
export function pluginApprovalsPath(dataDir: string): string {
  return join(dataDir, "state", PLUGIN_APPROVALS_FILE);
}

const ApprovalSchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE),
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.array(z.enum(PLUGIN_CAPABILITIES as [PluginCapability, ...PluginCapability[]])),
  events: z.array(z.enum(HOOK_EVENT_TYPES as [HookEventType, ...HookEventType[]])),
  enabled: z.boolean(),
  approvedAt: z.string(),
  approvedBy: z.string(),
  fileCount: z.number().int().nonnegative().optional(),
});

export type PluginApproval = z.infer<typeof ApprovalSchema>;

const FileSchema = z.object({
  version: z.literal(1),
  plugins: z.record(z.unknown()),
});

export class PluginApprovalStore {
  private lastDigest: string | null | undefined;

  constructor(readonly filePath: string) {}

  /** Every valid record, sorted by name. Invalid records are skipped with a warning. */
  list(): PluginApproval[] {
    return Object.values(this.read()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): PluginApproval | undefined {
    return this.read()[name];
  }

  /** Insert or replace a record. */
  upsert(record: PluginApproval): void {
    const parsed = ApprovalSchema.parse(record);
    const all = this.read();
    all[parsed.name] = parsed;
    this.write(all);
  }

  /** Flip `enabled` on an existing record, keeping the approval. False when there is none. */
  setEnabled(name: string, enabled: boolean): boolean {
    const all = this.read();
    const rec = all[name];
    if (!rec) return false;
    all[name] = { ...rec, enabled };
    this.write(all);
    return true;
  }

  remove(name: string): boolean {
    const all = this.read();
    if (!all[name]) return false;
    delete all[name];
    this.write(all);
    return true;
  }

  /**
   * True when the file's bytes differ from what this store last read or wrote.
   * The first call only records a baseline and returns false.
   */
  changedSinceLastSeen(): boolean {
    const now = this.currentDigest();
    if (this.lastDigest === undefined) {
      this.lastDigest = now;
      return false;
    }
    const changed = now !== this.lastDigest;
    this.lastDigest = now;
    return changed;
  }

  private currentDigest(): string | null {
    try {
      return createHash("sha256").update(readFileSync(this.filePath)).digest("hex");
    } catch {
      return null;
    }
  }

  private read(): Record<string, PluginApproval> {
    let raw: Buffer;
    try {
      raw = readFileSync(this.filePath);
    } catch {
      return {};
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      log.warn({ file: this.filePath }, "plugin approvals file is not valid JSON; treating it as empty");
      return {};
    }
    const file = FileSchema.safeParse(json);
    if (!file.success) {
      log.warn({ file: this.filePath }, "plugin approvals file has an unknown shape; treating it as empty");
      return {};
    }
    const out: Record<string, PluginApproval> = {};
    for (const [key, value] of Object.entries(file.data.plugins)) {
      const rec = ApprovalSchema.safeParse(value);
      if (!rec.success || rec.data.name !== key) {
        log.warn({ plugin: key }, "invalid plugin approval record skipped");
        continue;
      }
      out[key] = rec.data;
    }
    return out;
  }

  private write(all: Record<string, PluginApproval>): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // A directory we cannot chmod (not ours) still gets a 0600 file.
    }
    this.preserveUnreadable();
    const body = JSON.stringify({ version: 1, plugins: all }, null, 2) + "\n";
    const tmp = `${this.filePath}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    this.lastDigest = createHash("sha256").update(body).digest("hex");
    this.writeSeal(this.lastDigest);
  }

  /** `<file>.seal`: the SHA-256 of the approvals file as this daemon last wrote it. */
  get sealPath(): string {
    return `${this.filePath}.seal`;
  }

  /**
   * True when there is no approvals file, or when its bytes match the seal the
   * daemon wrote with it. False means the file was written by something other
   * than /plugins (or the seal is missing). Same user can forge both files, so
   * this is tamper-evident only.
   */
  sealMatches(): boolean {
    const digest = this.currentDigest();
    if (digest === null) return true;
    let seal: string;
    try {
      seal = readFileSync(this.sealPath, "utf8").trim();
    } catch {
      return false;
    }
    return seal === digest;
  }

  private writeSeal(digest: string): void {
    const tmp = `${this.sealPath}.tmp-${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(tmp, `${digest}\n`, { mode: 0o600 });
      renameSync(tmp, this.sealPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not write the plugin approvals seal");
    }
  }

  /** Before replacing a file we could not parse, keep a copy instead of overwriting it silently. */
  private preserveUnreadable(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    let ok = false;
    try {
      ok = FileSchema.safeParse(JSON.parse(raw)).success;
    } catch {
      ok = false;
    }
    if (ok) return;
    const copy = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      copyFileSync(this.filePath, copy);
      chmodSync(copy, 0o600);
      log.warn({ copy }, "kept a copy of the unreadable plugin approvals file");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "could not copy the unreadable approvals file");
    }
  }
}
