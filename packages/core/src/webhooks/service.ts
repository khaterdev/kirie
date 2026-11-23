/**
 * WebhookService (PLAN C.6): owns the store, the secret cache, the post-auth
 * limits and the actions, and implements the owner operations behind
 * `/webhook`. The ingress sub-app (`ingress-app.ts`) does the cheap
 * pre-auth checks and calls `handleDelivery`.
 *
 * Security properties this file is responsible for:
 * - A hook cannot exist without a secret: the secret is generated and stored
 *   before the hook is returned; a failed store removes the row again.
 * - Secrets come only from the credential store (`webhook.<id>.secret`) or an
 *   owner-written 0600 import file under `~/.kirie/secrets`. They are held in
 *   memory, registered with the scrubber, and never logged, returned by a
 *   tool, or put in a reply. Reveal is a 0600 file removed after 10 minutes.
 * - Unknown, disabled, unavailable, IP-mismatched, badly signed and stale
 *   requests all produce `not_found`, after the same throwaway HMAC.
 * - The dedupe row is inserted before any action (at most once).
 * - Payload text is data: `notify` makes no model call; `summarize` is a
 *   no-tools one-shot call; `investigate` and `full` are background tasks under
 *   the `webhook` task profile. The delivery target is static per hook.
 */

import { randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AuditTrail } from "../security/audit-trail.js";
import type { WebhooksConfig } from "../config/sections/webhooks.js";
import type { TaskProfile } from "../engine/background-task-manager.js";
import type { BackgroundTask, BackgroundTaskMeta } from "../engine/background-task-store.js";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import {
  createWebhookIngressApp,
  type WebhookDeliveryHandler,
  type WebhookIncomingRequest,
  type WebhookIngressOutcome,
  type WebhookTestBinding,
} from "./ingress-app.js";
import { WebhookRateLimiter, WebhookWorkQueue } from "./limits.js";
import { webhookDedupeKey } from "./replay.js";
import {
  isWebhookPing,
  sampleWebhookPayload,
  webhookEventMatches,
  webhookEventName,
  webhookProviderId,
} from "./sources.js";
import { webhookPrevSecretRef, webhookSecretRef, type NewWebhookInput, type WebhookPatch, type WebhookStore } from "./store.js";
import {
  buildWebhookPrompt,
  cleanWebhookText,
  defangWebhookLinks,
  detectSuspiciousWebhookPayload,
  renderWebhookNotice,
  WEBHOOK_SUMMARY_SYSTEM_PROMPT,
  WEBHOOK_TASK_SYSTEM_PROMPT,
} from "./template.js";
import type { WebhookDefinition, WebhookRejectReason, WebhookToolProfile } from "./types.js";
import {
  assertUsableWebhookSecret,
  burnWebhookVerification,
  signWebhookPayload,
  verifyWebhookRequest,
  type WebhookSecretSet,
} from "./verify.js";

/** The `meta.profile` of webhook background tasks (TaskHooks key). */
export const WEBHOOK_TASK_PROFILE = "webhook";
/** How long a revealed secret file lives. */
export const WEBHOOK_SECRET_FILE_TTL_MS = 10 * 60_000;
/** Maximum rotation grace. */
export const WEBHOOK_MAX_GRACE_MINUTES = 60;
/** A webhook background task that never reports back releases its slot after this. */
const TASK_SLOT_TIMEOUT_MS = 2 * 60 * 60_000;
/** How often a held task slot checks whether its task was cancelled. */
export const WEBHOOK_TASK_SLOT_CHECK_MS = 30_000;
const REJECT_AUDIT_INTERVAL_MS = 5 * 60_000;
const AUTH_ALERT_WINDOW_MS = 60 * 60_000;
const MESSAGE_MAX_CHARS = 3500;

/** Read-only local tools of the `investigate` profile (enforced by the task-profile gate). */
export const WEBHOOK_INVESTIGATE_TOOLS: readonly string[] = [
  "Read", "Grep", "Glob",
  "mcp__kirie-tools__memory_search",
  "mcp__kirie-tools__memory_recall",
  "mcp__kirie-tools__memory_semantic_search",
  "mcp__kirie-tools__memory_list",
  "mcp__kirie-tools__chat_history_search",
];

/** The subset of CredentialStore the service uses. */
export interface WebhookSecretBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface WebhookServiceDeps {
  /** Opened on first use, so a disabled feature never touches the file system */
  openStore(): WebhookStore;
  config(): WebhooksConfig;
  secrets: WebhookSecretBackend;
  /** `scrubber.addKnownSecret` */
  registerKnownSecret(value: string, label: string): void;
  audit?: Pick<AuditTrail, "record" | "recent">;
  /** One line to the owner's primary DM */
  notifyOwner(text: string, opts?: { key?: string }): Promise<void>;
  /** Send to a hook's static target. Returns false when the channel is not running */
  sendToChat(channel: string, chatId: string, text: string): Promise<boolean>;
  /** A no-tools one-shot model call (runOneShot kind "oneshot"). Returns the summary text */
  summarize(input: { system: string; prompt: string; label: string }): Promise<string>;
  /** BackgroundTaskStore.create */
  createTask(sessionKey: string, description: string, prompt: string, meta: BackgroundTaskMeta): { id: string };
  /**
   * Status of a background task (BackgroundTaskStore.get). Completion and
   * failure handlers are not called for a cancelled task, so the slot is also
   * released once the task is no longer pending or running.
   */
  taskStatus?(id: string): string | null;
  /** ~/.kirie/secrets */
  secretsDir: string;
  publicBaseUrl(): string | null;
  trustedIpHeader(): string;
  now?: () => number;
  log?: Logger;
}

