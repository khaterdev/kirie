/**
 * PluginManager (PLAN C.15): decides what loads, and records everything.
 *
 * A plugin loads only when ALL of these hold:
 *   1. the master switch (`plugins.enabled`, overlaid by `/plugins on|off`) is on;
 *   2. `plugins.allow` is empty or lists the name;
 *   3. an approval record exists with `enabled: true`, and it is one this daemon
 *      read at start from a file matching its seal, or wrote itself (a record
 *      that appears or changes in the file while the daemon runs, or a file
 *      not written by /plugins, is not trusted until the owner approves again);
 *   4. the current content hash equals the approved hash.
 * Nothing is discovered and loaded on its own, nothing is installed, nothing is
 * fetched. Every load, approval, refusal and failure is audited; the owner is
 * told about loads at start, load failures, hash changes, suspensions and
 * outside edits of the approvals file.
 *
 * Approve, enable, disable and reload are reachable only from the owner
 * `/plugins` command. No MCP tool and no HTTP route holds a manager.
 */

import type { AuditRecord } from "../security/audit-trail.js";
import type { HookRegistry } from "../hooks/registry.js";
import { createModuleLogger } from "../logging/logger.js";
import { scanCode, type CodeScanResult } from "../security/code-scanner.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { PluginApproval, PluginApprovalStore } from "./approvals.js";
import { inspectPluginTree, listPluginDirectories, PluginIntegrityError, type PluginTreeLimits } from "./integrity.js";
import { PluginLoadError, type LoadedPlugin, type PluginLoader } from "./loader.js";
import { parsePluginManifest, peekPluginManifest, PLUGIN_MANIFEST_FILE } from "./manifest.js";
import { isValidPluginName, type PluginManifest } from "./types.js";

const log = createModuleLogger("plugin-manager");

const SCAN_MAX_FILES = 300;
const SCAN_MAX_BYTES = 4 * 1024 * 1024;

export type PluginState =
  | "not-approved"   // a directory with no approval record
  | "disabled"       // approved, then disabled by the owner
  | "approved"       // approved and enabled, not loaded (master switch off, or not loaded yet)
  | "loaded"
  | "suspended"      // loaded, hooks suspended by the circuit breaker
  | "changed"        // content differs from the approved hash; not loaded
  | "unverified"     // approval record appeared or changed outside /plugins; not loaded
  | "not-allowed"    // excluded by plugins.allow
  | "failed"
  | "missing";       // approval record without a directory

export interface PluginStatus {
  name: string;
  state: PluginState;
  version?: string;
  events?: string[];
  capabilities?: string[];
  approvedSha256?: string;
  approvedAt?: string;
  approvedBy?: string;
  loadedAt?: string;
  failures: number;
  dropped: number;
  lastError?: string;
}

export interface PluginScanFinding extends CodeScanResult {
  file: string;
}

export type PluginInspection =
  | {
      ok: true;
      name: string;
      sha256: string;
      fileCount: number;
      totalBytes: number;
      manifest: PluginManifest;
      findings: PluginScanFinding[];
      blocking: boolean;
      scanTruncated: boolean;
      approval?: PluginApproval;
      status: PluginStatus;
    }
  | { ok: false; name: string; error: string; approval?: PluginApproval; status?: PluginStatus };

export interface PluginManagerSettings {
  allow: readonly string[];
  config: Readonly<Record<string, Record<string, unknown>>>;
}

export interface PluginManagerDeps {
  pluginsDir: string;
  loader: PluginLoader;
  registry: HookRegistry;
  approvals: PluginApprovalStore;
  audit: { record(rec: Omit<AuditRecord, "ts">): void };
  notifyOwner(text: string, opts?: { key?: string }): unknown;
  /** The effective master switch, read live */
  isEnabled(): boolean;
  /** `plugins.allow` and `plugins.config`, read live */
  settings(): PluginManagerSettings;
  limits?: Partial<PluginTreeLimits>;
  /** Tests only */
  uid?: number | null;
}

export type ApproveResult =
  | { ok: true; loaded: boolean; error?: string; approval: PluginApproval }
  | { ok: false; reason: string };

