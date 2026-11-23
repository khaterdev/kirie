/**
 * VoiceService: readiness per provider, the runtime switch, provider
 * selection, outbound calls with caps and approval, hangup, and the status
 * report (PLAN C.14).
 *
 * - Voice is usable only when `voice.enabled` is true in config, the runtime
 *   switch (`voice.switch`, default on) is on, and the ACTIVE provider is
 *   ready. The other provider needs nothing and mounts nothing.
 * - Exactly one provider is active: `voice.provider` in config, overridden by
 *   `/voice provider` (RuntimeSettings `voice.provider`). Switching is refused
 *   while a call is live or when the target is not ready; on success only the
 *   new provider's routes are mounted on the ingress.
 * - Outbound calls go only to configured aliases (plus "me"); "talk" only to
 *   owner numbers; at most 1000 characters; caps are checked before dialling;
 *   agent-initiated calls follow `outbound.agentCalls` (default "ask": one
 *   owner approval per call, denied on timeout).
 * - Nothing here prints or returns a credential or the PIN.
 */

import type { Hono } from "hono";
import {
  VOICE_SETTING_KEYS,
  VoiceProviderSettingSchema,
  VoiceSwitchSettingSchema,
  createModuleLogger,
  type AuditTrail,
  type OwnerPrompts,
  type RuntimeSettings,
  type VoiceConfig,
} from "@kirie/core";
import {
  VOICE_PROVIDER_NAMES,
  isE164,
  lastFour,
  maskNumber,
  type CallRecord,
  type CallStore,
  type VoiceCallProvider,
  type VoiceFetch,
  type VoiceProviderName,
} from "@kirie/voice";
import { VoiceAdapter } from "./adapter.js";
import { buildVoiceProviders, type VoiceCredentials } from "./credentials.js";
import { VoiceCallFlow } from "./flow.js";
import { resolveVoiceReadiness, type VoiceReadiness } from "./readiness.js";
import { createVoiceRoutes } from "./routes.js";
import { LiveCallRegistry, type LiveCall } from "./session.js";

type Logger = ReturnType<typeof createModuleLogger>;
type TimerHandle = ReturnType<typeof setTimeout>;

export const VOICE_MAX_MESSAGE_CHARS = 1000;
/** Upper bound on the owner-approval wait for an agent-initiated call. */
export const VOICE_MAX_APPROVAL_MS = 600_000;

export interface VoiceIngress {
  mount(prefix: string, app: { fetch(req: Request): Response | Promise<Response> }): void;
  unmount(prefix: string): void;
  mountedPrefixes(): string[];
  ensureStarted(): Promise<void>;
  stopIfIdle(): Promise<void>;
  readonly publicBaseUrl: string | null;
}