export interface WebhookAddInput extends Omit<NewWebhookInput, "action" | "toolProfile"> {
  action?: NewWebhookInput["action"];
  toolProfile?: NewWebhookInput["toolProfile"];
  by: string;
}

export interface WebhookAddResult {
  hook: WebhookDefinition;
  url: string | null;
  secretFile: string;
}

type SecretEntry = { kind: "ok"; set: WebhookSecretSet } | { kind: "unavailable" };

interface RejectCounter {
  times: number[];
  lastAuditAt: number;
  suppressed: number;
  lastAlertAt: number;
}

/** The task profile for a webhook background task (TaskHooks "webhook"). Fails closed to `investigate`. */
export function buildWebhookTaskProfile(
  toolProfile: unknown,
  opts: { fullAllowed: boolean; kirieToolsServer?: NonNullable<Options["mcpServers"]>[string] },
): TaskProfile {
  if (toolProfile === "full" && opts.fullAllowed) {
    return { kind: "webhook" };
  }
  return {
    kind: "webhook",
    toolAllowlist: WEBHOOK_INVESTIGATE_TOOLS,
    systemPrompt: WEBHOOK_TASK_SYSTEM_PROMPT,
    options: {
      tools: ["Read", "Grep", "Glob"],
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 25,
      mcpServers: opts.kirieToolsServer ? { "kirie-tools": opts.kirieToolsServer } : {},
    },
  };
}

export class WebhookService implements WebhookDeliveryHandler {
  private storeInstance: WebhookStore | null = null;
  private readonly secretCache = new Map<string, SecretEntry>();
  private readonly hookLimiters = new Map<string, { limit: number; limiter: WebhookRateLimiter }>();
  private readonly rejects = new Map<string, RejectCounter>();
  private readonly taskSlots = new Map<string, () => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** Revealed secret files and their deletion timers. */
  private readonly secretFiles = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly unavailableNotified = new Set<string>();
  private readonly queue: WebhookWorkQueue;
  private readonly log: Logger;
  private readonly now: () => number;
  private app: ReturnType<typeof createWebhookIngressApp> | null = null;
  private stopped = false;

  constructor(private readonly deps: WebhookServiceDeps) {
    this.log = deps.log ?? createModuleLogger("webhooks");
    this.now = deps.now ?? Date.now;
    this.queue = new WebhookWorkQueue(() => {
      const cfg = this.deps.config();
      return { maxConcurrent: cfg.maxConcurrentTasks, maxQueued: cfg.maxQueuedTasks };
    });
  }

  get store(): WebhookStore {
    if (!this.storeInstance) this.storeInstance = this.deps.openStore();
    return this.storeInstance;
  }

  /** The `/hooks` sub-app, built once from the config at first use. */
  ingressApp(): ReturnType<typeof createWebhookIngressApp> {
    if (!this.app) {
      const cfg = this.deps.config();
      this.app = createWebhookIngressApp({
        handler: this,
        maxBodyBytes: cfg.maxBodyBytes,
        perIpPerMinute: cfg.rateLimit.perIpPerMinute,
        globalPerMinute: cfg.rateLimit.globalPerMinute,
        trustedIpHeader: this.deps.trustedIpHeader(),
        log: this.log,
        now: this.now,
      });
    }
    return this.app;
  }

  /** Public URL of a hook, or null when `ingress.publicBaseUrl` is unset. */
  hookUrl(id: string): string | null {
    const base = this.deps.publicBaseUrl();
    return base ? `${base}/hooks/${id}` : null;
  }

  /**
   * Startup: mark interrupted deliveries failed (told to the owner), prune
   * old rows, and decrypt every hook's secret once (one PBKDF2 each).
   */
  async load(): Promise<void> {
    const interrupted = this.store.failInterruptedDeliveries();
    if (interrupted.length > 0) {
      void this.deps.notifyOwner(
        `${interrupted.length} webhook deliver${interrupted.length === 1 ? "y was" : "ies were"} interrupted by a restart and not run. See /webhook log.`,
        { key: "webhooks:interrupted" },
      );
    }
    this.store.pruneDeliveries(this.deps.config().deliveryRetentionDays, new Date(this.now()));
    for (const hook of this.store.listHooks()) await this.loadSecrets(hook);
  }

  /** Daemon stop: drop queued work and timers, close the database. */
  stop(): void {
    this.stopped = true;
    this.queue.clear();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // A revealed secret never outlives the process: the owner can reveal it again.
    for (const path of [...this.secretFiles.keys()]) this.deleteSecretFile(path);
    for (const release of this.taskSlots.values()) release();
    this.taskSlots.clear();
    this.storeInstance?.close();
    this.storeInstance = null;
  }

  // ── secrets ────────────────────────────────────────────────────────────