interface FailureRecord {
  state: "changed" | "failed" | "unverified" | "not-allowed";
  error: string;
}

export class PluginManager {
  private readonly failures = new Map<string, FailureRecord>();
  private readonly notified = new Set<string>();
  /** Approval records this daemon read at baseline or wrote itself, canonicalised */
  private readonly known = new Map<string, string>();
  private baselined = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private running = false;

  constructor(private readonly deps: PluginManagerDeps) {}

  /** True after start() with the master switch on, until stop(). */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Remember the approval records on disk now as the trusted set. Called once
   * at daemon setup, before anything can have changed them in this process.
   */
  baseline(): void {
    this.deps.approvals.changedSinceLastSeen();
    this.known.clear();
    this.baselined = true;
    const records = this.deps.approvals.list();
    if (!this.deps.approvals.sealMatches()) {
      // The file was not written by /plugins (or its seal is gone): trust none of it.
      this.deps.audit.record({
        feature: "plugins",
        action: "approvals.unsealed",
        actor: "system",
        detail: { records: records.map((r) => r.name) },
      });
      if (records.length > 0) {
        void this.notify(
          `The plugin approvals file does not match what /plugins last wrote, so none of its ${records.length} approval(s) ` +
            `(${records.map((r) => r.name).join(", ")}) is trusted. Review each plugin and send /plugins enable <name> to approve it again.`,
          "plugins:unsealed",
          false,
        );
      }
      return;
    }
    for (const rec of records) this.known.set(rec.name, canonical(rec));
  }

  /** Load every approved and enabled plugin, when the master switch is on. */
  async start(): Promise<{ loaded: LoadedPlugin[]; refused: string[] }> {
    if (!this.baselined) this.baseline();
    if (!this.deps.isEnabled()) return { loaded: [], refused: [] };
    this.running = true;
    this.checkApprovalsFile();
    const loaded: LoadedPlugin[] = [];
    const refused: string[] = [];
    for (const rec of this.deps.approvals.list()) {
      // /plugins off or shutdown while starting: load nothing more.
      if (!this.running || !this.deps.isEnabled()) break;
      if (!rec.enabled || this.deps.loader.isLoaded(rec.name)) continue;
      const out = await this.loadApproved(rec, "start");
      if (out) loaded.push(out);
      else refused.push(rec.name);
    }
    if (loaded.length > 0) {
      const names = loaded.map((p) => `${p.name} ${p.version}`).join(", ");
      void this.notify(
        `Plugins loaded: ${names}. Each runs inside Kirie with its full privileges. Send /plugins to review.`,
        "plugins:loaded",
        false,
      );
    }
    return { loaded, refused };
  }

  /** Unload everything (hooks first, then each teardown under a timeout). */
  async stop(reason = "stop"): Promise<void> {
    this.running = false;
    // Let loads already under way finish, then unload them with the rest.
    await Promise.allSettled([...this.inFlight]);
    for (const p of this.deps.loader.list().reverse()) {
      await this.deps.loader.unload(p.name);
      this.deps.audit.record({ feature: "plugins", action: "plugin.unloaded", actor: "system", detail: { name: p.name, reason } });
    }
  }

  /** One row per plugin directory, approval record or loaded plugin. Never hashes or imports. */
  list(): PluginStatus[] {
    const approvals = new Map(this.deps.approvals.list().map((a) => [a.name, a]));
    const names = new Set<string>([
      ...listPluginDirectories(this.deps.pluginsDir).filter(isValidPluginName),
      ...approvals.keys(),
      ...this.deps.loader.list().map((p) => p.name),
    ]);
    const dirs = new Set(listPluginDirectories(this.deps.pluginsDir));
    return [...names].sort().map((name) => this.statusOf(name, approvals.get(name), dirs.has(name)));
  }

