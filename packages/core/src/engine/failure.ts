/**
 * Failure classification for every SDK call site.
 *
 * A failed turn reaches Kirie in two shapes: a returned `result` message with
 * `is_error: true` (streaming-input sessions), or a thrown
 * `Error("Claude Code returned an error result: <text>")` (one-shot paths, and
 * any path whose subprocess exits non-zero). Both are classified here.
 *
 * Structured signals (rate_limit_event, SDKAssistantMessage.error,
 * api_error_status, terminal_reason) win over text. The text fallback exists
 * because the thrown shape carries nothing else.
 *
 * Note: this module must not import runtime values from the SDK. Engine tests
 * mock "@anthropic-ai/claude-agent-sdk" with only `query`, so a value import
 * here would break every one of them. The usage-limit prefixes are copied below
 * and a test asserts they still match the SDK's own list.
 */

import type { Logger } from "pino";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentErrorUserMessage, extractResetHint } from "./agent-errors.js";
import { isTransientNetworkError } from "./network-errors.js";
import { formatResetTime, parseResetTime } from "./reset-time.js";

export type FailureClass =
  | "usage_limit_account" | "usage_limit_model" | "auth" | "model_unavailable"
  | "overloaded" | "prompt_too_long" | "network" | "session_start" | "unknown";

export interface FailureInfo {
  class: FailureClass;
  /** Scrubbed, at most 200 chars. For logs; never shown to a user verbatim. */
  message: string;
  /** Absolute epoch ms when known. */
  resetAtMs?: number;
  /** Display text, e.g. "4am (Africa/Cairo)". */
  resetHint?: string;
  /** five_hour | seven_day | seven_day_opus | ... */
  limitType?: string;
  apiStatus?: number;
}

/** Accumulated per turn by the stream consumers. */
export interface TurnSignals {
  rateLimit?: { status: string; resetsAt?: number; rateLimitType?: string };
  /** SDKAssistantMessage.error */
  assistantError?: string;
  apiErrorStatus?: number | null;
  terminalReason?: string;
  model?: string;
}

/**
 * Failure classes after which retrying in a fresh session cannot help and the
 * session mapping must be kept: the same account and model will fail again.
 */
export const NO_FRESH_RETRY_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "usage_limit_account",
  "usage_limit_model",
  "auth",
  "model_unavailable",
  "overloaded",
]);

/** True for a failure that must not trigger a session wipe or a fresh-session retry. */
export function isHardFailure(failure: FailureInfo | null | undefined): failure is FailureInfo {
  return !!failure && NO_FRESH_RETRY_CLASSES.has(failure.class);
}

/** True for either usage-limit class. */
export function isUsageLimit(failure: FailureInfo | null | undefined): failure is FailureInfo {
  return !!failure && (failure.class === "usage_limit_account" || failure.class === "usage_limit_model");
}

/**
 * Copy of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` (0.3.283). See the module note
 * for why it is copied; failure.test.ts checks it against the real export.
 */
export const USAGE_LIMIT_PREFIXES: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

const SDK_ERROR_WRAPPER = /^Claude Code returned an error result:\s*/i;

// ---------------------------------------------------------------------------
// Optional scrubber for FailureInfo.message
// ---------------------------------------------------------------------------

let messageScrubber: ((text: string) => string) | null = null;

/**
 * Install the secret scrubber used on FailureInfo.message. The scrubber is
 * built by another workstream; the daemon wires it at startup. Pass null to remove.
 */
export function setFailureMessageScrubber(fn: ((text: string) => string) | null): void {
  messageScrubber = fn;
}

function sanitizeMessage(text: string): string {
  const flat = text.replace(SDK_ERROR_WRAPPER, "").replace(/\s+/g, " ").trim();
  let out = flat;
  if (messageScrubber) {
    try {
      out = messageScrubber(flat);
    } catch {
      out = "[unscrubbable error text]";
    }
  }
  return out.length > 200 ? `${out.slice(0, 197)}...` : out;
}

// ---------------------------------------------------------------------------
// Turn signals
// ---------------------------------------------------------------------------

export function newTurnSignals(): TurnSignals {
  return {};
}

