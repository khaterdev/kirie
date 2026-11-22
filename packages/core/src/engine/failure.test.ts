import { describe, it, expect, afterEach } from "vitest";
import { USAGE_LIMIT_ERROR_PREFIXES, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  attachFailure,
  classifyFailure,
  failureOf,
  feedTurnSignals,
  formatTaskFailure,
  isHardFailure,
  newTurnSignals,
  setFailureMessageScrubber,
  userFacingTaskError,
  USAGE_LIMIT_PREFIXES,
  type FailureClass,
} from "./failure.js";
import { agentErrorUserMessage } from "./agent-errors.js";

const WRAP = "Claude Code returned an error result: ";
const NOW = new Date("2026-11-23T10:00:00Z").getTime();

/** Every failure string from R1 section 0.3 (daemon.out.log), with its expected class. */
const REAL_LOG_STRINGS: Array<[string, FailureClass]> = [
  [`${WRAP}You've hit your session limit · resets 2:30am (Africa/Cairo)`, "usage_limit_account"],
  [`${WRAP}You've hit your session limit · resets 4am (Africa/Cairo)`, "usage_limit_account"],
  [`${WRAP}You've hit your weekly limit · resets 5pm (Africa/Cairo)`, "usage_limit_account"],
  [`${WRAP}You've hit your weekly limit · resets Aug 11 at 5pm (Africa/Cairo)`, "usage_limit_account"],
  [`${WRAP}You've hit your weekly limit · resets Oct 13 at 5pm (Africa/Cairo)`, "usage_limit_account"],
  ["Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.", "auth"],
  ["Not logged in · Please run /login", "auth"],
  [
    "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin",
    "auth",
  ],
  ["API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.280 or newer is required.", "model_unavailable"],
  ["API Error: Unable to connect to API (ENOTFOUND)", "network"],
  ["API Error: Connection dropped (ECONNRESET)", "network"],
  ["API Error: Response stalled mid-stream", "network"],
  ["Claude Code process exited with code 1", "session_start"],
];

afterEach(() => setFailureMessageScrubber(null));

describe("classifyFailure: real log strings (R1 0.3)", () => {
  it.each(REAL_LOG_STRINGS)("thrown %j -> %s", (text, expected) => {
    const info = classifyFailure({ error: new Error(text), now: NOW });
    expect(info?.class).toBe(expected);
  });

  it.each(REAL_LOG_STRINGS)("returned error result %j -> %s", (text, expected) => {
    const info = classifyFailure({ text, signals: newTurnSignals(), now: NOW });
    expect(info?.class).toBe(expected);
  });

  it("reads the reset hint and time from a session limit", () => {
    const info = classifyFailure({
      error: new Error(`${WRAP}You've hit your session limit · resets 2:30am (Africa/Cairo)`),
      now: NOW,
    })!;
    expect(info.limitType).toBe("five_hour");
    expect(info.resetHint).toBe("2:30am (Africa/Cairo)");
    expect(info.resetAtMs).toBe(new Date("2026-11-24T00:30:00Z").getTime() + 60_000);
  });

  it("treats a weekly limit as a usage limit with its reset time (the most common real limit)", () => {
    const info = classifyFailure({
      error: new Error(`${WRAP}You've hit your weekly limit · resets Nov 25 at 5pm (Africa/Cairo)`),
      now: NOW,
    })!;
    expect(info.class).toBe("usage_limit_account");
    expect(info.limitType).toBe("seven_day");
    expect(info.resetHint).toBe("Nov 25 at 5pm (Africa/Cairo)");
    const text = agentErrorUserMessage(info);
    expect(text).toContain("Usage limit reached");
    expect(text).toContain("Nov 25 at 5pm (Africa/Cairo)");
  });

  it("classifies fast and model-named limits as model-scoped, monthly spend as account-wide", () => {
    expect(classifyFailure({ text: "You've hit your fast limit · resets 4am (UTC)", now: NOW })!.class).toBe(
      "usage_limit_model",
    );
    const opus = classifyFailure({ text: "You've hit your weekly Opus limit · resets 5pm (UTC)", now: NOW })!;
    expect(opus.class).toBe("usage_limit_model");
    expect(opus.limitType).toBe("seven_day_opus");
    const spend = classifyFailure({ text: "You've hit your monthly spend limit · raise it in the console", now: NOW })!;
    expect(spend.class).toBe("usage_limit_account");
    expect(spend.limitType).toBe("monthly_spend");
    expect(spend.resetAtMs).toBeUndefined();
  });

  it("recognises every SDK usage-limit prefix", () => {
    for (const prefix of USAGE_LIMIT_PREFIXES) {
      const cls = classifyFailure({ text: `${prefix} something`, now: NOW })?.class;
      expect(cls === "usage_limit_account" || cls === "usage_limit_model").toBe(true);
    }
  });

  it("reads the epoch from the legacy 'usage limit reached|<epoch>' shape", () => {
    const info = classifyFailure({ error: new Error("Claude AI usage limit reached|1791915000"), now: NOW })!;
    expect(info.class).toBe("usage_limit_account");
    expect(info.resetAtMs).toBe(1791915000 * 1000);
  });
});