  /** Directory checks, hash, manifest and static scan, for /plugins info and the enable preview. Never imports. */
  inspect(name: string): PluginInspection {
    const approval = isValidPluginName(name) ? this.deps.approvals.get(name) : undefined;
    let snapshot;
    try {
      snapshot = inspectPluginTree(this.deps.pluginsDir, name, {
        keepContents: true,
        ...(this.deps.limits ? { limits: this.deps.limits } : {}),
        ...(this.deps.uid !== undefined ? { uid: this.deps.uid } : {}),
      });
    } catch (err) {
      const error = err instanceof PluginIntegrityError ? err.message : `cannot inspect: ${errText(err)}`;
      return {
        ok: false,
        name,
        error,
        ...(approval ? { approval } : {}),
        ...(isValidPluginName(name) ? { status: this.statusOf(name, approval, false) } : {}),
      };
    }
    const status = this.statusOf(name, approval, true);
    const manifestEntry = snapshot.entries.find((e) => e.rel === PLUGIN_MANIFEST_FILE && e.kind === "file");
    let manifest: PluginManifest;
    try {
      if (!manifestEntry?.bytes) throw new Error("no package.json");
      manifest = parsePluginManifest(manifestEntry.bytes, name);
    } catch (err) {
      return { ok: false, name, error: `manifest: ${errText(err)}`, ...(approval ? { approval } : {}), status };
    }
    const entry = snapshot.entries.find((e) => e.rel === manifest.entry);
    if (!entry || entry.kind !== "file") {
      return { ok: false, name, error: `entry file ${manifest.entry} is missing or not a regular file`, ...(approval ? { approval } : {}), status };
    }

    const findings: PluginScanFinding[] = [];
    let scanned = 0;
    let scannedBytes = 0;
    let scanTruncated = false;
    for (const e of snapshot.entries) {
      if (e.kind !== "file" || !/\.(m?js|cjs)$/.test(e.rel) || !e.bytes) continue;
      if (scanned >= SCAN_MAX_FILES || scannedBytes + e.bytes.length > SCAN_MAX_BYTES) {
        scanTruncated = true;
        break;
      }
      scanned += 1;
      scannedBytes += e.bytes.length;
      for (const f of scanCode(e.bytes.toString("utf8"))) findings.push({ ...f, file: e.rel });
    }
    return {
      ok: true,
      name,
      sha256: snapshot.sha256,
      fileCount: snapshot.fileCount,
      totalBytes: snapshot.totalBytes,
      manifest,
      findings,
      blocking: findings.some((f) => f.severity === "block"),
      scanTruncated,
      ...(approval ? { approval } : {}),
      status,
    };
  }

  /**
   * Record the owner's approval of exactly the content they were shown
   * (`shownSha256`), then load it when the master switch is on. Refuses if the
   * content changed since the preview. Owner command handlers only.
   */
  async approve(name: string, shownSha256: string, actor: string): Promise<ApproveResult> {
    const now = this.inspect(name);
    if (!now.ok) return { ok: false, reason: now.error };
    if (now.sha256 !== shownSha256) {
      this.deps.audit.record({ feature: "plugins", action: "plugin.approve_refused", actor, detail: { name, reason: "changed during confirmation" } });
      return { ok: false, reason: "the plugin's files changed while you were confirming. Nothing was approved; run the command again." };
    }
    if (this.deps.loader.isLoaded(name)) await this.deps.loader.unload(name);
    const approval: PluginApproval = {
      name,
      version: now.manifest.version,
      sha256: now.sha256,
      capabilities: now.manifest.capabilities,
      events: now.manifest.events,
      enabled: true,
      approvedAt: new Date().toISOString(),
      approvedBy: actor,
      fileCount: now.fileCount,
    };
    this.deps.approvals.upsert(approval);
    this.known.set(name, canonical(approval));
    this.failures.delete(name);
    this.deps.registry.resume(name);
    this.deps.audit.record({
      feature: "plugins",
      action: "plugin.approved",
      actor,
      detail: {
        name, version: approval.version, sha256: approval.sha256, capabilities: approval.capabilities,
        events: approval.events, fileCount: now.fileCount, scanFindings: now.findings.length, blocking: now.blocking,
      },
    });
    if (!this.deps.isEnabled()) return { ok: true, loaded: false, approval };
    this.running = true;
    const loaded = await this.loadApproved(approval, "approve");
    const failure = this.failures.get(name);
    return { ok: true, loaded: loaded !== null, approval, ...(failure ? { error: failure.error } : {}) };
  }

