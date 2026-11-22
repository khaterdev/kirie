/**
 * Classification of agent execution failures into user-facing categories.
 *
 * The pipeline catches everything the agent executor throws and has to turn it
 * into a single sentence for the user. Getting that sentence wrong is not
 * cosmetic: telling someone to "try again" when they are rate limited sends
 * them into a retry loop that cannot succeed, and claiming their context was
 * reset when it was not destroys trust in every future error message.
 *
 * Classification is deliberately ordered — usage limits are checked before
 * session failures, because the SDK's own limit message ("You've hit your
 * session limit") contains the word "session" and would otherwise be
 * misreported as a broken session.
 */

import type { FailureInfo } from "./failure.js";

/** What kind of failure the agent executor reported. */
export type AgentErrorKind =
  /** The account hit a usage/rate/session limit. Retrying cannot help. */
  | "usage_limit"
  /** The agent subprocess could not be started or resumed. */
  | "session_start"
  /** Anything else — surfaced generically so internals are never leaked. */
  | "unknown";

export interface AgentErrorInfo {
  kind: AgentErrorKind;
  /**
   * For `usage_limit`, the reset hint lifted verbatim from the provider
   * message (e.g. "2:30am (Africa/Cairo)"), when one was present.
   */
  resetHint?: string;
}

/**
 * Phrases that mean "you are out of budget", not "something is broken".
 * Checked first — several of these contain words the session matcher claims.
 */
const USAGE_LIMIT_PATTERNS = [
  // The CLI's own shape: "You've hit your <session|weekly|fast|monthly spend> limit".
  "you've hit your",
  "you've reached your",
  "session limit",
  "weekly limit",
  "usage limit",
  "rate limit",
  "rate_limit",
  "rate_limit_error",
  "too many requests",
  "quota exceeded",
  "exceeded your quota",
  "credit balance is too low",
  "insufficient credits",
  "usage limit reached",
];

/**
 * Phrases that mean the agent subprocess genuinely failed to come up. Only
 * consulted once a usage limit has been ruled out.
 */
const SESSION_START_PATTERNS = [
  "failed to spawn",
  "spawn",
  "resume",
  "process exited",
  "session not found",
  "no such session",
];

/**
 * Pull the reset time out of a provider limit message.
 *
 * Matches the SDK's shape — "... · resets 2:30am (Africa/Cairo)" — and stops
 * at a separator or end of line. Deliberately conservative: the result is
 * echoed to the user, so anything long or path-like is discarded rather than
 * risk leaking internals into a chat message.
 *
 * Note that a bare slash cannot be rejected outright: IANA timezone names
 * ("Africa/Cairo") legitimately contain one. The guards below target the
 * shapes a filesystem path or stack frame actually takes instead.
 */
const PATH_LIKE = /^[/\\~]|:\/\/|\.(?:ts|js|mjs|cjs|json)\b|\bat\s+\S+:\d+/i;

export function extractResetHint(message: string): string | undefined {
  const match = /\bresets?\s+(?:at\s+)?([^·|\n]+)/i.exec(message);
  if (!match) return undefined;

  const hint = match[1]!.trim().replace(/[.\s]+$/, "");
  if (!hint) return undefined;
  // Guard against absorbing a stack trace or file path into user-facing text.
  if (hint.length > 60 || PATH_LIKE.test(hint)) return undefined;

  return hint;
}

/**
 * Classify an agent execution failure.
 */
export function classifyAgentError(err: unknown): AgentErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.toLowerCase();

  if (USAGE_LIMIT_PATTERNS.some((p) => msg.includes(p))) {
    const resetHint = extractResetHint(raw);
    return resetHint ? { kind: "usage_limit", resetHint } : { kind: "usage_limit" };
  }

  if (SESSION_START_PATTERNS.some((p) => msg.includes(p))) {
    return { kind: "session_start" };
  }

  return { kind: "unknown" };
}

const USAGE_LIMIT_NO_RESET = "Usage limit reached on the account. Retrying won't help until it resets.";
const GENERIC_ERROR = "Sorry, an internal error occurred. Please try again.";
const SESSION_START_ERROR = "Failed to start AI session. Context has been reset — please try again.";

function usageLimitMessage(resetHint: string | undefined): string {
  return resetHint
    ? `Usage limit reached — no capacity until ${resetHint}. Retrying before then won't work; message me after it resets.`
    : USAGE_LIMIT_NO_RESET;
}

function isFailureInfo(info: AgentErrorInfo | FailureInfo): info is FailureInfo {
  return "class" in info;
}

/**
 * Render the single sentence the user actually sees.
 *
 * Accepts the legacy {@link AgentErrorInfo} or a {@link FailureInfo} from
 * `classifyFailure`. Only the reset hint is ever interpolated from the
 * underlying error; every other byte is a fixed string, so internal details
 * cannot leak here. The hint itself passed `extractResetHint`'s guards or was
 * formatted from a timestamp.
 */
export function agentErrorUserMessage(info: AgentErrorInfo | FailureInfo): string {
  if (isFailureInfo(info)) {
    switch (info.class) {
      case "usage_limit_account":
      case "usage_limit_model":
        return usageLimitMessage(info.resetHint);
      case "auth":
        return "The AI account is signed out or blocked, so I can't answer right now. The owner needs to log in to Claude again; retrying won't help until then.";
      case "model_unavailable":
        return "The configured AI model isn't available right now. Retrying won't help until the model setting changes.";
      case "overloaded":
        return "The AI service is overloaded or limiting requests right now. Please try again in a few minutes.";
      case "prompt_too_long":
        return "This conversation has grown too long for the model. Send /clear to start fresh, then try again.";
      case "session_start":
        return SESSION_START_ERROR;
      case "network":
      case "unknown":
        return GENERIC_ERROR;
    }
  }

  switch (info.kind) {
    case "usage_limit":
      return usageLimitMessage(info.resetHint);
    case "session_start":
      return SESSION_START_ERROR;
    case "unknown":
      return GENERIC_ERROR;
  }
}
