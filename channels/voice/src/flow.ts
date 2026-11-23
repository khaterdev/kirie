/**
 * The call flow, written once for every provider (PLAN C.14, R5 item 14).
 *
 * Each webhook handler is a function from a verified, parsed event to the
 * provider's markup. The provider does speech-to-text and text-to-speech; an
 * agent turn is long-polled: /turn waits up to `holdMs` (9 s), then answers
 * "One moment." plus a redirect to /wait, which repeats until
 * `limits.maxThinkSeconds`, after which the answer is deferred to Telegram.
 *
 * Security rules enforced here:
 * - Only owner numbers ever produce an agent turn, and by default only after
 *   a DTMF PIN (attempt limit, lockout, owner alert).
 * - Everyone else is rejected, or leaves one voicemail that is sent to the
 *   owner as quoted, unverified text and never enters an agent prompt.
 * - A leading "/" is stripped from transcripts, so speech is never a command.
 * - Caps on concurrent calls, calls per day, minutes per day, seconds per call
 *   and turns per call; a watchdog ends calls that outlive their deadline.
 * - The PIN is never spoken, logged, or sent anywhere.
 */

import { timingSafeEqual } from "node:crypto";
import { createModuleLogger, scrubSecrets, type VoiceConfig } from "@kirie/core";
import {
  TERMINAL_CALL_STATES,
  capSpeech,
  chunkForSay,
  cleanForSpeech,
  maskNumber,
  type CallRecord,
  type CallState,
  type CallStore,
  type SpeechOpts,
  type VoiceCallEvent,
  type VoiceCallProvider,
  type VoiceProviderName,
} from "@kirie/voice";
import {
  createPendingTurn,
  newCallToken,
  voiceSessionKey,
  voiceTurnMessageId,
  type LiveCall,
  type LiveCallRegistry,
  type LivePhase,
} from "./session.js";

type Logger = ReturnType<typeof createModuleLogger>;
type TimerHandle = ReturnType<typeof setTimeout>;

export type FlowResult = { status: 200; markup: string } | { status: 204 } | { status: 403 };

export interface VoiceTurnEmission {
  call: LiveCall;
  sessionKey: string;
  messageId: string;
  text: string;
  confidence?: number;
}