  private async loadSecrets(hook: WebhookDefinition): Promise<SecretEntry> {
    try {
      const current = await this.deps.secrets.get(hook.secretRef);
      if (!current) throw new Error("missing");
      assertUsableWebhookSecret(current);
      this.deps.registerKnownSecret(current, `webhook:${hook.id}`);
      const set: WebhookSecretSet = { current };
      if (hook.prevSecretRef && hook.prevSecretExpiresAt) {
        const expiresAt = Date.parse(hook.prevSecretExpiresAt);
        if (Number.isFinite(expiresAt) && expiresAt > this.now()) {
          const prev = await this.deps.secrets.get(hook.prevSecretRef);
          if (prev) {
            this.deps.registerKnownSecret(prev, `webhook:${hook.id}:previous`);
            set.previous = prev;
            set.previousExpiresAtMs = expiresAt;
            this.schedulePrevExpiry(hook.id, expiresAt);
          }
        } else {
          await this.dropPrevious(hook.id);
        }
      }
      const entry: SecretEntry = { kind: "ok", set };
      this.secretCache.set(hook.id, entry);
      this.unavailableNotified.delete(hook.id);
      return entry;
    } catch {
      const entry: SecretEntry = { kind: "unavailable" };
      this.secretCache.set(hook.id, entry);
      this.log.warn({ hookId: hook.id }, "webhook secret unavailable; the hook answers 404");
      if (!this.unavailableNotified.has(hook.id)) {
        this.unavailableNotified.add(hook.id);
        void this.deps.notifyOwner(
          `Webhook ${hook.name}: its secret could not be read from the credential store, so it answers 404. Check the credential store, then /webhook rotate-secret ${hook.id}.`,
          { key: `webhooks:unavailable:${hook.id}` },
        );
      }
      return entry;
    }
  }

  private async secretsFor(hook: WebhookDefinition): Promise<SecretEntry> {
    return this.secretCache.get(hook.id) ?? this.loadSecrets(hook);
  }