  /** Unload now and set `enabled: false`, keeping the approval record. */
  async disable(name: string, actor: string): Promise<boolean> {
    const wasLoaded = await this.deps.loader.unload(name);
    const existed = this.deps.approvals.setEnabled(name, false);
    if (existed) {
      const rec = this.deps.approvals.get(name);
      if (rec) this.known.set(name, canonical(rec));
    }
    this.failures.delete(name);
    if (existed || wasLoaded) {
      this.deps.audit.record({ feature: "plugins", action: "plugin.disabled", actor, detail: { name, wasLoaded } });
    }
    return existed || wasLoaded;
  }

  /** Re-check the hash and load again (one plugin or every enabled one). Clears a suspension. */
  async reload(name: string | undefined, actor: string): Promise<Array<{ name: string; loaded: boolean; error?: string }>> {
    if (!this.deps.isEnabled()) return [];
    this.running = true;
    this.checkApprovalsFile();
    const targets = this.deps.approvals.list().filter((a) => a.enabled && (name === undefined || a.name === name));
    const out: Array<{ name: string; loaded: boolean; error?: string }> = [];
    for (const rec of targets) {
      await this.deps.loader.unload(rec.name);
      this.deps.registry.resume(rec.name);
      this.failures.delete(rec.name);
      this.deps.audit.record({ feature: "plugins", action: "plugin.reload", actor, detail: { name: rec.name } });
      const loaded = await this.loadApproved(rec, "reload");
      const failure = this.failures.get(rec.name);
      out.push({ name: rec.name, loaded: loaded !== null, ...(failure ? { error: failure.error } : {}) });
    }
    return out;
  }