describe("classifyFailure: structured signals win over text", () => {
  it("a rejected seven_day_opus rate_limit_event makes the failure model-scoped, with resetsAt in seconds", () => {
    const signals = newTurnSignals();
    feedTurnSignals(signals, {
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1791915000, rateLimitType: "seven_day_opus" },
      uuid: "u",
      session_id: "s",
    } as SDKMessage);
    const info = classifyFailure({ text: "You've hit your session limit · resets 4am (Africa/Cairo)", signals, now: NOW })!;
    expect(info.class).toBe("usage_limit_model");
    expect(info.limitType).toBe("seven_day_opus");
    expect(info.resetAtMs).toBe(1791915000 * 1000);
    // The text hint is still preferred for display.
    expect(info.resetHint).toBe("4am (Africa/Cairo)");
  });

  it("formats a display hint from resetsAt when the text has none", () => {
    const info = classifyFailure({
      signals: { rateLimit: { status: "rejected", resetsAt: 1791915000, rateLimitType: "five_hour" } },
      defaultTz: "Africa/Cairo",
      now: NOW,
    })!;
    expect(info.class).toBe("usage_limit_account");
    expect(info.resetHint).toMatch(/\(Africa\/Cairo\)$/);
  });

  it("an assistant authentication_failed error is auth even when the text looks like something else", () => {
    expect(classifyFailure({ text: "API Error: 500 Internal server error", signals: { assistantError: "authentication_failed" } })!.class).toBe("auth");
  });

  it("model_not_found and model_error terminal reason are model_unavailable", () => {
    expect(classifyFailure({ signals: { assistantError: "model_not_found" } })!.class).toBe("model_unavailable");
    expect(classifyFailure({ signals: { terminalReason: "model_error" } })!.class).toBe("model_unavailable");
  });

  it("prompt_too_long terminal reason", () => {
    expect(classifyFailure({ signals: { terminalReason: "prompt_too_long" } })!.class).toBe("prompt_too_long");
  });
});

describe("classifyFailure: overload is never a usage limit", () => {
  it("rate_limit assistant error without a usage-limit message is overloaded", () => {
    const info = classifyFailure({ text: "API Error: 429 rate_limit_error", signals: { assistantError: "rate_limit", apiErrorStatus: 429 } })!;
    expect(info.class).toBe("overloaded");
    expect(isHardFailure(info)).toBe(true);
  });

  it("rate_limit assistant error WITH a usage-limit message is a usage limit", () => {
    const info = classifyFailure({
      text: "You've hit your session limit · resets 9:10pm (Africa/Cairo)",
      signals: { assistantError: "rate_limit", apiErrorStatus: 429 },
      now: NOW,
    })!;
    expect(info.class).toBe("usage_limit_account");
  });

  it.each([
    "API Error: Server is temporarily limiting requests (not your usage limit)",
    "API Error: Request rejected (429) · this may be a temporary capacity issue",
    "API Error: 529 overloaded_error",
    "rate limit exceeded",
    "429 Too Many Requests",
  ])("%j is overloaded", (text) => {
    expect(classifyFailure({ error: new Error(text) })!.class).toBe("overloaded");
  });

  it("status 529 and overloaded assistant error", () => {
    expect(classifyFailure({ signals: { apiErrorStatus: 529 } })!.class).toBe("overloaded");
    expect(classifyFailure({ signals: { assistantError: "overloaded" } })!.class).toBe("overloaded");
  });
});

