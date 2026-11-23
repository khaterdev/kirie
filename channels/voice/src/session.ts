/**
 * In-memory state of live calls. A daemon restart drops it: the next webhook
 * for an old call carries an unknown token and gets 403, the provider ends the
 * call, and CallStore.recoverStale closes the record.
 */

import { randomBytes } from "node:crypto";
import type { CallMode, CallRole, VoiceProviderName } from "@kirie/voice";

export type LivePhase =
  /** Outbound, waiting for the callee to answer. */
  | "dialing"
  /** Inbound owner call, waiting for the DTMF PIN. */
  | "pin"
  /** Waiting for the caller to speak. */
  | "listening"
  /** A spoken turn is with the agent. */
  | "thinking"
  /** Outbound one-way message delivered; waiting for one optional reply. */
  | "say-reply"
  /** Inbound voicemail: waiting for the message. */
  | "voicemail"
  | "ended";

export interface PendingTurn {
  readonly turn: number;
  /** epoch ms when the turn was handed to the agent */
  readonly startedAt: number;
  readonly promise: Promise<string>;
  resolve(text: string): void;
  settled: boolean;
  /** The caller has been told the answer will arrive on Telegram, or the call ended mid-turn. */
  deferred: boolean;
}

export interface LiveCall {
  /** 128-bit random, in every action URL of this call. */
  readonly token: string;
  /** CallStore record id. */
  readonly callId: string;
  readonly provider: VoiceProviderName;
  /** Twilio CallSid / Plivo CallUUID. Plivo outbound calls learn it on the first webhook. */
  providerCallId: string | null;
  readonly direction: "inbound" | "outbound";
  /** E.164, or null for withheld caller ids. */
  readonly remote: string | null;
  readonly role: CallRole;
  readonly mode: CallMode;
  readonly alias?: string;
  phase: LivePhase;
  readonly startedAt: number;
  answeredAt?: number;
  /** epoch ms after which the call is wound down. */
  deadline: number;
  turn: number;
  emptyTurns: number;
  pinAttempts: number;
  pending: PendingTurn | null;
  /** Seconds the call may last once answered (outbound). */
  timeLimitSeconds?: number;
  /** Outbound "say": the words to speak. Outbound "talk": the purpose of the call. */
  message?: string;
  /** The last markup returned to /inbound, re-sent for a duplicate webhook. */
  lastMarkup?: string;
  /** Owner asked to hang up before the provider call id was known. */
  hangupRequested?: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
}

export function newCallToken(): string {
  return randomBytes(16).toString("hex");
}

export class LiveCallRegistry {
  private readonly calls = new Map<string, LiveCall>();

  add(call: LiveCall): void {
    this.calls.set(call.token, call);
  }

  remove(token: string): LiveCall | undefined {
    const call = this.calls.get(token);
    this.calls.delete(token);
    return call;
  }

  byToken(token: string): LiveCall | undefined {
    return this.calls.get(token);
  }

  byCallId(callId: string): LiveCall | undefined {
    for (const c of this.calls.values()) if (c.callId === callId) return c;
    return undefined;
  }

  byProviderCallId(provider: VoiceProviderName, providerCallId: string): LiveCall | undefined {
    if (!providerCallId) return undefined;
    for (const c of this.calls.values()) {
      if (c.provider === provider && c.providerCallId === providerCallId) return c;
    }
    return undefined;
  }

  all(): LiveCall[] {
    return [...this.calls.values()];
  }

  get size(): number {
    return this.calls.size;
  }
}

export function createPendingTurn(turn: number, startedAt: number): PendingTurn {
  let resolveFn!: (text: string) => void;
  const promise = new Promise<string>((resolve) => { resolveFn = resolve; });
  const pending: PendingTurn = {
    turn,
    startedAt,
    promise,
    settled: false,
    deferred: false,
    resolve(text: string) {
      if (pending.settled) return;
      pending.settled = true;
      resolveFn(text);
    },
  };
  return pending;
}

/** The pipeline session key for a voice conversation: one per phone number, independent of the provider. */
export function voiceSessionKey(e164: string): string {
  return `voice:dm:${e164}`;
}

/** UnifiedMessage id of a spoken turn; the pipeline echoes it back as replyToId. */
export function voiceTurnMessageId(token: string, turn: number): string {
  return `voice-${token}-${turn}`;
}

export function parseVoiceTurnMessageId(id: string | undefined): { token: string; turn: number } | null {
  if (!id) return null;
  const m = /^voice-([0-9a-f]{32})-(\d{1,6})$/.exec(id);
  return m ? { token: m[1]!, turn: Number(m[2]) } : null;
}