  /** Called by the hook registry's circuit breaker. */
  handleSuspend(name: string, info: { consecutiveFailures: number; lastError: string }): void {
    this.deps.audit.record({
      feature: "plugins",
      action: "plugin.suspended",
      actor: "system",
      detail: { name, consecutiveFailures: info.consecutiveFailures, lastError: info.lastError },
    });
    void this.notify(
      `Plugin ${name} was suspended after ${info.consecutiveFailures} failed or slow hooks in a row ` +
        `(last error, which may come from the plugin itself: «${oneLine(info.lastError)}»). ` +
        `Its hooks no longer run. Send /plugins reload ${name} to try again, or /plugins disable ${name}.`,
      `plugins:suspended:${name}`,
      false,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async loadApproved(rec: PluginApproval, reason: string): Promise<LoadedPlugin | null> {
    const { name } = rec;
    const cfg = this.deps.settings();
    if (cfg.allow.length > 0 && !cfg.allow.includes(name)) {
      this.failures.set(name, { state: "not-allowed", error: "not listed in plugins.allow" });
      this.deps.audit.record({ feature: "plugins", action: "plugin.load_refused", actor: "system", detail: { name, reason: "not-allowed" } });
      return null;
    }
    if (this.known.get(name) !== canonical(rec)) {
      this.failures.set(name, { state: "unverified", error: "approval record changed outside /plugins" });
      this.deps.audit.record({ feature: "plugins", action: "plugin.load_refused", actor: "system", detail: { name, reason: "unverified-approval" } });
      void this.notify(
        `Plugin ${name} has an approval record that /plugins did not write, so it was not loaded. ` +
          `If you made that change, review the plugin and send /plugins enable ${name}.`,
        `plugins:unverified:${name}:${rec.sha256}`,
      );
      return null;
    }
    const pending = this.deps.loader.load({
      name,
      expectedSha256: rec.sha256,
      approvedCapabilities: rec.capabilities,
      approvedEvents: rec.events,
      config: cfg.config[name] ?? {},
    });
    this.inFlight.add(pending);
    try {
      const loaded = await pending;
      this.failures.delete(name);
      this.deps.audit.record({
        feature: "plugins",
        action: "plugin.loaded",
        actor: "system",
        detail: { name, version: loaded.version, sha256: loaded.sha256, hooks: loaded.hookCount, reason, warnings: loaded.warnings },
      });
      return loaded;
    } catch (err) {
      const e = err instanceof PluginLoadError ? err : new PluginLoadError("import", errText(err));
      const message = scrubSecrets(e.message, { sink: "audit" }).slice(0, 300);
      if (e.code === "hash-mismatch") {
        this.failures.set(name, { state: "changed", error: message });
        this.deps.audit.record({
          feature: "plugins",
          action: "plugin.hash_mismatch",
          actor: "system",
          detail: { name, approvedSha256: rec.sha256, currentSha256: e.detail.sha256 },
        });
        void this.notify(
          `Plugin ${name} changed since you approved it and was not loaded. Review it, then /plugins enable ${name}.`,
          `plugins:changed:${name}:${e.detail.sha256 ?? "?"}`,
        );
      } else {
        this.failures.set(name, { state: "failed", error: message });
        this.deps.audit.record({ feature: "plugins", action: "plugin.load_failed", actor: "system", detail: { name, code: e.code, error: message, reason } });
        void this.notify(
          `Plugin ${name} failed to load (${e.code}). Error text, which may come from the plugin itself: «${oneLine(message)}»`,
          `plugins:failed:${name}:${e.code}:${rec.sha256}`,
        );
      }
      log.warn({ plugin: name, code: e.code }, "plugin not loaded");
      return null;
    } finally {
      this.inFlight.delete(pending);
    }
  }

  private checkApprovalsFile(): void {
    if (!this.deps.approvals.changedSinceLastSeen()) return;
    this.deps.audit.record({ feature: "plugins", action: "approvals.changed_externally", actor: "system" });
    void this.notify(
      "The plugin approvals file was changed outside the /plugins command. Changed or new approvals are not trusted until you approve them again. Send /plugins to review.",
      "plugins:approvals-changed",
      false,
    );
  }

  private statusOf(name: string, approval: PluginApproval | undefined, hasDir: boolean): PluginStatus {
    const loaded = this.deps.loader.get(name);
    const health = this.deps.registry.stats(name);
    const failure = this.failures.get(name);
    let state: PluginState;
    if (loaded) state = health.suspended ? "suspended" : "loaded";
    else if (failure) state = failure.state;
    else if (!approval) state = "not-approved";
    else if (!hasDir) state = "missing";
    else state = approval.enabled ? "approved" : "disabled";
    const lastError = failure?.error ?? health.lastError;
    let peekedVersion: string | undefined;
    if (!loaded && !approval && hasDir) {
      try {
        peekedVersion = peekPluginManifest(this.deps.pluginsDir, name).version;
      } catch {
        peekedVersion = undefined;
      }
    }
    return {
      name,
      state,
      ...(loaded
        ? { version: loaded.version, loadedAt: loaded.loadedAt }
        : approval ? { version: approval.version } : peekedVersion ? { version: peekedVersion } : {}),
      ...(approval ? {
        events: approval.events,
        capabilities: approval.capabilities,
        approvedSha256: approval.sha256,
        approvedAt: approval.approvedAt,
        approvedBy: approval.approvedBy,
      } : loaded ? { events: loaded.events, capabilities: loaded.capabilities } : {}),
      failures: health.totalFailures,
      dropped: health.dropped,
      ...(lastError ? { lastError } : {}),
    };
  }

  /** One owner notice per key per process (when `once`), and the notifier's own rate limit. */
  private async notify(text: string, key: string, once = true): Promise<void> {
    if (once) {
      if (this.notified.has(key)) return;
      this.notified.add(key);
    }
    try {
      await this.deps.notifyOwner(text, { key });
    } catch (err) {
      log.warn({ err: errText(err) }, "owner notice failed");
    }
  }
}

/** Plugin-provided text in an owner notice: one line, bounded, no quote marks that could close the label. */
function oneLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[«»]/g, "\"").slice(0, 200);
}

function canonical(rec: PluginApproval): string {
  return JSON.stringify([
    rec.name, rec.version, rec.sha256, [...rec.capabilities].sort(), [...rec.events].sort(), rec.enabled, rec.approvedAt, rec.approvedBy,
  ]);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