/** Fold one SDK message into the turn's signals. Never throws. */
export function feedTurnSignals(acc: TurnSignals, msg: SDKMessage): void {
  switch (msg.type) {
    case "rate_limit_event": {
      const info = msg.rate_limit_info;
      acc.rateLimit = {
        status: info.status,
        ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
        ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
      };
      break;
    }
    case "assistant": {
      if (msg.error) acc.assistantError = msg.error;
      const model = (msg.message as { model?: unknown } | undefined)?.model;
      if (typeof model === "string" && model && model !== "<synthetic>") acc.model = model;
      break;
    }
    case "result": {
      if ("api_error_status" in msg && msg.api_error_status != null) acc.apiErrorStatus = msg.api_error_status;
      if (msg.terminal_reason) acc.terminalReason = msg.terminal_reason;
      break;
    }
    case "system": {
      if (msg.subtype === "api_retry" && msg.error_status != null) acc.apiErrorStatus = msg.error_status;
      break;
    }
    default:
      break;
  }
}

/**
 * Log rate-limit events and error results without their content (PLAN D.3 E4).
 * The first real limit after shipping shows what the stream really carries.
 */
export function logSdkSignal(logger: Logger, label: string, msg: SDKMessage): void {
  if (msg.type === "rate_limit_event") {
    const info = msg.rate_limit_info;
    const fields = {
      label,
      status: info.status,
      rateLimitType: info.rateLimitType,
      resetsAt: info.resetsAt,
      utilization: info.utilization,
      overageStatus: info.overageStatus,
    };
    if (info.status === "allowed") logger.info(fields, "sdk rate_limit_event");
    else logger.warn(fields, "sdk rate_limit_event");
  } else if (msg.type === "result" && msg.is_error) {
    logger.warn(
      {
        label,
        subtype: msg.subtype,
        apiErrorStatus: "api_error_status" in msg ? msg.api_error_status : undefined,
        terminalReason: msg.terminal_reason,
        numTurns: msg.num_turns,
      },
      "sdk error result",
    );
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const AUTH_ASSISTANT_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error",
]);

const AUTH_TEXT = [
  /not logged in/i,
  /oauth access token has expired/i,
  /failed to authenticate/i,
  /disabled claude subscription access/i,
  /credit balance is too low/i,
  /invalid api key/i,
  /authentication_error/i,
  /please run \/login/i,
];

const MODEL_TEXT = [
  /does not support this model/i,
  /model[_ ]not[_ ]found/i,
  /not_found_error[^\n]{0,80}model/i,
  /model[^\n]{0,40}(?:is not available|does not exist|is unavailable)/i,
];

const PROMPT_TOO_LONG_TEXT = [/prompt is too long/i, /prompt too long/i, /context (?:length|window) exceeded/i];

const OVERLOADED_TEXT = [
  /overloaded/i,
  /temporarily limiting requests/i,
  /\brate[ _]limit/i,
  /too many requests/i,
  /request rejected \(429\)/i,
  /api error:\s*(?:429|5\d\d)\b/i,
  /internal server error/i,
  /temporary capacity issue/i,
];

const NETWORK_TEXT = [
  /unable to connect to api/i,
  /connection dropped/i,
  /response stalled/i,
  /\bE(?:CONNRESET|CONNREFUSED|NOTFOUND|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b/,
  /fetch failed/i,
  /socket hang up/i,
];

/** Same phrases agent-errors.ts used for session failures. */
const SESSION_START_TEXT = [
  /failed to spawn/i,
  /spawn/i,
  /resume/i,
  /process exited/i,
  /session not found/i,
  /no such session/i,
  /session stream ended without producing a result/i,
];

/** Older CLI shape: "Claude AI usage limit reached|1791915000". */
const LEGACY_USAGE_RE = /usage limit reached\|(\d{10,13})/i;
/** Start of a line, after the optional SDK wrapper and "API Error: <status>" prefixes. */
const LINE_LEAD =
  "^\\s*(?:Claude Code returned an error result:\\s*)?(?:API Error:\\s*(?:\\d{3}\\s*)?)?";
const USAGE_PHRASE_RE = new RegExp(`${LINE_LEAD}you've (?:hit|reached) your (.{0,40}?)\\s*limit`, "im");
const LINE_LEAD_RE = new RegExp(LINE_LEAD, "i");
const LEGACY_USAGE_TEXT = [/usage limit reached/i, /quota exceeded/i, /exceeded your quota/i, /insufficient credits/i];
const MODEL_FAMILY_RE = /\b(opus|sonnet|haiku|fable|fast)\b/i;

const FAILURE_TERMINAL_REASONS = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "model_error",
  "api_error",
  "image_error",
  "turn_setup_failed",
]);