  private schedulePrevExpiry(hookId: string, expiresAtMs: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.dropPrevious(hookId);
    }, Math.max(0, expiresAtMs - this.now()));
    t.unref?.();
    this.timers.add(t);
  }

  private async dropPrevious(hookId: string): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deps.secrets.delete(webhookPrevSecretRef(hookId));
    } catch (err) {
      this.log.warn({ hookId, err: err instanceof Error ? err.message : String(err) }, "could not delete a previous webhook secret");
    }
    const entry = this.secretCache.get(hookId);
    if (entry?.kind === "ok") this.secretCache.set(hookId, { kind: "ok", set: { current: entry.set.current } });
    if (this.store.getHook(hookId)) this.store.updateHook(hookId, { prevSecretRef: null, prevSecretExpiresAt: null });
  }

  private newSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  /** Path of the 0600 file a revealed secret is written to. */
  secretFilePath(id: string): string {
    return join(this.deps.secretsDir, `webhook-${id}.txt`);
  }

  /** Path of the owner-written file `rotate-secret <id> from-file` imports. */
  importFilePath(id: string): string {
    return join(this.deps.secretsDir, `webhook-${id}.import`);
  }

  private ensureSecretsDir(): void {
    mkdirSync(this.deps.secretsDir, { recursive: true, mode: 0o700 });
    chmodSync(this.deps.secretsDir, 0o700);
  }

  /** Write the current secret to a 0600 file, removed after 10 minutes. Returns the path. */
  async revealSecretToFile(id: string, by: string): Promise<string> {
    const hook = this.requireHook(id);
    const entry = await this.secretsFor(hook);
    if (entry.kind !== "ok") throw new Error("The secret of this hook is unavailable");
    this.ensureSecretsDir();
    const path = this.secretFilePath(hook.id);
    this.deleteSecretFile(path);
    writeFileSync(path, `${entry.set.current}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    this.scheduleSecretFileDeletion(path, WEBHOOK_SECRET_FILE_TTL_MS);
    this.audit("secret.revealed", by, { hookId: hook.id, via: "file" });
    return path;
  }

  private scheduleSecretFileDeletion(path: string, delayMs: number): void {
    const t = setTimeout(() => this.deleteSecretFile(path), Math.max(0, delayMs));
    t.unref?.();
    this.secretFiles.set(path, t);
  }

  private deleteSecretFile(path: string): void {
    const t = this.secretFiles.get(path);
    if (t) clearTimeout(t);
    this.secretFiles.delete(path);
    try { if (existsSync(path)) unlinkSync(path); } catch { /* already gone */ }
  }

  /**
   * Startup: remove revealed secret files a previous process left behind
   * (older than the 10-minute window), and schedule the younger ones. Runs
   * whether or not webhooks are on.
   */
  sweepSecretFiles(): void {
    let names: string[];
    try {
      names = readdirSync(this.deps.secretsDir);
    } catch {
      return;
    }
    const nowMs = this.now();
    for (const name of names) {
      if (!/^webhook-[a-z0-9-]+\.txt$/.test(name)) continue;
      const path = join(this.deps.secretsDir, name);
      try {
        const age = nowMs - lstatSync(path).mtimeMs;
        if (age >= WEBHOOK_SECRET_FILE_TTL_MS) this.deleteSecretFile(path);
        else this.scheduleSecretFileDeletion(path, WEBHOOK_SECRET_FILE_TTL_MS - age);
      } catch { /* gone meanwhile */ }
    }
  }

  // ── owner operations ───────────────────────────────────────────────────

  requireHook(idOrName: string): WebhookDefinition {
    const hook = this.store.findHook(idOrName);
    if (!hook) throw new Error(`No hook "${idOrName}". See /webhook list.`);
    return hook;
  }

  /** Creates a disabled hook with a fresh secret, revealed to a 0600 file. */
  async addHook(input: WebhookAddInput): Promise<WebhookAddResult> {
    const cfg = this.deps.config();
    const toolProfile = input.toolProfile ?? cfg.defaultToolProfile;
    if (toolProfile === "full") throw new Error("tools=full cannot be set at creation. Create the hook, then use /webhook set <id> tools=full.");
    const hook = this.store.createHook({
      name: input.name,
      source: input.source,
      action: input.action ?? cfg.defaultAction,
      toolProfile,
      events: input.events,
      instructions: input.instructions,
      fields: input.fields,
      channel: input.channel,
      chatId: input.chatId,
    }, new Date(this.now()));
    const secret = this.newSecret();
    try {
      await this.deps.secrets.set(webhookSecretRef(hook.id), secret);
    } catch (err) {
      this.store.deleteHook(hook.id);
      throw new Error(`Could not store the hook secret, so the hook was not created: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.deps.registerKnownSecret(secret, `webhook:${hook.id}`);
    this.secretCache.set(hook.id, { kind: "ok", set: { current: secret } });
    const secretFile = await this.revealSecretToFile(hook.id, input.by);
    this.audit("hook.created", input.by, { hookId: hook.id, source: hook.source, action: hook.action, toolProfile: hook.toolProfile });
    return { hook, url: this.hookUrl(hook.id), secretFile };
  }

  async setHookEnabled(idOrName: string, enabled: boolean, by: string): Promise<WebhookDefinition> {
    const hook = this.requireHook(idOrName);
    if (enabled) {
      const entry = await this.loadSecrets(hook);
      if (entry.kind !== "ok") throw new Error("The secret of this hook is unavailable; it cannot be enabled. Try /webhook rotate-secret.");
    }
    const updated = this.store.updateHook(hook.id, { enabled }, new Date(this.now()))!;
    this.audit(enabled ? "hook.enabled" : "hook.disabled", by, { hookId: hook.id });
    return updated;
  }

  updateHook(idOrName: string, patch: WebhookPatch, by: string): WebhookDefinition {
    const hook = this.requireHook(idOrName);
    if (patch.toolProfile === "full" && !this.deps.config().allowFullProfile) {
      throw new Error("tools=full needs webhooks.allowFullProfile: true in config.yaml first.");
    }
    const updated = this.store.updateHook(hook.id, patch, new Date(this.now()))!;
    if (patch.ratePerMin !== undefined) this.hookLimiters.delete(hook.id);
    this.audit("hook.updated", by, { hookId: hook.id, keys: Object.keys(patch) });
    return updated;
  }

  /** Deletes the hook and its credentials. Delivery rows stay for the retention window. */
  async removeHook(idOrName: string, by: string): Promise<WebhookDefinition> {
    const hook = this.requireHook(idOrName);
    this.store.deleteHook(hook.id);
    this.secretCache.delete(hook.id);
    this.hookLimiters.delete(hook.id);
    for (const key of [hook.secretRef, webhookPrevSecretRef(hook.id)]) {
      try { await this.deps.secrets.delete(key); } catch { /* reported below if the main key stays */ }
    }
    this.deleteSecretFile(this.secretFilePath(hook.id));
    try { if (existsSync(this.importFilePath(hook.id))) unlinkSync(this.importFilePath(hook.id)); } catch { /* best effort */ }
    this.audit("hook.removed", by, { hookId: hook.id });
    return hook;
  }

  /**
   * New secret (generated, or imported from the owner's 0600 import file).
   * The old one stays valid for `graceMinutes` (0 to 60), then is deleted.
   */
  async rotateSecret(idOrName: string, opts: { graceMinutes: number; fromFile: boolean; by: string }): Promise<{ hook: WebhookDefinition; secretFile: string | null }> {
    const hook = this.requireHook(idOrName);
    const grace = Math.max(0, Math.min(WEBHOOK_MAX_GRACE_MINUTES, Math.floor(opts.graceMinutes)));
    const secret = opts.fromFile ? this.readImportFile(hook.id) : this.newSecret();
    assertUsableWebhookSecret(secret);
    const old = this.secretCache.get(hook.id);
    const nowMs = this.now();
    if (grace > 0 && old?.kind === "ok") {
      await this.deps.secrets.set(webhookPrevSecretRef(hook.id), old.set.current);
    }
    await this.deps.secrets.set(hook.secretRef, secret);
    this.deps.registerKnownSecret(secret, `webhook:${hook.id}`);
    const set: WebhookSecretSet = { current: secret };
    if (grace > 0 && old?.kind === "ok") {
      const expiresAt = nowMs + grace * 60_000;
      set.previous = old.set.current;
      set.previousExpiresAtMs = expiresAt;
      this.store.updateHook(hook.id, { prevSecretRef: webhookPrevSecretRef(hook.id), prevSecretExpiresAt: new Date(expiresAt).toISOString() });
      this.schedulePrevExpiry(hook.id, expiresAt);
    } else {
      try { await this.deps.secrets.delete(webhookPrevSecretRef(hook.id)); } catch { /* none stored */ }
      this.store.updateHook(hook.id, { prevSecretRef: null, prevSecretExpiresAt: null });
    }
    this.secretCache.set(hook.id, { kind: "ok", set });
    this.unavailableNotified.delete(hook.id);
    const secretFile = opts.fromFile ? null : await this.revealSecretToFile(hook.id, opts.by);
    this.audit("secret.rotated", opts.by, { hookId: hook.id, graceMinutes: grace, imported: opts.fromFile });
    return { hook: this.store.getHook(hook.id)!, secretFile };
  }

  private readImportFile(id: string): string {
    const path = this.importFilePath(id);
    if (!existsSync(path)) throw new Error(`Write the secret to ${path} (mode 0600) first.`);
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error("The import path is not a regular file.");
    if ((st.mode & 0o077) !== 0) throw new Error(`${path} must be mode 0600 (chmod 600). Nothing was imported.`);
    const value = readFileSync(path, "utf8").trim();
    unlinkSync(path);
    return value;
  }

  /** `/webhook forget <delivery>`. */
  forgetDelivery(id: number, by: string): boolean {
    const ok = this.store.forgetDelivery(id);
    if (ok) this.audit("delivery.forgotten", by, { deliveryId: id });
    return ok;
  }

  /** Auth failures per hook id ("unknown" for ids that do not exist) in the window. */
  rejectCounts(windowMs = 86_400_000): Record<string, number> {
    const since = this.now() - windowMs;
    const out: Record<string, number> = {};
    for (const [key, c] of this.rejects) {
      const n = c.times.filter((t) => t >= since).length;
      if (n > 0) out[key] = n;
    }
    return out;
  }

  /** Work running and queued (summaries and webhook tasks). */
  workload(): { active: number; queued: number } {
    return { active: this.queue.active, queued: this.queue.queued };
  }

  /**
   * `/webhook test <id> [run]`: sign a sample payload with the real secret and
   * send it through the real ingress app in process. Without `run`, nothing is
   * stored and no action runs; the report shows every stage.
   */
  async testHook(idOrName: string, opts: { run: boolean }): Promise<string[]> {
    const hook = this.requireHook(idOrName);
    const entry = await this.secretsFor(hook);
    if (entry.kind !== "ok") return ["secret: unavailable (the hook answers 404)"];
    const sample = sampleWebhookPayload(hook.source);
    const raw = Buffer.from(JSON.stringify(sample.body), "utf8");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(raw.byteLength),
      ...sample.headers,
      ...signWebhookPayload(hook.source, entry.set.current, raw, { timestampSeconds: Math.floor(this.now() / 1000) }),
    };
    const binding: WebhookTestBinding = { kirieWebhookTest: { dryRun: !opts.run, report: [] } };
    const res = await this.ingressApp().fetch(
      new Request(`http://127.0.0.1/hooks/${hook.id}`, { method: "POST", headers, body: raw }),
      binding,
    );
    return [`ingress: HTTP ${res.status}`, ...binding.kirieWebhookTest.report];
  }

  // ── deliveries ─────────────────────────────────────────────────────────

  async handleDelivery(req: WebhookIncomingRequest, test?: WebhookTestBinding["kirieWebhookTest"]): Promise<WebhookIngressOutcome> {
    const report = (line: string): void => { test?.report.push(line); };
    let hook: WebhookDefinition | null;
    let entry: SecretEntry | null = null;
    try {
      hook = this.store.getHook(req.hookId);
      if (hook && (hook.enabled || test?.dryRun)) entry = await this.secretsFor(hook);
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "webhook lookup failed");
      burnWebhookVerification(req.rawBody);
      return { status: "not_found" };
    }

    if (!hook) return this.reject(req, null, "unknown_hook");
    if (!hook.enabled && !test?.dryRun) return this.reject(req, hook, "disabled");
    if (!hook.enabled) report("hook: disabled (a real delivery gets 404 until /webhook enable)");
    if (!entry || entry.kind !== "ok") return this.reject(req, hook, "unavailable");
    if (hook.ipAllowlist.length > 0 && !webhookIpAllowed(hook.ipAllowlist, req.clientIp)) {
      return this.reject(req, hook, "ip_not_allowed");
    }

    const nowMs = this.now();
    const verified = verifyWebhookRequest(hook.source, req, entry.set, {
      nowMs,
      toleranceSeconds: this.deps.config().timestampToleranceSeconds,
    });
    if (!verified.ok) {
      report(`signature: ${verified.reason}`);
      return this.reject(req, hook, verified.reason, verified.skewSeconds);
    }
    report(`signature: ok (${hook.source}${verified.usedPrevious ? ", previous secret" : ""})`);

    // Authenticated from here on.
    let payload: unknown;
    let parsed = true;
    try {
      payload = JSON.parse(req.rawBody.toString("utf8")) as unknown;
    } catch {
      parsed = false;
    }
    const event = parsed ? webhookEventName(hook.source, req.headers, payload) : null;
    const receivedAt = new Date(nowMs).toISOString();

    if (test?.dryRun) {
      return this.dryRun(hook, event, payload, parsed, report);
    }

    if (!hook.verifiedAt) this.store.markVerified(hook.id, new Date(nowMs));
    const claim = this.store.claimDelivery({
      hookId: hook.id,
      dedupeKey: webhookDedupeKey(hook.source, hook.id, req.rawBody, verified),
      providerId: webhookProviderId(hook.source, req.headers),
      event,
      bodyBytes: req.rawBody.byteLength,
      remoteIp: req.clientIp,
      receivedAt,
    });
    if (!claim.claimed) return { status: "duplicate" };
    const deliveryId = claim.id;

    if (!parsed) {
      this.store.updateDelivery(deliveryId, { status: "failed", note: "body is not JSON (set the provider's content type to application/json)" });
      return { status: "bad_request" };
    }
    if (isWebhookPing(hook.source, event)) {
      this.store.updateDelivery(deliveryId, { status: "ping" });
      void this.deps.notifyOwner(`Webhook ${hook.name}: the provider's ping arrived and was verified.`, { key: `webhooks:ping:${hook.id}` });
      return { status: "pong" };
    }
    if (!webhookEventMatches(hook.events, event)) {
      this.store.updateDelivery(deliveryId, { status: "ignored", note: "event filter" });
      return { status: "ignored" };
    }

    const throttle = this.postAuthLimit(hook, nowMs);
    if (throttle) {
      this.store.updateDelivery(deliveryId, { status: "throttled", note: throttle });
      void this.deps.notifyOwner(`Webhook ${hook.name} is throttled (${throttle}). Deliveries are refused with 429 for now.`, { key: `webhooks:throttle:${hook.id}` });
      return { status: "throttled" };
    }

    setImmediate(() => {
      void this.runAction(hook, deliveryId, event, payload, receivedAt).catch((err: unknown) => {
        this.log.warn({ hookId: hook.id, deliveryId, err: err instanceof Error ? err.message : String(err) }, "webhook action failed");
        this.markDelivery(deliveryId, { status: "failed", note: "action failed" });
      });
    });
    return { status: "accepted", delivery: deliveryId };
  }

  private dryRun(hook: WebhookDefinition, event: string | null, payload: unknown, parsed: boolean, report: (line: string) => void): WebhookIngressOutcome {
    if (!parsed) {
      report("body: not JSON (a real delivery gets 400)");
      return { status: "bad_request" };
    }
    report(`event: ${event ?? "(none)"}`);
    if (isWebhookPing(hook.source, event)) {
      report("ping: a real delivery gets 200 pong");
      return { status: "test_ok" };
    }
    if (!webhookEventMatches(hook.events, event)) {
      report(`filter: event not in [${hook.events.join(", ")}] (a real delivery gets 200 ignored)`);
      return { status: "test_ok" };
    }
    const plan = this.plan(hook, payload);
    report(`action: ${plan.mode}${plan.warning ? ` (${plan.warning})` : ""}`);
    if (plan.mode === "notify") {
      report("message:");
      report(renderWebhookNotice({ hook, event, deliveryId: 0, payload, maxFieldChars: this.deps.config().maxFieldChars }));
    } else {
      const cfg = this.deps.config();
      const { prompt } = buildWebhookPrompt({
        hook, event, deliveryId: 0, receivedAt: new Date(this.now()).toISOString(), payload,
        maxFieldChars: cfg.maxFieldChars, maxPayloadChars: Math.min(cfg.maxPayloadChars, 1500),
      });
      report("prompt:");
      report(prompt);
    }
    return { status: "test_ok" };
  }

  private reject(req: WebhookIncomingRequest, hook: WebhookDefinition | null, reason: WebhookRejectReason, skewSeconds?: number): WebhookIngressOutcome {
    // Same HMAC work whether or not the hook exists: verification already did it for these three.
    if (reason !== "bad_signature" && reason !== "missing_timestamp" && reason !== "stale_timestamp") {
      burnWebhookVerification(req.rawBody);
    }
    const key = hook?.id ?? "unknown";
    const nowMs = this.now();
    let c = this.rejects.get(key);
    if (!c) {
      if (this.rejects.size >= 1000) this.rejects.delete(this.rejects.keys().next().value!);
      c = { times: [], lastAuditAt: 0, suppressed: 0, lastAlertAt: 0 };
      this.rejects.set(key, c);
    }
    c.times.push(nowMs);
    const dayAgo = nowMs - 86_400_000;
    while (c.times.length > 0 && (c.times[0]! < dayAgo || c.times.length > 5000)) c.times.shift();

    if (nowMs - c.lastAuditAt >= REJECT_AUDIT_INTERVAL_MS) {
      this.deps.audit?.record({
        feature: "webhooks",
        action: "delivery.rejected",
        actor: `webhook:${key}`,
        detail: { reason, suppressed: c.suppressed, ...(skewSeconds !== undefined ? { skewSeconds } : {}), bodyBytes: req.rawBody.byteLength },
      });
      c.lastAuditAt = nowMs;
      c.suppressed = 0;
    } else {
      c.suppressed += 1;
    }

    if (hook) {
      const threshold = this.deps.config().authFailureAlertThreshold;
      const lastHour = c.times.filter((t) => t >= nowMs - AUTH_ALERT_WINDOW_MS).length;
      if (lastHour >= threshold && nowMs - c.lastAlertAt >= AUTH_ALERT_WINDOW_MS) {
        c.lastAlertAt = nowMs;
        void this.deps.notifyOwner(
          `Webhook ${hook.name}: ${lastHour} refused requests in the last hour (latest: ${reason}). See /webhook log ${hook.id}.`,
          { key: `webhooks:auth:${hook.id}` },
        );
      }
    }
    return { status: "not_found" };
  }

  /** Per-hook rate, daily cap, and room for model work. Returns a reason when over a limit. */
  private postAuthLimit(hook: WebhookDefinition, nowMs: number): string | null {
    const cfg = this.deps.config();
    const perMin = hook.ratePerMin ?? cfg.rateLimit.perHookPerMinute;
    let lim = this.hookLimiters.get(hook.id);
    if (!lim || lim.limit !== perMin) {
      lim = { limit: perMin, limiter: new WebhookRateLimiter({ limit: perMin, windowMs: 60_000, maxKeys: 1 }) };
      this.hookLimiters.set(hook.id, lim);
    }
    if (!lim.limiter.take(hook.id, nowMs)) return `more than ${perMin} per minute`;
    const daily = hook.dailyCap ?? cfg.rateLimit.perHookPerDay;
    // The row being processed is already counted (status accepted).
    if (this.store.countActionsSince(hook.id, new Date(nowMs - 86_400_000)) > daily) return `daily cap of ${daily} reached`;
    if (hook.action === "task" && !this.queue.hasRoom()) return "too many webhook tasks running or queued";
    return null;
  }

  /** What a delivery will do, after the suspicious-payload policy. */
  private plan(hook: WebhookDefinition, payload: unknown): { mode: "notify" | WebhookToolProfile; warning?: string } {
    if (hook.action === "notify") return { mode: "notify" };
    const cfg = this.deps.config();
    let profile: WebhookToolProfile = hook.toolProfile;
    let warning: string | undefined;
    if (profile === "full" && !(cfg.allowFullProfile && hook.allowFull)) {
      profile = "summarize";
      warning = "full profile not allowed now, summarized instead";
    }
    if (detectSuspiciousWebhookPayload(payload).length > 0 && cfg.onSuspiciousPayload !== "proceed") {
      if (cfg.onSuspiciousPayload === "drop") {
        return { mode: "notify", warning: "Warning: this payload contains instruction-like text; no model saw it." };
      }
      if (profile !== "summarize") {
        profile = "summarize";
        warning = "Warning: this payload contains instruction-like text; it was summarized with no tools.";
      } else {
        warning = "Warning: this payload contains instruction-like text.";
      }
    }
    return warning ? { mode: profile, warning } : { mode: profile };
  }

  private async send(hook: WebhookDefinition, text: string): Promise<boolean> {
    try {
      return await this.deps.sendToChat(hook.channel, hook.chatId, scrubSecrets(text, { sink: "channel" }));
    } catch (err) {
      this.log.warn({ hookId: hook.id, err: err instanceof Error ? err.message : String(err) }, "webhook message failed");
      return false;
    }
  }

  private async runAction(hook: WebhookDefinition, deliveryId: number, event: string | null, payload: unknown, receivedAt: string): Promise<void> {
    if (this.stopped) return;
    const cfg = this.deps.config();
    const plan = this.plan(hook, payload);
    if (plan.mode === "notify") {
      const text = renderWebhookNotice({ hook, event, deliveryId, payload, maxFieldChars: cfg.maxFieldChars, warning: plan.warning });
      const sent = await this.send(hook, text);
      this.markDelivery(deliveryId, sent ? { status: "done" } : { status: "failed", note: "owner channel not running" });
      return;
    }

    const { prompt } = buildWebhookPrompt({
      hook, event, deliveryId, receivedAt, payload, maxFieldChars: cfg.maxFieldChars, maxPayloadChars: cfg.maxPayloadChars,
    });
    const header = `${plan.warning ? `${plan.warning}\n` : ""}Webhook ${hook.name}${event ? ` (${event})` : ""}`;

    if (plan.mode === "summarize") {
      const offered = this.queue.offer(async () => {
        if (this.stopped) return;
        try {
          const summary = await this.deps.summarize({ system: WEBHOOK_SUMMARY_SYSTEM_PROMPT, prompt, label: `webhook ${hook.id} #${deliveryId}` });
          const sent = await this.send(hook, `${header}:\n${cleanWebhookText(summary, MESSAGE_MAX_CHARS)}`);
          this.markDelivery(deliveryId, sent ? { status: "done" } : { status: "failed", note: "owner channel not running" });
        } catch (err) {
          this.log.warn({ hookId: hook.id, deliveryId, err: err instanceof Error ? err.name : "error" }, "webhook summary failed");
          this.markDelivery(deliveryId, { status: "failed", note: "summary failed" });
          await this.send(hook, `${header}: the summary failed. Delivery ${deliveryId} is in /webhook log.`);
        }
      });
      if (!offered) this.markDelivery(deliveryId, { status: "failed", note: "queue full" });
      return;
    }

    const toolProfile = plan.mode;
    const offered = this.queue.offer(() => new Promise<void>((resolve) => {
      if (this.stopped) { resolve(); return; }
      let task: { id: string };
      try {
        task = this.deps.createTask(
          `${hook.channel}:dm:${hook.chatId}`,
          `webhook ${hook.name}${event ? ` ${event}` : ""}`.slice(0, 120),
          prompt,
          { origin: "webhook", profile: WEBHOOK_TASK_PROFILE, data: { hookId: hook.id, deliveryId, toolProfile } },
        );
      } catch (err) {
        this.log.warn({ hookId: hook.id, deliveryId, err: err instanceof Error ? err.message : String(err) }, "webhook task could not be created");
        this.markDelivery(deliveryId, { status: "failed", note: "task could not be created" });
        resolve();
        return;
      }
      this.markDelivery(deliveryId, { status: "done", taskId: task.id });
      const timer = setTimeout(() => release(), TASK_SLOT_TIMEOUT_MS);
      timer.unref?.();
      const check = setInterval(() => {
        const lookup = this.deps.taskStatus;
        if (!lookup) return;
        let status: string | null;
        try { status = lookup(task.id); } catch { return; }
        if (status !== "pending" && status !== "running") release();
      }, WEBHOOK_TASK_SLOT_CHECK_MS);
      check.unref?.();
      const release = (): void => {
        clearTimeout(timer);
        clearInterval(check);
        this.taskSlots.delete(task.id);
        resolve();
      };
      this.taskSlots.set(task.id, release);
    }));
    if (!offered) this.markDelivery(deliveryId, { status: "failed", note: "queue full" });
  }

  /** TaskHooks completion handler for profile "webhook". */
  async onTaskCompleted(task: BackgroundTask): Promise<void> {
    await this.reportTask(task, true);
  }

  /** TaskHooks failure handler for profile "webhook". */
  async onTaskFailed(task: BackgroundTask): Promise<void> {
    await this.reportTask(task, false);
  }

  private async reportTask(task: BackgroundTask, ok: boolean): Promise<void> {
    this.taskSlots.get(task.id)?.();
    const hookId = typeof task.meta?.data?.hookId === "string" ? task.meta.data.hookId : null;
    const deliveryId = typeof task.meta?.data?.deliveryId === "number" ? task.meta.data.deliveryId : null;
    const hook = hookId ? this.store.getHook(hookId) : null;
    if (!ok && deliveryId !== null) this.markDelivery(deliveryId, { status: "failed", note: "task failed" });
    const name = hook?.name ?? hookId ?? "unknown";
    // The task could read local files: links in its words are defanged so no preview fetches them.
    const body = defangWebhookLinks(ok
      ? cleanWebhookText(task.result ?? "(no result)", MESSAGE_MAX_CHARS)
      : `failed: ${cleanWebhookText(task.error ?? "unknown error", 300)}`);
    const text = `Webhook ${name} task ${task.id.slice(0, 8)}${ok ? " finished" : ""} (links defanged):\n${body}`;
    if (hook) {
      await this.send(hook, text);
    } else {
      await this.deps.notifyOwner(text);
    }
  }

  /** Delivery updates from async work; a no-op after stop() so a late job never reopens the database. */
  private markDelivery(id: number, patch: Parameters<WebhookStore["updateDelivery"]>[1]): void {
    if (!this.stopped) this.store.updateDelivery(id, patch);
  }

  private audit(action: string, actor: string, detail: Record<string, unknown>): void {
    this.deps.audit?.record({ feature: "webhooks", action, actor, detail });
  }
}