export interface VoiceFlowDeps {
  config(): VoiceConfig;
  provider(name: VoiceProviderName): VoiceCallProvider;
  publicBaseUrl(): string | null;
  live: LiveCallRegistry;
  store: CallStore;
  pin(): string | undefined;
  /** Voice is enabled, switched on, and `provider` is the active, ready provider. */
  acceptsCalls(provider: VoiceProviderName): boolean;
  /** Hand a spoken turn to the pipeline (through the voice adapter's listeners). */
  emitTurn(turn: VoiceTurnEmission): void;
  isBusy(sessionKey: string): boolean;
  addNextTurnNote(sessionKey: string, note: string): void;
  notifyOwner(text: string, opts?: { key?: string }): Promise<void>;
  audit?(action: string, detail: Record<string, unknown>): void;
  log?: Logger;
  now?: () => number;
  /** Long-poll hold per webhook. Default 9000 ms (Twilio's webhook limit is 15 s). */
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

const CLOSING_RE = /^(?:ok(?:ay)? )?(?:good ?bye|bye(?: bye)?|that'?s all(?: for now)?|hang up|end (?:the )?call)(?: thanks?(?: you)?)?$/;
const MAX_CAPTURED_CHARS = 2000;
const MAX_EMPTY_TURNS = 2;
/** The PIN gather accepts up to the longest allowed PIN and ends on "#", so the prompt does not reveal the PIN length. */
const PIN_GATHER_DIGITS = 10;
/** Wrong PINs are counted per number across calls over this window, so hanging up between guesses does not help. */
const PIN_FAILURE_WINDOW_MS = 24 * 3600_000;
/** A live call with no webhook for this long has ended without telling us. */
const STALE_CALL_MS = 30_000;

export type CapCheck = { ok: true; timeLimitSeconds: number } | { ok: false; reason: string; busy: boolean };

export class VoiceCallFlow {
  private readonly d: VoiceFlowDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly holdMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  /** Owner number -> lockout end (epoch ms). In memory: a restart clears lockouts. */
  private readonly lockouts = new Map<string, number>();
  /** Owner number -> times of wrong (non-empty) PIN entries, across calls, within PIN_FAILURE_WINDOW_MS. */
  private readonly pinFailures = new Map<string, number[]>();
  /** Markup already returned for rejected inbound calls, keyed provider:callId, for duplicate webhooks. */
  private readonly rejected = new Map<string, string>();
  private capNoticeDay: string | null = null;

  constructor(deps: VoiceFlowDeps) {
    this.d = deps;
    this.log = deps.log ?? createModuleLogger("voice-flow");
    this.now = deps.now ?? Date.now;
    this.holdMs = deps.holdMs ?? 9000;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private speech(provider: VoiceCallProvider): SpeechOpts {
    return { language: this.d.config().speech.language, voice: provider.voice };
  }

  url(provider: VoiceCallProvider, kind: string, token?: string): string {
    const base = this.d.publicBaseUrl() ?? "";
    return `${base}${provider.routePrefix}/${kind}${token ? `/${token}` : ""}`;
  }

  private gather(provider: VoiceCallProvider, call: LiveCall, say: string[], kind: "turn" | "vm" = "turn"): string {
    const cfg = this.d.config();
    const action = this.url(provider, kind, call.token);
    return provider.markup.gatherSpeech({
      action,
      say,
      timeoutSeconds: kind === "vm" ? 8 : 6,
      speechEndSeconds: cfg.speech.speechTimeoutSeconds,
      hints: cfg.speech.hints,
      fallthroughRedirect: action,
      ...this.speech(provider),
    });
  }

  private sayChunks(provider: VoiceCallProvider, text: string): string[] {
    return chunkForSay(text, provider.maxSayChars);
  }

  /** Caps shared by inbound and outbound calls and by both providers. */
  checkCaps(): CapCheck {
    const limits = this.d.config().limits;
    if (this.d.live.size >= limits.maxConcurrentCalls) return { ok: false, reason: "another call is in progress", busy: true };
    const usage = this.d.store.usageToday();
    if (usage.calls >= limits.maxCallsPerDay) {
      return { ok: false, reason: `the daily call limit (${limits.maxCallsPerDay}) is reached`, busy: false };
    }
    const remaining = limits.maxMinutesPerDay * 60 - usage.seconds;
    if (remaining < 30) return { ok: false, reason: `the daily limit of ${limits.maxMinutesPerDay} minutes is used up`, busy: false };
    return { ok: true, timeLimitSeconds: Math.min(limits.maxCallSeconds, remaining) };
  }

  private noticeCapOnce(reason: string): void {
    const day = new Date(this.now()).toDateString();
    if (this.capNoticeDay === day) return;
    this.capNoticeDay = day;
    void this.d.notifyOwner(`Voice: a call was refused because ${reason}. The caps reset at midnight.`, { key: "voice-cap" });
  }

  private pinMatches(given: string | undefined): boolean {
    const pin = this.d.pin();
    if (!pin || !given) return false;
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(pin, "utf8");
    if (a.length !== b.length) {
      timingSafeEqual(b, b);
      return false;
    }
    return timingSafeEqual(a, b);
  }

  private isLockedOut(remote: string): boolean {
    const until = this.lockouts.get(remote);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.lockouts.delete(remote);
      return false;
    }
    return true;
  }

  private scheduleWatchdog(call: LiveCall): void {
    if (call.watchdog) this.clearTimer(call.watchdog);
    const ms = Math.max(0, call.deadline + 10_000 - this.now());
    call.watchdog = this.setTimer(() => { void this.timeUp(call.token); }, ms);
    (call.watchdog as { unref?: () => void }).unref?.();
  }

  private async timeUp(token: string): Promise<void> {
    const call = this.d.live.byToken(token);
    if (!call) return;
    const answered = call.answeredAt !== undefined;
    if (call.providerCallId && (answered || call.direction === "inbound")) {
      try {
        await this.d.provider(call.provider).endCall(call.providerCallId);
      } catch (err) {
        this.log.warn({ callId: call.callId, err: err instanceof Error ? err.message : String(err) }, "watchdog could not end the call");
      }
    }
    this.finish(call, { reason: answered ? "time-limit" : "no-answer", state: answered ? "completed" : "no-answer" });
  }

  /** Remove a live call, close its record, and send the owner a summary when one is due. */
  finish(call: LiveCall, end: { reason: string; state?: CallState; durationSeconds?: number }): CallRecord | null {
    if (call.watchdog) this.clearTimer(call.watchdog);
    call.watchdog = undefined;
    call.phase = "ended";
    const pending = call.pending;
    if (pending && !pending.settled) pending.deferred = true;
    else if (pending && !pending.spoken && pending.reply) {
      // The answer arrived but was never spoken: the caller hung up in between.
      void this.d.notifyOwner(`From your call:\n${pending.reply}`);
      pending.spoken = true;
    }
    const wasLive = this.d.live.remove(call.token) !== undefined;
    const now = this.now();
    const duration = end.durationSeconds ?? (call.answeredAt !== undefined ? Math.round((now - call.answeredAt) / 1000) : 0);
    const rec = this.d.store.update(call.callId, {
      state: end.state ?? "completed",
      endedAt: now,
      endReason: end.reason,
      durationSeconds: duration,
      turns: call.turn,
    });
    if (!wasLive || !rec) return rec;
    this.log.info({ callId: call.callId, provider: call.provider, reason: end.reason, seconds: duration }, "call ended");
    this.d.audit?.("call.ended", { callId: call.callId, provider: call.provider, reason: end.reason, seconds: duration });
    this.sendSummary(call, rec);
    return rec;
  }

  private sendSummary(call: LiveCall, rec: CallRecord): void {
    const who = call.alias ?? maskNumber(call.remote);
    const via = call.provider === "plivo" ? "Plivo" : "Twilio";
    if (call.direction === "outbound" && call.answeredAt === undefined) {
      void this.d.notifyOwner(`Call to ${who} (${via}) was not answered (${rec.state}).`);
      return;
    }
    if (call.mode === "say") {
      const reply = rec.capturedReply
        ? `\nThey replied (unverified transcript): «${rec.capturedReply}»`
        : "\nNo reply was left.";
      void this.d.notifyOwner(`Call to ${who} (${via}) ended after ${rec.durationSeconds ?? 0}s.${reply}`);
    } else if (call.mode === "voicemail") {
      void this.d.notifyOwner(rec.capturedReply
        ? `Voicemail from ${maskNumber(call.remote)} via ${via} (unverified transcript): «${rec.capturedReply}»`
        : `Missed call from ${maskNumber(call.remote)} via ${via}; no message was left.`);
    }
  }

  // ── authorization for token routes ───────────────────────────────────

  /**
   * The live call for a token route, or null (the route answers 403). The call
   * must belong to this provider and be in one of `phases`; once its provider
   * call id is known the event must carry the same id. A Plivo outbound call
   * learns its id here, on the first answer webhook.
   */
  authorize(token: string, provider: VoiceProviderName, event: VoiceCallEvent, phases: readonly LivePhase[] | "any"): LiveCall | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const call = this.d.live.byToken(token);
    if (!call || call.provider !== provider) return null;
    if (call.providerCallId) {
      if (event.providerCallId !== call.providerCallId) return null;
    } else {
      if (!event.providerCallId) return null;
      if (this.d.live.byProviderCallId(provider, event.providerCallId)) return null;
      call.providerCallId = event.providerCallId;
      this.d.store.update(call.callId, { providerCallId: event.providerCallId });
    }
    if (phases !== "any" && !phases.includes(call.phase)) return null;
    call.lastActivityAt = this.now();
    return call;
  }

  /** Markup that continues a call in its current phase (a repeated answer webhook). */
  private phaseMarkup(provider: VoiceCallProvider, call: LiveCall): string {
    const v = this.speech(provider);
    switch (call.phase) {
      case "pin":
        return provider.markup.gatherPin({ action: this.url(provider, "pin", call.token), digits: PIN_GATHER_DIGITS, prompt: "Please enter your PIN, then press the pound key.", ...v });
      case "listening":
        return this.gather(provider, call, []);
      case "voicemail":
      case "say-reply":
        return this.gather(provider, call, [], "vm");
      case "thinking":
        return provider.markup.holdAndRedirect({ pauseSeconds: 1, redirect: this.url(provider, "wait", call.token), ...v });
      default:
        return provider.markup.sayAndHangup("Goodbye.", v);
    }
  }

  /** The live call with this provider call id, for the tokenless status route. */
  findLive(provider: VoiceProviderName, providerCallId: string): LiveCall | null {
    return providerCallId ? this.d.live.byProviderCallId(provider, providerCallId) ?? null : null;
  }

  // ── inbound ──────────────────────────────────────────────────────────

  inbound(provider: VoiceCallProvider, event: VoiceCallEvent): FlowResult {
    if (!event.providerCallId) return { status: 403 };
    const existing = this.d.live.byProviderCallId(provider.name, event.providerCallId);
    if (existing) return { status: 200, markup: existing.lastMarkup ?? this.phaseMarkup(provider, existing) };
    const dupKey = `${provider.name}:${event.providerCallId}`;
    const dup = this.rejected.get(dupKey);
    if (dup) return { status: 200, markup: dup };

    const markup = this.decideInbound(provider, event);
    if (markup.rejected) {
      this.rejected.set(dupKey, markup.xml);
      if (this.rejected.size > 200) this.rejected.delete(this.rejected.keys().next().value!);
    }
    return { status: 200, markup: markup.xml };
  }

  private decideInbound(provider: VoiceCallProvider, event: VoiceCallEvent): { xml: string; rejected: boolean } {
    const cfg = this.d.config();
    const reject = (reason: "rejected" | "busy" = "rejected", why: string) => {
      this.log.info({ provider: provider.name, from: maskNumber(event.from), why }, "inbound call rejected");
      return { xml: provider.markup.reject(reason), rejected: true };
    };
    if (!this.d.acceptsCalls(provider.name)) return reject("rejected", "voice off");
    if (cfg.inbound.mode === "reject") return reject("rejected", "inbound mode reject");

    const caller = event.from;
    const isOwner = caller !== null && cfg.ownerNumbers.includes(caller);
    let mode: "agent" | "voicemail";
    if (isOwner && cfg.inbound.mode === "agent") mode = "agent";
    else if (isOwner && cfg.inbound.mode === "voicemail") mode = "voicemail";
    else if (!isOwner && cfg.inbound.unknownCallers === "voicemail") mode = "voicemail";
    else return reject("rejected", "unknown caller");

    if (mode === "agent" && caller && this.isLockedOut(caller)) return reject("rejected", "pin lockout");
    // An older inbound call from the same number that has gone quiet ended without a hangup
    // webhook (Twilio sends none unless the number's status callback is set): close it. One that
    // is still active is never ended by a new call (caller ID can be spoofed); the new call is busy.
    if (caller) {
      for (const old of this.d.live.all()) {
        if (old.direction !== "inbound" || old.remote !== caller || old.providerCallId === event.providerCallId) continue;
        if (this.now() - old.lastActivityAt < STALE_CALL_MS) return reject("busy", "same number already on a call");
        this.finish(old, { reason: "superseded" });
      }
    }
    const caps = this.checkCaps();
    if (!caps.ok) {
      if (!caps.busy) this.noticeCapOnce(caps.reason);
      return reject(caps.busy ? "busy" : "rejected", caps.reason);
    }

    const now = this.now();
    const rec = this.d.store.create({
      provider: provider.name,
      providerCallId: event.providerCallId,
      direction: "inbound",
      mode,
      role: isOwner ? "owner" : "unknown",
      remote: isOwner ? caller! : maskNumber(caller),
      requestedBy: "inbound",
      state: "in-progress",
      answeredAt: now,
    });
    const call: LiveCall = {
      token: newCallToken(),
      callId: rec.id,
      provider: provider.name,
      providerCallId: event.providerCallId,
      direction: "inbound",
      remote: caller,
      role: isOwner ? "owner" : "unknown",
      mode,
      phase: "listening",
      startedAt: now,
      lastActivityAt: now,
      answeredAt: now,
      deadline: now + caps.timeLimitSeconds * 1000,
      turn: 0,
      emptyTurns: 0,
      pinAttempts: 0,
      pending: null,
    };
    this.d.live.add(call);
    this.scheduleWatchdog(call);
    this.d.audit?.("call.inbound", { callId: call.callId, provider: provider.name, mode, role: call.role });

    let xml: string;
    if (mode === "voicemail") {
      call.phase = "voicemail";
      xml = this.gather(provider, call, [cfg.inbound.voicemailGreeting], "vm");
    } else if (cfg.inbound.requirePin) {
      call.phase = "pin";
      xml = provider.markup.gatherPin({
        action: this.url(provider, "pin", call.token),
        digits: PIN_GATHER_DIGITS,
        prompt: "Please enter your PIN, then press the pound key.",
        ...this.speech(provider),
      });
    } else {
      xml = this.gather(provider, call, [cfg.inbound.greeting]);
    }
    call.lastMarkup = xml;
    this.log.info({ callId: call.callId, provider: provider.name, mode, phase: call.phase }, "inbound call accepted");
    return { xml, rejected: false };
  }

  pin(provider: VoiceCallProvider, call: LiveCall, event: VoiceCallEvent): FlowResult {
    const cfg = this.d.config();
    call.lastMarkup = undefined;
    const digits = event.digits?.trim() ?? "";
    const remote = call.remote ?? "";
    if (digits && this.pinMatches(digits)) {
      call.phase = "listening";
      this.pinFailures.delete(remote);
      this.log.info({ callId: call.callId }, "pin accepted");
      return { status: 200, markup: this.gather(provider, call, [cfg.inbound.greeting]) };
    }
    call.pinAttempts++;
    let failures = 0;
    if (digits) {
      const since = this.now() - PIN_FAILURE_WINDOW_MS;
      const list = (this.pinFailures.get(remote) ?? []).filter((t) => t > since);
      list.push(this.now());
      this.pinFailures.set(remote, list);
      failures = list.length;
      this.log.warn({ callId: call.callId, attempt: call.pinAttempts, failures }, "wrong pin");
    }
    if (failures >= cfg.inbound.maxPinAttempts) {
      this.pinFailures.delete(remote);
      if (remote) this.lockouts.set(remote, this.now() + cfg.inbound.pinLockoutMinutes * 60_000);
      this.d.audit?.("pin.lockout", { callId: call.callId, provider: provider.name, minutes: cfg.inbound.pinLockoutMinutes });
      void this.d.notifyOwner(
        `Voice: ${failures} wrong PIN attempts within a day on calls from your number ${maskNumber(call.remote)} via ${provider.name}. ` +
        `Calls from it are refused for ${cfg.inbound.pinLockoutMinutes} minutes. If this was not you, someone is spoofing your number.`,
      );
      const xml = provider.markup.sayAndHangup("Sorry, that is not right. Goodbye.", this.speech(provider));
      this.finish(call, { reason: "pin-failed" });
      return { status: 200, markup: xml };
    }
    if (call.pinAttempts >= cfg.inbound.maxPinAttempts) {
      const xml = provider.markup.sayAndHangup("Goodbye.", this.speech(provider));
      this.finish(call, { reason: digits ? "pin-failed" : "no-pin" });
      return { status: 200, markup: xml };
    }
    return {
      status: 200,
      markup: provider.markup.gatherPin({
        action: this.url(provider, "pin", call.token),
        digits: PIN_GATHER_DIGITS,
        prompt: digits
          ? "That is not right. Please try again, then press the pound key."
          : "I did not get a PIN. Please enter it, then press the pound key.",
        ...this.speech(provider),
      }),
    };
  }

  // ── agent turns ──────────────────────────────────────────────────────

  async turn(provider: VoiceCallProvider, call: LiveCall, event: VoiceCallEvent): Promise<FlowResult> {
    const cfg = this.d.config();
    const v = this.speech(provider);
    const hangup = (text: string, reason: string): FlowResult => {
      const xml = provider.markup.sayAndHangup(text, v);
      this.finish(call, { reason });
      return { status: 200, markup: xml };
    };
    if (call.role !== "owner" || call.mode !== "agent" || !call.remote) return { status: 403 };
    if (this.now() > call.deadline) return hangup("We are out of time for this call. Goodbye.", "time-limit");

    const text = (event.speech ?? "").replace(/^[\s/\\]+/, "").trim();
    if (!text) {
      call.emptyTurns++;
      if (call.emptyTurns > MAX_EMPTY_TURNS) return hangup("I did not hear anything. Goodbye.", "silence");
      return { status: 200, markup: this.gather(provider, call, ["Sorry, I did not catch that."]) };
    }
    call.emptyTurns = 0;
    const normalized = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
    if (CLOSING_RE.test(normalized)) return hangup("Goodbye.", "caller-ended");
    if (call.turn >= cfg.limits.maxTurnsPerCall) return hangup("That is the limit for this call. Goodbye.", "turn-limit");

    const sessionKey = voiceSessionKey(call.remote);
    if (this.d.isBusy(sessionKey)) {
      return { status: 200, markup: this.gather(provider, call, ["I am still working on your last request. The answer will come on Telegram."]) };
    }

    call.turn++;
    call.phase = "thinking";
    call.pending = createPendingTurn(call.turn, this.now());
    this.d.store.update(call.callId, { turns: call.turn });
    this.log.info({ callId: call.callId, turn: call.turn, chars: text.length }, "voice turn");
    this.log.debug({ callId: call.callId, transcript: text }, "voice turn transcript");
    this.d.emitTurn({
      call,
      sessionKey,
      messageId: voiceTurnMessageId(call.token, call.turn),
      text,
      ...(event.speechConfidence !== undefined ? { confidence: event.speechConfidence } : {}),
    });
    return this.awaitReply(provider, call, "One moment.");
  }

  async wait(provider: VoiceCallProvider, call: LiveCall): Promise<FlowResult> {
    return this.awaitReply(provider, call);
  }

  private async awaitReply(provider: VoiceCallProvider, call: LiveCall, filler?: string): Promise<FlowResult> {
    const pending = call.pending;
    const v = this.speech(provider);
    if (!pending) return { status: 200, markup: this.gather(provider, call, []) };
    let timer: TimerHandle | undefined;
    const timeout = new Promise<null>((resolve) => { timer = this.setTimer(() => resolve(null), this.holdMs); });
    const reply = await Promise.race([pending.promise, timeout]);
    if (timer) this.clearTimer(timer);

    if (!this.d.live.byToken(call.token)) return { status: 200, markup: provider.markup.sayAndHangup("Goodbye.", v) };
    if (reply !== null) {
      pending.spoken = true;
      call.pending = null;
      call.phase = "listening";
      return { status: 200, markup: this.gather(provider, call, this.renderReply(provider, reply)) };
    }
    const thinkingMs = this.now() - pending.startedAt;
    if (thinkingMs >= this.d.config().limits.maxThinkSeconds * 1000) {
      pending.deferred = true;
      call.pending = null;
      call.phase = "listening";
      this.log.info({ callId: call.callId, turn: pending.turn }, "turn deferred to Telegram");
      return {
        status: 200,
        markup: this.gather(provider, call, ["This is taking a while. I will send the answer on Telegram. Anything else?"]),
      };
    }
    const redirect = this.url(provider, "wait", call.token);
    return {
      status: 200,
      markup: provider.markup.holdAndRedirect({ ...(filler ? { say: filler } : {}), pauseSeconds: filler ? 0 : 1, redirect, ...v }),
    };
  }

  private renderReply(provider: VoiceCallProvider, reply: string): string[] {
    const cleaned = cleanForSpeech(reply);
    if (!cleaned) return ["Done."];
    const max = this.d.config().limits.maxSpeechChars;
    const capped = capSpeech(cleaned, max);
    let spoken = capped.text;
    if (capped.truncated) {
      spoken = `${spoken} I sent the full answer on Telegram.`;
      void this.d.notifyOwner(`From your call (full answer):\n${reply}`);
    }
    return this.sayChunks(provider, spoken);
  }

  /**
   * A reply from the pipeline for a voice chat. True when it answered the
   * live turn it belongs to; false means the caller should forward it to the
   * owner on Telegram (no live turn, the turn was deferred, or the call ended).
   */
  deliverReply(turnRef: { token: string; turn: number } | null, text: string): boolean {
    if (!turnRef) return false;
    const call = this.d.live.byToken(turnRef.token);
    const pending = call?.pending;
    if (!call || !pending || pending.turn !== turnRef.turn || pending.settled || pending.deferred) return false;
    pending.resolve(text);
    return true;
  }

  /** The pipeline failed a voice turn: answer the waiting webhook with an apology (the error text, if any, goes to Telegram). */
  turnFailed(remote: string): void {
    for (const call of this.d.live.all()) {
      if (call.remote === remote && call.pending && !call.pending.settled) {
        call.pending.resolve("Sorry, something went wrong with that request. I will send the details on Telegram.");
      }
    }
  }

  /** The pipeline finished a voice turn. A turn that sent nothing is answered with an empty reply. */
  turnFinished(remote: string, startedAt: number): void {
    for (const call of this.d.live.all()) {
      if (call.remote !== remote || !call.pending || call.pending.settled) continue;
      if (startedAt + 1000 < call.pending.startedAt) continue;
      call.pending.resolve("");
    }
  }

  // ── outbound ─────────────────────────────────────────────────────────

  outbound(provider: VoiceCallProvider, call: LiveCall): FlowResult {
    const cfg = this.d.config();
    const v = this.speech(provider);
    if (call.hangupRequested) {
      const xml = provider.markup.sayAndHangup("Sorry, this call was cancelled. Goodbye.", v);
      this.finish(call, { reason: "cancelled" });
      return { status: 200, markup: xml };
    }
    const now = this.now();
    call.answeredAt = now;
    call.deadline = now + (call.timeLimitSeconds ?? cfg.limits.maxCallSeconds) * 1000;
    this.d.store.update(call.callId, { state: "in-progress", answeredAt: now });
    this.scheduleWatchdog(call);
    this.log.info({ callId: call.callId, provider: provider.name, mode: call.mode, alias: call.alias }, "outbound call answered");

    if (call.mode === "say") {
      call.phase = "say-reply";
      const say = [cfg.outbound.announce, ...this.sayChunks(provider, call.message ?? ""), "You can reply now, or hang up."];
      return { status: 200, markup: this.gather(provider, call, say, "vm") };
    }
    call.phase = "listening";
    if (call.remote && call.message) {
      this.d.addNextTurnNote(
        voiceSessionKey(call.remote),
        `This is a phone call Kirie placed to the owner. Purpose of the call: ${call.message}`,
      );
    }
    const opening = call.message ? `Hi, it's Kirie. I'm calling about: ${call.message}. Go ahead.` : "Hi, it's Kirie. Go ahead.";
    return { status: 200, markup: this.gather(provider, call, this.sayChunks(provider, opening)) };
  }

  /** One captured reply (outbound "say") or voicemail. Stored as untrusted text; never sent to the agent. */
  voicemail(provider: VoiceCallProvider, call: LiveCall, event: VoiceCallEvent): FlowResult {
    const v = this.speech(provider);
    const text = scrubSecrets((event.speech ?? "").trim().slice(0, MAX_CAPTURED_CHARS), { sink: "chat-history" });
    if (text) this.d.store.update(call.callId, { capturedReply: text });
    const xml = provider.markup.sayAndHangup(text ? "Thank you. Goodbye." : "Goodbye.", v);
    this.finish(call, { reason: text ? "reply-captured" : "no-reply" });
    return { status: 200, markup: xml };
  }

  // ── status ───────────────────────────────────────────────────────────

  status(provider: VoiceCallProvider, call: LiveCall | null, event: VoiceCallEvent): FlowResult {
    const terminal = event.status !== undefined && TERMINAL_CALL_STATES.has(event.status);
    if (!call) {
      // A call that already ended on our side: record the provider's final duration.
      const rec = event.providerCallId ? this.d.store.byProviderCallId(provider.name, event.providerCallId) : null;
      if (rec && terminal && event.durationSeconds !== undefined) this.d.store.update(rec.id, { durationSeconds: event.durationSeconds });
      return { status: 204 };
    }
    if (!terminal) {
      if (event.status === "ringing" && call.phase === "dialing") this.d.store.update(call.callId, { state: "ringing" });
      return { status: 204 };
    }
    this.finish(call, {
      reason: event.status === "completed" ? "hangup" : event.status!,
      state: event.status as CallState,
      ...(event.durationSeconds !== undefined ? { durationSeconds: event.durationSeconds } : {}),
    });
    return { status: 204 };
  }

  // ── owner and agent actions ──────────────────────────────────────────

  /** Create the live state of an outbound call before dialling. */
  beginOutbound(input: {
    provider: VoiceProviderName; record: CallRecord; remote: string; role: "owner" | "contact";
    mode: "say" | "agent"; alias: string; message: string; timeLimitSeconds: number;
  }): LiveCall {
    const now = this.now();
    const ring = this.d.config().outbound.ringTimeoutSeconds;
    const call: LiveCall = {
      token: newCallToken(),
      callId: input.record.id,
      provider: input.provider,
      providerCallId: null,
      direction: "outbound",
      remote: input.remote,
      role: input.role,
      mode: input.mode,
      alias: input.alias,
      phase: "dialing",
      startedAt: now,
      lastActivityAt: now,
      deadline: now + (ring + input.timeLimitSeconds) * 1000,
      turn: 0,
      emptyTurns: 0,
      pinAttempts: 0,
      pending: null,
      message: scrubSecrets(input.message, { sink: "channel" }),
      timeLimitSeconds: input.timeLimitSeconds,
    };
    this.d.live.add(call);
    this.scheduleWatchdog(call);
    return call;
  }

  /** End a live call now. Without a provider call id (Plivo before answer) it is cancelled when it answers. */
  async hangup(call: LiveCall, reason: string): Promise<{ ok: true; deferred: boolean } | { ok: false; reason: string }> {
    if (!call.providerCallId || (call.direction === "outbound" && call.answeredAt === undefined && call.provider === "plivo")) {
      call.hangupRequested = true;
      return { ok: true, deferred: true };
    }
    try {
      await this.d.provider(call.provider).endCall(call.providerCallId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn({ callId: call.callId, err: msg }, "hangup failed");
      if (call.answeredAt === undefined) {
        call.hangupRequested = true;
        return { ok: true, deferred: true };
      }
      return { ok: false, reason: msg };
    }
    this.finish(call, { reason });
    return { ok: true, deferred: false };
  }

  /** Stop every watchdog (daemon stop). Live state is dropped with the process. */
  shutdown(): void {
    for (const call of this.d.live.all()) {
      if (call.watchdog) this.clearTimer(call.watchdog);
      call.watchdog = undefined;
      if (call.pending && !call.pending.settled) call.pending.resolve("");
    }
  }
}