function errorToText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === undefined || error === null) return "";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function normaliseEpoch(v: number): number {
  return v < 1e12 ? v * 1000 : v;
}

interface UsageMatch {
  cls: "usage_limit_account" | "usage_limit_model";
  limitType?: string;
}

/** Usage-limit text, with the scope (account or model) and the limit name when readable. */
function usageFromText(text: string): UsageMatch | null {
  const body = text.replace(SDK_ERROR_WRAPPER, "");
  const phrase = USAGE_PHRASE_RE.exec(body);
  // Prefixes count only at the start of a line, so a reply that merely
  // mentions "you've reached your ..." is not taken for a limit.
  const lines = body.split("\n").map((line) => line.replace(LINE_LEAD_RE, "").toLowerCase());
  const hasPrefix = USAGE_LIMIT_PREFIXES.some((p) => lines.some((line) => line.startsWith(p.toLowerCase())));
  const legacy = LEGACY_USAGE_TEXT.some((re) => re.test(body));
  if (!phrase && !hasPrefix && !legacy) return null;

  const name = (phrase?.[1] ?? body.slice(0, 120)).toLowerCase();
  const family = MODEL_FAMILY_RE.exec(name)?.[1];
  let limitType: string | undefined;
  if (/\bsession\b/.test(name)) limitType = "five_hour";
  else if (/\bweekly\b/.test(name)) limitType = family && family !== "fast" ? `seven_day_${family}` : "seven_day";
  else if (/monthly spend/.test(name)) limitType = "monthly_spend";
  else if (family === "fast") limitType = "fast";

  return {
    cls: family ? "usage_limit_model" : "usage_limit_account",
    ...(limitType ? { limitType } : {}),
  };
}

function hasFailureSignal(s: TurnSignals): boolean {
  return (
    !!s.assistantError ||
    (typeof s.apiErrorStatus === "number" && s.apiErrorStatus >= 400) ||
    s.rateLimit?.status === "rejected" ||
    (!!s.terminalReason && FAILURE_TERMINAL_REASONS.has(s.terminalReason))
  );
}

interface Detected {
  cls: FailureClass;
  limitType?: string;
}

function detect(text: string, s: TurnSignals, error: unknown): Detected | null {
  // 1. Rate-limit event that rejected the request.
  if (s.rateLimit?.status === "rejected") {
    const type = s.rateLimit.rateLimitType;
    const perModel = type === "seven_day_opus" || type === "seven_day_sonnet";
    return { cls: perModel ? "usage_limit_model" : "usage_limit_account", ...(type ? { limitType: type } : {}) };
  }

  // 2. The assistant message's structured error.
  const ae = s.assistantError;
  if (ae) {
    if (AUTH_ASSISTANT_ERRORS.has(ae)) return { cls: "auth" };
    if (ae === "model_not_found") return { cls: "model_unavailable" };
    if (ae === "rate_limit") {
      const usage = usageFromText(text);
      // A 429 without a usage-limit message is transient capacity, never an exhausted account.
      return usage ? { cls: usage.cls, ...(usage.limitType ? { limitType: usage.limitType } : {}) } : { cls: "overloaded" };
    }
    if (ae === "overloaded" || ae === "server_error") return { cls: "overloaded" };
  }

  // 3. Usage-limit text (also covers the thrown shape, which has no signals).
  const usage = usageFromText(text);
  if (usage) return { cls: usage.cls, ...(usage.limitType ? { limitType: usage.limitType } : {}) };

  // 4. HTTP status of the failing API call.
  const status = s.apiErrorStatus;
  if (typeof status === "number") {
    if (status === 401 || status === 403) return { cls: "auth" };
    if (status === 413) return { cls: "prompt_too_long" };
    if (status === 429 || status === 529 || (status >= 500 && status < 600)) return { cls: "overloaded" };
  }

  // 5. Why the turn stopped.
  switch (s.terminalReason) {
    case "prompt_too_long": return { cls: "prompt_too_long" };
    case "model_error": return { cls: "model_unavailable" };
    case "blocking_limit": return { cls: "usage_limit_account" };
    default: break;
  }

  // 6. Text fallback for everything else.
  if (AUTH_TEXT.some((re) => re.test(text))) return { cls: "auth" };
  if (MODEL_TEXT.some((re) => re.test(text))) return { cls: "model_unavailable" };
  if (PROMPT_TOO_LONG_TEXT.some((re) => re.test(text))) return { cls: "prompt_too_long" };
  if (OVERLOADED_TEXT.some((re) => re.test(text))) return { cls: "overloaded" };
  if (NETWORK_TEXT.some((re) => re.test(text)) || isTransientNetworkError(error)) return { cls: "network" };
  if (SESSION_START_TEXT.some((re) => re.test(text))) return { cls: "session_start" };
  return null;
}