export interface VoiceServiceDeps {
  config: VoiceConfig;
  /** Resolves every voice secret through the one rule. Called at create() and on reload(). */
  loadCredentials(): Promise<VoiceCredentials>;
  fetch?: VoiceFetch;
  ingress: VoiceIngress;
  settings: Pick<RuntimeSettings, "get" | "set" | "delete">;
  store: CallStore;
  approvals: Pick<OwnerPrompts, "requestApproval">;
  notifyOwner(text: string, opts?: { key?: string }): Promise<void>;
  audit?: Pick<AuditTrail, "record">;
  pipeline: { isBusy(sessionKey: string): boolean; addNextTurnNote(sessionKey: string, note: string): void };
  /** Voice became active or inactive: register the adapter, owner identities, the tool flag. */
  onActiveChange?(active: boolean): void | Promise<void>;
  /** Register provider secrets with the scrubber. */
  addKnownSecret?(value: string, label: string): void;
  log?: Logger;
  now?: () => number;
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export type PlaceCallRequest = {
  alias: string;
  text: string;
  mode: "say" | "talk";
  requestedBy: "owner-command" | "agent-tool";
  /** "owner:telegram:<id>" or "agent:<sessionKey>" for the audit trail. */
  actor?: string;
};

export type PlaceCallResult =
  | { ok: true; callId: string; provider: VoiceProviderName; status: string }
  | { ok: false; reason: string };

export interface VoiceCallView {
  callId: string;
  provider: VoiceProviderName;
  direction: "inbound" | "outbound";
  mode: string;
  to: string;
  state: string;
  live: boolean;
  durationSeconds?: number;
  turns: number;
  endReason?: string;
  createdAt: string;
  /**
   * A one-way reply or voicemail was captured. Its text is never in this view:
   * views reach the agent (voice_call_status, voice_call_list), and those
   * transcripts never enter an agent prompt (PLAN E.7). The owner gets the
   * text in the DM when the call ends.
   */
  replyCaptured?: true;
}

const PROVIDER_LABEL: Record<VoiceProviderName, string> = { twilio: "Twilio", plivo: "Plivo" };
const RAW_NUMBER_RE = /^[+\d(][\d\s\-().]{5,}$/;

/** Alias, or the stored number shown masked (non-owner numbers are stored masked already). */
function displayRemote(rec: CallRecord): string {
  if (rec.alias) return rec.alias;
  return rec.remote.startsWith("+") ? maskNumber(rec.remote) : rec.remote;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export class VoiceService {
  readonly live = new LiveCallRegistry();
  readonly flow: VoiceCallFlow;
  readonly adapter: VoiceAdapter;
  private readonly d: VoiceServiceDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private creds: VoiceCredentials;
  private providers: Record<VoiceProviderName, VoiceCallProvider>;
  private readonly routeApps = new Map<VoiceProviderName, Hono>();
  private readonly lastValid: Record<VoiceProviderName, number | null> = { twilio: null, plivo: null };
  private rejectedSinceAudit = 0;
  private lastRejectAudit = 0;
  private lastActive: boolean | null = null;

  private constructor(deps: VoiceServiceDeps, creds: VoiceCredentials) {
    this.d = deps;
    this.log = deps.log ?? createModuleLogger("voice");
    this.now = deps.now ?? Date.now;
    this.creds = creds;
    this.providers = buildVoiceProviders(deps.config, creds, deps.fetch ? { fetch: deps.fetch } : {});
    this.registerSecrets();
    this.adapter = new VoiceAdapter({
      deliverReply: (ref, text) => this.flow.deliverReply(ref, text),
      forwardToOwner: (text) => this.d.notifyOwner(text),
      notReadyReason: () => {
        const r = this.readiness();
        return r.ready ? null : `not ready: ${r.missing.join(", ")}`;
      },
      maxTextLength: 100_000,
    });
    this.flow = new VoiceCallFlow({
      config: () => this.d.config,
      provider: (name) => this.providers[name],
      publicBaseUrl: () => this.d.ingress.publicBaseUrl,
      live: this.live,
      store: deps.store,
      pin: () => this.creds.pin,
      acceptsCalls: (name) => this.isActive() && this.activeProvider() === name,
      emitTurn: (turn) => this.adapter.emitTurn(turn),
      isBusy: (key) => this.d.pipeline.isBusy(key),
      addNextTurnNote: (key, note) => this.d.pipeline.addNextTurnNote(key, note),
      notifyOwner: (text, opts) => (opts ? this.d.notifyOwner(text, opts) : this.d.notifyOwner(text)),
      audit: (action, detail) => this.audit(action, "system", detail),
      log: this.log,
      now: this.now,
      ...(deps.holdMs !== undefined ? { holdMs: deps.holdMs } : {}),
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    });
  }

  static async create(deps: VoiceServiceDeps): Promise<VoiceService> {
    return new VoiceService(deps, await deps.loadCredentials());
  }

  private registerSecrets(): void {
    if (!this.d.addKnownSecret) return;
    for (const name of VOICE_PROVIDER_NAMES) {
      for (const s of this.providers[name].secrets()) this.d.addKnownSecret(s, `voice:${name}`);
    }
  }

  private audit(action: string, actor: string, detail: Record<string, unknown>): void {
    this.d.audit?.record({ feature: "voice", action, actor, detail });
  }

  /** Re-read voice.env and the credential store (an owner may have added credentials). */
  async reload(): Promise<void> {
    this.creds = await this.d.loadCredentials();
    this.providers = buildVoiceProviders(this.d.config, this.creds, this.d.fetch ? { fetch: this.d.fetch } : {});
    this.registerSecrets();
  }

  // ── state ────────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.d.config.enabled;
  }

  isSwitchedOn(): boolean {
    return this.d.settings.get(VOICE_SETTING_KEYS.switch, VoiceSwitchSettingSchema) ?? true;
  }

  activeProvider(): VoiceProviderName {
    return this.d.settings.get(VOICE_SETTING_KEYS.provider, VoiceProviderSettingSchema) ?? this.d.config.provider;
  }

  provider(name: VoiceProviderName = this.activeProvider()): VoiceCallProvider {
    return this.providers[name];
  }

  readiness(name: VoiceProviderName = this.activeProvider()): VoiceReadiness {
    return resolveVoiceReadiness({
      config: this.d.config,
      publicBaseUrl: this.d.ingress.publicBaseUrl,
      provider: this.providers[name],
      ...(this.creds.pin ? { pin: this.creds.pin } : {}),
    });
  }

  isActive(): boolean {
    return this.isEnabled() && this.isSwitchedOn() && this.readiness().ready;
  }

  /** Notes about refused credential sources, for /voice status and the startup log. Never values. */
  credentialNotes(name?: VoiceProviderName): string[] {
    const notes: string[] = [];
    if (this.creds.envFile.status === "ignored" && this.creds.envFile.reason) notes.push(this.creds.envFile.reason);
    const names = name ? [name] : VOICE_PROVIDER_NAMES;
    for (const n of names) notes.push(...this.creds.problems[n]);
    notes.push(...this.creds.problems.pin);
    return notes;
  }

  private routeApp(name: VoiceProviderName): Hono {
    let app = this.routeApps.get(name);
    if (!app) {
      app = createVoiceRoutes(this.providers[name].routePrefix, {
        provider: () => this.providers[name],
        flow: this.flow,
        publicBaseUrl: () => this.d.ingress.publicBaseUrl,
        onAccepted: () => { this.lastValid[name] = this.now(); },
        onRejected: () => this.noteRejected(name),
        log: this.log,
        now: this.now,
      });
      this.routeApps.set(name, app);
    }
    return app;
  }

  /** The Hono app for a provider's prefix (tests drive it with app.request). */
  routesFor(name: VoiceProviderName): Hono {
    return this.routeApp(name);
  }

  private noteRejected(name: VoiceProviderName): void {
    this.rejectedSinceAudit++;
    const now = this.now();
    if (now - this.lastRejectAudit < 60_000) return;
    this.audit("webhook.rejected", "system", { provider: name, count: this.rejectedSinceAudit });
    this.rejectedSinceAudit = 0;
    this.lastRejectAudit = now;
  }

  /** Mount exactly the active provider's routes when voice is active; nothing otherwise. Never throws. */
  async sync(): Promise<void> {
    const active = this.isActive();
    const name = this.activeProvider();
    const desired = active ? this.providers[name].routePrefix : null;
    try {
      for (const n of VOICE_PROVIDER_NAMES) {
        const prefix = this.providers[n].routePrefix;
        if (prefix !== desired && this.d.ingress.mountedPrefixes().includes(prefix)) this.d.ingress.unmount(prefix);
      }
      if (desired && !this.d.ingress.mountedPrefixes().includes(desired)) this.d.ingress.mount(desired, this.routeApp(name));
      if (desired) await this.d.ingress.ensureStarted();
      else await this.d.ingress.stopIfIdle();
    } catch (err) {
      this.log.error({ err: err instanceof Error ? err.message : String(err) }, "voice routes could not be mounted");
    }
    if (this.lastActive !== active) {
      this.lastActive = active;
      this.log.info({ active, provider: name }, active ? "voice active" : "voice inactive");
    }
    try {
      await this.d.onActiveChange?.(active);
    } catch (err) {
      this.log.error({ err: err instanceof Error ? err.message : String(err) }, "voice activation hook failed");
    }
  }

  async start(): Promise<void> {
    const recovered = this.d.store.recoverStale();
    if (recovered > 0) this.log.info({ recovered }, "closed call records left open by a restart");
    await this.sync();
  }

  async stop(): Promise<void> {
    this.flow.shutdown();
    for (const n of VOICE_PROVIDER_NAMES) {
      const prefix = this.providers[n].routePrefix;
      if (this.d.ingress.mountedPrefixes().includes(prefix)) this.d.ingress.unmount(prefix);
    }
    try { await this.d.ingress.stopIfIdle(); } catch { /* the daemon stops the ingress anyway */ }
  }

  // ── owner controls ───────────────────────────────────────────────────

  async switchOn(by: string): Promise<{ ok: boolean; message: string }> {
    if (!this.isEnabled()) {
      return { ok: false, message: "Voice is disabled in config (voice.enabled: false). Set it to true and restart. See docs/voice-setup.md." };
    }
    await this.reload();
    const r = this.readiness();
    if (!r.ready) {
      const notes = this.credentialNotes(this.activeProvider());
      return {
        ok: false,
        message: [`Voice is not ready on ${PROVIDER_LABEL[this.activeProvider()]}. Missing: ${r.missing.join(", ")}.`, ...notes].join("\n"),
      };
    }
    this.d.settings.set(VOICE_SETTING_KEYS.switch, true, by);
    await this.sync();
    return { ok: true, message: `Voice is on (${PROVIDER_LABEL[this.activeProvider()]}).` };
  }

  async switchOff(by: string): Promise<{ ok: boolean; message: string }> {
    const ended = await this.hangupAll("switched-off");
    // Calls that could not be ended yet (a Plivo call still ringing has no id) are closed here;
    // once the routes are unmounted their answer webhook gets 404 and the provider drops them.
    for (const call of this.live.all()) this.flow.finish(call, { reason: "switched-off", state: "canceled" });
    this.d.settings.set(VOICE_SETTING_KEYS.switch, false, by);
    await this.sync();
    return { ok: true, message: `Voice is off.${ended > 0 ? ` Ended ${ended} live call${ended === 1 ? "" : "s"}.` : ""} Inbound calls are rejected and outbound calls refused.` };
  }

  async hangupAll(reason: string): Promise<number> {
    let n = 0;
    for (const call of this.live.all()) {
      const r = await this.flow.hangup(call, reason);
      if (r.ok) n++;
    }
    return n;
  }

  async setProvider(target: VoiceProviderName | "reset", by: string): Promise<{ ok: boolean; message: string }> {
    const liveMessage = "A call is live. Hang up first (/voice hangup), then switch the provider.";
    if (this.live.size > 0) return { ok: false, message: liveMessage };
    await this.reload();
    // A call may have arrived while the credentials were being read.
    if (this.live.size > 0) return { ok: false, message: liveMessage };
    const name: VoiceProviderName = target === "reset" ? this.d.config.provider : target;
    const r = this.readiness(name);
    if (!r.ready) {
      return {
        ok: false,
        message: [`${PROVIDER_LABEL[name]} is not ready. Missing: ${r.missing.join(", ")}.`, ...this.credentialNotes(name)].join("\n"),
      };
    }
    const from = this.activeProvider();
    if (target === "reset") this.d.settings.delete(VOICE_SETTING_KEYS.provider, by);
    else this.d.settings.set(VOICE_SETTING_KEYS.provider, name, by);
    await this.sync();
    this.audit("provider.switched", by, { from, to: name });
    const note = this.isActive() ? "" : " Voice is not active, so nothing is mounted yet.";
    return { ok: true, message: `Active provider: ${PROVIDER_LABEL[name]}.${from !== name ? ` (was ${PROVIDER_LABEL[from]})` : ""}${note}` };
  }

  // ── calls ────────────────────────────────────────────────────────────

  /** The number an alias dials, and whether it is an owner number. */
  resolveAlias(alias: string): { number: string; owner: boolean } | null {
    const cfg = this.d.config;
    const key = alias.trim().toLowerCase();
    const number = key === "me" ? cfg.ownerNumbers[0] : cfg.contacts[key];
    if (!number || !isE164(number)) return null;
    return { number, owner: cfg.ownerNumbers.includes(number) };
  }

  aliases(): string[] {
    return ["me", ...Object.keys(this.d.config.contacts).filter((a) => a !== "me")];
  }

  private refusal(reason: string, req: PlaceCallRequest): PlaceCallResult {
    this.audit("call.refused", req.actor ?? req.requestedBy, { requestedBy: req.requestedBy, reason });
    return { ok: false, reason };
  }

  async placeCall(req: PlaceCallRequest): Promise<PlaceCallResult> {
    const cfg = this.d.config;
    if (!this.isEnabled()) return this.refusal("Voice is disabled in config (voice.enabled: false).", req);
    if (!this.isSwitchedOn()) return this.refusal("Voice is switched off (/voice on to enable).", req);
    const ready = this.readiness();
    if (!ready.ready) return this.refusal(`Voice is not ready: missing ${ready.missing.join(", ")}.`, req);
    if (!cfg.outbound.enabled) return this.refusal("Outbound calls are disabled (voice.outbound.enabled: false).", req);

    const alias = req.alias.trim().toLowerCase();
    if (RAW_NUMBER_RE.test(req.alias.trim())) return this.refusal("Calls go only to configured aliases; raw phone numbers are refused.", req);
    const target = this.resolveAlias(alias);
    if (!target) return this.refusal(`Unknown contact alias "${alias.slice(0, 32)}". Known: ${this.aliases().join(", ")}.`, req);
    if (req.mode === "talk" && !target.owner) return this.refusal("A spoken conversation (talk) is only allowed with the owner.", req);
    const text = req.text.trim();
    if (req.mode === "say" && !text) return this.refusal("The message is empty.", req);
    if (text.length > VOICE_MAX_MESSAGE_CHARS) return this.refusal(`The message is longer than ${VOICE_MAX_MESSAGE_CHARS} characters.`, req);
    const caps = this.flow.checkCaps();
    if (!caps.ok) return this.refusal(`Call refused: ${caps.reason}.`, req);

    const name = this.activeProvider();
    if (req.requestedBy === "agent-tool") {
      if (cfg.outbound.agentCalls === "off") return this.refusal("Agent-initiated calls are disabled (voice.outbound.agentCalls: off).", req);
      if (cfg.outbound.agentCalls === "ask") {
        const what = req.mode === "say"
          ? `It will say:\n«${text}»`
          : `It wants a spoken conversation with you.${text ? ` Purpose:\n«${text}»` : ""}`;
        const res = await this.d.approvals.requestApproval({
          kind: "voice",
          title: `Kirie wants to call ${alias} (…${lastFour(target.number)}) via ${PROVIDER_LABEL[name]}`,
          body: what,
          // At most 10 minutes, well inside the voice_call_initiate tool's own 15-minute wait.
          timeoutMs: Math.min(VOICE_MAX_APPROVAL_MS, Math.max(5_000, cfg.outbound.approvalTimeoutSeconds * 1000)),
        });
        this.audit("call.approval", "owner", { outcome: res.outcome, code: res.code, alias });
        if (res.outcome !== "approved") return this.refusal(`The owner did not approve the call (${res.outcome}).`, req);
        // Time has passed: check again.
        if (!this.isActive()) return this.refusal("Voice was switched off while waiting for approval.", req);
        if (this.activeProvider() !== name) return this.refusal("The provider changed while waiting for approval; ask again.", req);
      }
    }
    const capsNow = this.flow.checkCaps();
    if (!capsNow.ok) return this.refusal(`Call refused: ${capsNow.reason}.`, req);

    const provider = this.providers[name];
    const from = provider.fromNumber;
    if (!from) return this.refusal(`Voice is not ready: missing ${name}.fromNumber.`, req);
    const record = this.d.store.create({
      provider: name,
      direction: "outbound",
      mode: req.mode === "talk" ? "agent" : "say",
      role: target.owner ? "owner" : "contact",
      alias,
      remote: target.owner ? target.number : maskNumber(target.number),
      requestedBy: req.requestedBy,
      ...(req.mode === "say" ? { messageChars: text.length } : {}),
    });
    const call = this.flow.beginOutbound({
      provider: name,
      record,
      remote: target.number,
      role: target.owner ? "owner" : "contact",
      mode: req.mode === "talk" ? "agent" : "say",
      alias,
      message: text,
      timeLimitSeconds: capsNow.timeLimitSeconds,
    });
    try {
      const res = await provider.createCall({
        to: target.number,
        from,
        answerUrl: this.flow.url(provider, "outbound", call.token),
        statusUrl: this.flow.url(provider, "status", call.token),
        timeLimitSeconds: capsNow.timeLimitSeconds,
        ringTimeoutSeconds: cfg.outbound.ringTimeoutSeconds,
        machineDetection: cfg.outbound.machineDetection,
      });
      if (res.providerCallId && !call.providerCallId) call.providerCallId = res.providerCallId;
      this.d.store.update(record.id, {
        ...(res.providerCallId ? { providerCallId: res.providerCallId } : {}),
        ...(res.requestId ? { requestId: res.requestId } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.flow.finish(call, { reason: "create-failed", state: "failed", durationSeconds: 0 });
      this.log.warn({ callId: record.id, provider: name, err: msg }, "outbound call failed");
      return this.refusal(`The call could not be placed: ${msg}`, req);
    }
    this.audit("call.placed", req.actor ?? req.requestedBy, {
      callId: record.id, provider: name, alias, mode: req.mode, requestedBy: req.requestedBy, chars: text.length,
    });
    this.log.info({ callId: record.id, provider: name, alias, mode: req.mode, requestedBy: req.requestedBy }, "outbound call placed");
    return { ok: true, callId: record.id, provider: name, status: "dialing" };
  }

  async hangup(callId: string, actor: string): Promise<{ ok: boolean; message: string }> {
    const call = this.live.byCallId(callId);
    if (!call) return { ok: false, message: "No live call with that id." };
    const r = await this.flow.hangup(call, "hung-up");
    this.audit("call.hangup", actor, { callId, ok: r.ok });
    if (!r.ok) return { ok: false, message: `Hangup failed: ${r.reason}` };
    return { ok: true, message: r.deferred ? "The call is still ringing; it will be ended as soon as it is answered." : "Call ended." };
  }

  private view(rec: CallRecord, live: LiveCall | undefined): VoiceCallView {
    return {
      callId: rec.id,
      provider: rec.provider,
      direction: rec.direction,
      mode: rec.mode,
      to: displayRemote(rec),
      state: rec.state,
      live: live !== undefined,
      ...(rec.durationSeconds !== undefined ? { durationSeconds: rec.durationSeconds } : {}),
      turns: rec.turns,
      ...(rec.endReason ? { endReason: rec.endReason } : {}),
      createdAt: new Date(rec.createdAt).toISOString(),
      ...(rec.capturedReply ? { replyCaptured: true as const } : {}),
    };
  }

  getCall(callId: string): VoiceCallView | null {
    const rec = this.d.store.get(callId);
    return rec ? this.view(rec, this.live.byCallId(callId)) : null;
  }

  listCalls(): { live: VoiceCallView[]; recent: VoiceCallView[] } {
    const live = this.live.all().map((c) => this.d.store.get(c.callId)).filter((r): r is CallRecord => r !== null);
    return {
      live: live.map((r) => this.view(r, this.live.byCallId(r.id))),
      recent: this.d.store.recent(10).map((r) => this.view(r, this.live.byCallId(r.id))),
    };
  }

  // ── status ───────────────────────────────────────────────────────────

  statusText(): string {
    const cfg = this.d.config;
    const active = this.activeProvider();
    const lines: string[] = [];
    if (!this.isEnabled()) lines.push("Voice: off in config (voice.enabled: false). See docs/voice-setup.md.");
    else if (!this.isSwitchedOn()) lines.push("Voice: switched off (/voice on).");
    else lines.push(this.isActive() ? "Voice: on." : "Voice: enabled but NOT ready (see below).");
    lines.push(`Active provider: ${PROVIDER_LABEL[active]}${active !== cfg.provider ? ` (override; config says ${cfg.provider})` : ""}.`);
    for (const n of VOICE_PROVIDER_NAMES) {
      const r = this.readiness(n);
      lines.push(`  ${PROVIDER_LABEL[n]}: ${r.ready ? "ready" : `missing ${r.missing.join(", ")}`}`);
    }
    const notes = this.credentialNotes();
    if (notes.length > 0) lines.push(...notes.map((n) => `  Note: ${n}`));
    const url = this.d.ingress.publicBaseUrl;
    const last = this.lastValid[active];
    lines.push(`Public URL: ${url ?? "not set (ingress.publicBaseUrl)"}; last valid ${PROVIDER_LABEL[active]} webhook: ${last ? ago(this.now() - last) : "never"}.`);
    lines.push(`Inbound: ${cfg.inbound.mode}${cfg.inbound.mode === "agent" ? (cfg.inbound.requirePin ? " (PIN required)" : " (no PIN: caller ID alone)") : ""}; unknown callers: ${cfg.inbound.unknownCallers}.`);
    lines.push(`Outbound: ${cfg.outbound.enabled ? "on" : "off"}; agent calls: ${cfg.outbound.agentCalls}. Owner numbers: ${cfg.ownerNumbers.map((n) => maskNumber(n)).join(", ") || "none"}.`);
    const usage = this.d.store.usageToday();
    lines.push(`Today: ${usage.calls}/${cfg.limits.maxCallsPerDay} calls, ${Math.ceil(usage.seconds / 60)}/${cfg.limits.maxMinutesPerDay} minutes. Per call: ${cfg.limits.maxCallSeconds}s.`);
    const live = this.live.all();
    lines.push(`Live calls: ${live.length === 0 ? "none" : live.map((c) => `${c.alias ?? maskNumber(c.remote)} ${c.direction} ${c.mode} via ${c.provider} (${c.phase})`).join("; ")}`);
    const recent = this.d.store.recent(3);
    if (recent.length > 0) {
      lines.push("Recent:");
      for (const r of recent) {
        lines.push(`  ${new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ")} ${displayRemote(r)} ${r.direction} via ${r.provider}, ${r.durationSeconds ?? 0}s, ${r.endReason ?? r.state}`);
      }
    }
    return lines.join("\n");
  }
}