describe("classifyFailure: null and unknown", () => {
  it("returns null for ordinary text with no error and no failure signal", () => {
    expect(classifyFailure({ text: "Here is your answer." })).toBeNull();
    expect(classifyFailure({})).toBeNull();
  });

  it("returns unknown for an unrecognised thrown error", () => {
    expect(classifyFailure({ error: new Error("SDK session expired") })!.class).toBe("unknown");
    expect(classifyFailure({ error: "boom" })!.class).toBe("unknown");
  });

  it("keeps the message short, strips the SDK wrapper and runs the scrubber", () => {
    setFailureMessageScrubber((t) => t.replace(/tok_[a-z0-9]+/g, "[redacted]"));
    const secret = ["tok", "abc123"].join("_");
    const info = classifyFailure({ error: new Error(`${WRAP}You've hit your session limit ${secret} ${"x".repeat(400)}`) })!;
    expect(info.message.startsWith("You've hit your session limit [redacted]")).toBe(true);
    expect(info.message).not.toContain(secret);
    expect(info.message.length).toBeLessThanOrEqual(200);
  });
});

describe("feedTurnSignals", () => {
  it("collects rate limit, assistant error, model, api status and terminal reason", () => {
    const s = newTurnSignals();
    feedTurnSignals(s, { type: "assistant", message: { model: "claude-opus-4-8", content: [] }, parent_tool_use_id: null, uuid: "u", session_id: "x" } as unknown as SDKMessage);
    feedTurnSignals(s, { type: "assistant", message: { model: "<synthetic>", content: [] }, error: "rate_limit", parent_tool_use_id: null, uuid: "u", session_id: "x" } as unknown as SDKMessage);
    feedTurnSignals(s, { type: "system", subtype: "api_retry", attempt: 1, max_retries: 3, retry_delay_ms: 1, error_status: 529, error: "overloaded", uuid: "u", session_id: "x" } as SDKMessage);
    feedTurnSignals(s, { type: "result", subtype: "success", is_error: true, api_error_status: 429, terminal_reason: "blocking_limit", result: "", num_turns: 1, total_cost_usd: 0 } as unknown as SDKMessage);
    expect(s).toEqual({
      model: "claude-opus-4-8",
      assistantError: "rate_limit",
      apiErrorStatus: 429,
      terminalReason: "blocking_limit",
    });
  });
});

describe("SDK prefix list", () => {
  it("matches the SDK's exported USAGE_LIMIT_ERROR_PREFIXES", () => {
    expect([...USAGE_LIMIT_PREFIXES].sort()).toEqual([...USAGE_LIMIT_ERROR_PREFIXES].sort());
  });
});

describe("attachFailure / failureOf", () => {
  it("carries a classification on a thrown error", () => {
    const err = new Error("x");
    expect(failureOf(err)).toBeUndefined();
    attachFailure(err, { class: "auth", message: "x" });
    expect(failureOf(err)?.class).toBe("auth");
    expect(failureOf("not an object")).toBeUndefined();
  });
});

describe("formatTaskFailure / userFacingTaskError", () => {
  it("round-trips a classified failure and rejects any other error text", () => {
    const failure = classifyFailure({ text: "You've hit your session limit · resets 4am (UTC)", now: NOW })!;
    const stored = formatTaskFailure(failure);
    expect(stored).toMatch(/\[usage_limit_account\]$/);
    expect(userFacingTaskError(stored)).toBe(agentErrorUserMessage(failure));
    expect(userFacingTaskError("Execution error: ENOENT /Users/someone/file")).toBeNull();
    expect(userFacingTaskError(null)).toBeNull();
  });
});
