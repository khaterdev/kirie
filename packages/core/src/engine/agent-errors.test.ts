import { describe, it, expect } from "vitest";
import { classifyAgentError, agentErrorUserMessage, extractResetHint } from "./agent-errors.js";

/** The verbatim error that silently blocked four messages on 2026-07-29. */
const REAL_LIMIT_ERROR =
  "Claude Code returned an error result: You've hit your session limit · resets 2:30am (Africa/Cairo)";

describe("classifyAgentError", () => {
  describe("usage limits", () => {
    it("classifies the real SDK session-limit error as a usage limit, not a session failure", () => {
      const info = classifyAgentError(new Error(REAL_LIMIT_ERROR));
      expect(info.kind).toBe("usage_limit");
      expect(info.resetHint).toBe("2:30am (Africa/Cairo)");
    });

    it("does not tell the user their context was reset when they are rate limited", () => {
      const text = agentErrorUserMessage(classifyAgentError(new Error(REAL_LIMIT_ERROR)));
      expect(text).not.toContain("Context has been reset");
      expect(text).not.toContain("please try again");
      expect(text).toContain("2:30am (Africa/Cairo)");
    });

    it.each([
      "You've hit your usage limit",
      "rate limit exceeded",
      "rate_limit_error: too many requests",
      "429 Too Many Requests",
      "Your credit balance is too low",
      "quota exceeded for this org",
    ])("classifies %j as a usage limit", (msg) => {
      expect(classifyAgentError(new Error(msg)).kind).toBe("usage_limit");
    });

    it("still reports a usage limit when no reset time is given", () => {
      const info = classifyAgentError(new Error("usage limit reached"));
      expect(info.kind).toBe("usage_limit");
      expect(info.resetHint).toBeUndefined();
      expect(agentErrorUserMessage(info)).toContain("Retrying won't help");
    });
  });

  describe("session failures", () => {
    it("classifies a subprocess exit as a session failure", () => {
      expect(classifyAgentError(new Error("Claude Code process exited with code 1")).kind)
        .toBe("session_start");
    });

    it.each(["failed to spawn claude", "could not resume session abc123"])(
      "classifies %j as a session failure",
      (msg) => {
        expect(classifyAgentError(new Error(msg)).kind).toBe("session_start");
      },
    );

    it("keeps the existing context-reset wording for genuine session failures", () => {
      const text = agentErrorUserMessage(classifyAgentError(new Error("failed to spawn claude")));
      expect(text).toBe("Failed to start AI session. Context has been reset — please try again.");
    });
  });

  describe("unknown errors", () => {
    it("falls back to the generic message", () => {
      const info = classifyAgentError(new Error("ECONNREFUSED 127.0.0.1:5432 at /home/user/db.ts:42"));
      expect(info.kind).toBe("unknown");
      expect(agentErrorUserMessage(info)).toBe("Sorry, an internal error occurred. Please try again.");
    });

    it("handles non-Error throws", () => {
      expect(classifyAgentError("boom").kind).toBe("unknown");
      expect(classifyAgentError(undefined).kind).toBe("unknown");
    });

    it("never leaks internal detail for unknown errors", () => {
      const text = agentErrorUserMessage(
        classifyAgentError(new Error("ECONNREFUSED database at /home/user/app/db.ts:42")),
      );
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("database");
      expect(text).not.toContain("/home/user");
    });
  });
});

describe("extractResetHint", () => {
  it("extracts the time from the SDK's separator format", () => {
    expect(extractResetHint("You've hit your session limit · resets 2:30am (Africa/Cairo)"))
      .toBe("2:30am (Africa/Cairo)");
  });

  it("handles the 'resets at' variant", () => {
    expect(extractResetHint("limit reached, resets at 9pm")).toBe("9pm");
  });

  it("returns undefined when there is no reset clause", () => {
    expect(extractResetHint("rate limit exceeded")).toBeUndefined();
  });

  it("rejects path-like text so stack traces cannot reach the user", () => {
    expect(extractResetHint("resets /Users/mostafa/secret/path.ts")).toBeUndefined();
  });

  it("rejects over-long captures", () => {
    expect(extractResetHint(`resets ${"x".repeat(80)}`)).toBeUndefined();
  });
});

describe("weekly, fast and monthly-spend limits", () => {
  it.each([
    "Claude Code returned an error result: You've hit your weekly limit · resets 5pm (Africa/Cairo)",
    "Claude Code returned an error result: You've hit your fast limit · resets 4am (Africa/Cairo)",
    "You've hit your monthly spend limit · raise it in the console",
  ])("classifyAgentError treats %j as a usage limit", (msg) => {
    expect(classifyAgentError(new Error(msg)).kind).toBe("usage_limit");
  });

  it("shows the weekly reset time", () => {
    const info = classifyAgentError(new Error("You've hit your weekly limit · resets Aug 11 at 5pm (Africa/Cairo)"));
    expect(agentErrorUserMessage(info)).toContain("Aug 11 at 5pm (Africa/Cairo)");
  });
});

describe("agentErrorUserMessage with a FailureInfo", () => {
  it("renders every class with a fixed sentence and only the reset hint interpolated", () => {
    const msg = (cls: Parameters<typeof agentErrorUserMessage>[0]) => agentErrorUserMessage(cls);
    expect(msg({ class: "usage_limit_account", message: "x", resetHint: "4am (Africa/Cairo)" })).toContain("4am (Africa/Cairo)");
    expect(msg({ class: "usage_limit_model", message: "x" })).toContain("Retrying won't help");
    expect(msg({ class: "auth", message: "secret detail" })).toContain("log in to Claude again");
    expect(msg({ class: "model_unavailable", message: "x" })).toContain("model isn't available");
    expect(msg({ class: "overloaded", message: "x" })).toContain("overloaded");
    expect(msg({ class: "prompt_too_long", message: "x" })).toContain("/clear");
    expect(msg({ class: "session_start", message: "x" })).toBe("Failed to start AI session. Context has been reset — please try again.");
    expect(msg({ class: "network", message: "ECONNREFUSED /home/user" })).toBe("Sorry, an internal error occurred. Please try again.");
    expect(msg({ class: "unknown", message: "secret detail" })).toBe("Sorry, an internal error occurred. Please try again.");
    expect(msg({ class: "auth", message: "secret detail" })).not.toContain("secret detail");
  });
});