/**
 * Classify a failed turn.
 *
 * Returns null when nothing indicates a failure: no `error`, no failure signal,
 * and text that matches no known failure. With an `error`, or with a failure
 * signal, the result is at least `unknown`.
 */
export function classifyFailure(input: {
  text?: string;
  signals?: TurnSignals;
  error?: unknown;
  /** Current time for reset parsing (tests). Default Date.now(). */
  now?: number;
  /** Zone used for a reset time that names none. */
  defaultTz?: string;
}): FailureInfo | null {
  const signals = input.signals ?? {};
  const errText = input.error !== undefined ? errorToText(input.error) : "";
  const text = [input.text ?? "", errText].filter(Boolean).join("\n");
  const now = input.now ?? Date.now();

  const found = detect(text, signals, input.error);
  if (!found && input.error === undefined && !hasFailureSignal(signals)) return null;

  const cls: FailureClass = found?.cls ?? "unknown";
  const info: FailureInfo = {
    class: cls,
    message: sanitizeMessage(text || signals.assistantError || signals.terminalReason || cls),
  };
  if (typeof signals.apiErrorStatus === "number") info.apiStatus = signals.apiErrorStatus;

  if (cls === "usage_limit_account" || cls === "usage_limit_model") {
    if (found?.limitType) info.limitType = found.limitType;

    const resetsAt = signals.rateLimit?.resetsAt;
    const legacy = LEGACY_USAGE_RE.exec(text);
    if (typeof resetsAt === "number" && resetsAt > 0) {
      info.resetAtMs = normaliseEpoch(resetsAt);
    } else if (legacy) {
      info.resetAtMs = normaliseEpoch(Number(legacy[1]));
    } else {
      const parsed = parseResetTime(text, now, input.defaultTz);
      if (parsed !== undefined) info.resetAtMs = parsed;
    }

    const hint = extractResetHint(text.replace(SDK_ERROR_WRAPPER, ""));
    if (hint) info.resetHint = hint;
    else if (info.resetAtMs !== undefined) info.resetHint = formatResetTime(info.resetAtMs, input.defaultTz);
  }

  return info;
}

// ---------------------------------------------------------------------------
// Carrying a classification on a thrown error
// ---------------------------------------------------------------------------

const errorFailures = new WeakMap<object, FailureInfo>();

/** Remember the classification of a thrown error so callers further up do not reclassify blind. */
export function attachFailure<E>(error: E, failure: FailureInfo): E {
  if (error !== null && typeof error === "object") errorFailures.set(error, failure);
  return error;
}

/** The classification attached by an engine, if any. */
export function failureOf(error: unknown): FailureInfo | undefined {
  return error !== null && typeof error === "object" ? errorFailures.get(error) : undefined;
}

// ---------------------------------------------------------------------------
// Stored task errors
// ---------------------------------------------------------------------------

/** Matches the class tag formatTaskFailure appends. */
const TASK_FAILURE_TAG_RE = /\s\[(usage_limit_account|usage_limit_model|auth|model_unavailable|overloaded)\]$/;

/** Error text stored on a task that ended on a hard failure: the user-safe sentence plus a class tag. */
export function formatTaskFailure(failure: FailureInfo): string {
  return `${agentErrorUserMessage(failure)} [${failure.class}]`;
}

/**
 * The user-safe sentence of a task error written by formatTaskFailure, or
 * null for any other error text, which may carry internals and must not be
 * shown in a chat.
 */
export function userFacingTaskError(error: string | null | undefined): string | null {
  if (!error || !TASK_FAILURE_TAG_RE.test(error)) return null;
  return error.replace(TASK_FAILURE_TAG_RE, "");
}