/** Client IP inside one of the CIDRs (or exact addresses). A missing IP never matches. */
export function webhookIpAllowed(allowlist: readonly string[], ip: string | null): boolean {
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const [addr, prefixRaw] = entry.split("/");
    const fam = isIP(addr ?? "");
    if (fam === 0) continue;
    const type = fam === 6 ? "ipv6" : "ipv4";
    if (prefixRaw === undefined) list.addAddress(addr!, type);
    else {
      const prefix = Number(prefixRaw);
      if (Number.isInteger(prefix) && prefix >= 0 && prefix <= (fam === 6 ? 128 : 32)) list.addSubnet(addr!, prefix, type);
    }
  }
  return list.check(ip, family === 6 ? "ipv6" : "ipv4");
}

/** Validates a CIDR list for `/webhook set ip=`. Returns the bad entry or null. */
export function invalidWebhookCidr(entries: readonly string[]): string | null {
  for (const entry of entries) {
    const [addr, prefixRaw, extra] = entry.split("/");
    const fam = isIP(addr ?? "");
    if (fam === 0 || extra !== undefined) return entry;
    if (prefixRaw !== undefined) {
      const prefix = Number(prefixRaw);
      if (!/^\d{1,3}$/.test(prefixRaw) || prefix > (fam === 6 ? 128 : 32)) return entry;
    }
  }
  return null;
}
