/**
 * The phone-call provider abstraction (PLAN C.14).
 *
 * Everything provider-specific sits behind `VoiceCallProvider`: webhook
 * signature checks, the markup dialect, the REST client and the shape of the
 * webhook fields. The routes, the call flow, the service and the channel
 * adapter in `@kirie/channel-voice` are written once against this interface
 * and never name a provider.
 */

export type VoiceProviderName = "twilio" | "plivo";

export const VOICE_PROVIDER_NAMES: readonly VoiceProviderName[] = ["twilio", "plivo"];

export function isVoiceProviderName(value: unknown): value is VoiceProviderName {
  return value === "twilio" || value === "plivo";
}

export interface VoiceWebhookRequest {
  /** HTTP method of the webhook. Only POST is ever accepted. */
  method: string;
  /** The exact public URL the provider called, including the query string. */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed form body. */
  params: Record<string, string | string[]>;
}

export type VoiceCallStatus =
  | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled";

/** Provider fields normalised. */
export interface VoiceCallEvent {
  /** Twilio CallSid, Plivo CallUUID. Empty string when the webhook carried none. */
  providerCallId: string;
  /** Twilio AccountSid. Plivo webhooks carry none. */
  accountId?: string;
  /** E.164 with "+", or null for withheld or unparseable numbers. */
  from: string | null;
  to: string | null;
  direction: "inbound" | "outbound";
  status?: VoiceCallStatus;
  speech?: string;
  speechConfidence?: number;
  digits?: string;
  durationSeconds?: number;
}

export interface SpeechOpts {
  language: string;
  voice: string;
}

/** Builds the provider's call-control XML. Every text field is XML-escaped inside; no string templates elsewhere. */
export interface VoiceMarkup {
  /** "text/xml" for both providers. */
  readonly contentType: string;
  reject(reason?: "rejected" | "busy"): string;
  sayAndHangup(text: string, v: SpeechOpts): string;
  gatherPin(o: { action: string; digits: number; prompt: string } & SpeechOpts): string;
  gatherSpeech(o: {
    action: string;
    say?: string[];
    timeoutSeconds: number;
    speechEndSeconds: number;
    hints?: string[];
    fallthroughRedirect: string;
  } & SpeechOpts): string;
  holdAndRedirect(o: { say?: string; pauseSeconds?: number; redirect: string } & SpeechOpts): string;
}

export interface VoiceCreateCallParams {
  /** E.164 with "+". */
  to: string;
  /** E.164 with "+". */
  from: string;
  answerUrl: string;
  statusUrl: string;
  timeLimitSeconds: number;
  ringTimeoutSeconds: number;
  machineDetection?: boolean;
}

export interface VoiceCallProvider {
  readonly name: VoiceProviderName;
  /** "/voice/twilio" | "/voice/plivo" */
  readonly routePrefix: string;
  readonly markup: VoiceMarkup;
  /** Chunk size for one spoken element. */
  readonly maxSayChars: number;
  /** The provider's default voice for the say elements. */
  readonly voice: string;
  /** The configured caller id in E.164, or null when absent or invalid. */
  readonly fromNumber: string | null;
  /** Names of what is missing ("plivo.authToken", "plivo.fromNumber"). Empty array means usable. */
  missing(): string[];
  /** Constant-time. False for a missing header, a wrong signature, a non-POST request, or (Twilio) a wrong AccountSid. Never throws. */
  verifyWebhook(req: VoiceWebhookRequest): boolean;
  parseEvent(req: VoiceWebhookRequest, direction: "inbound" | "outbound"): VoiceCallEvent;
  /** Twilio returns the call id; Plivo returns only a request id, the call id arrives on the answer webhook. */
  createCall(p: VoiceCreateCallParams): Promise<{ providerCallId?: string; requestId?: string }>;
  /** Throws on an empty id. Throws on a non-2xx response. */
  endCall(providerCallId: string): Promise<void>;
  /** Secret values this provider holds, for scrubber.addKnownSecret. */
  secrets(): string[];
}

/** The fetch signature the REST clients use (injected, so tests mock it). */
export type VoiceFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** A config or secret value that is absent, blank, or still an unresolved `$credential:` reference. */
export function isUnsetSecret(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || /^\$credential:/.test(trimmed);
}

/** First value of a form field. */
export function formValue(params: Record<string, string | string[]>, name: string): string | undefined {
  const v = params[name];
  if (Array.isArray(v)) return v[0];
  return v;
}
