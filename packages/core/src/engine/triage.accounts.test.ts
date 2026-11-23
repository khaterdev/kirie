import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { TriageRunner, setTriageAccountGate, type TriageAccountGate } from "./triage.js";
import { ProactiveConfigSchema } from "../config/schema.js";
import type { Signal } from "./signals.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;
const signal: Signal = { id: "sig-1", type: "test", severity: "warning", title: "t", details: "d", timestamp: Date.now(), source: "test" };

function resultStream(result: string, isError = false) {
  return (async function* () {
    yield { type: "result", subtype: "success", is_error: isError, result, total_cost_usd: 0, num_turns: 1 };
  })();
}

describe("TriageRunner with the account gate", () => {
  let dir: string;
  let runner: TriageRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "kirie-triage-acc-"));
    runner = new TriageRunner(ProactiveConfigSchema.parse({ heartbeatFile: join(dir, "none.md") }), undefined, { cwd: join(dir, "oneshot") });
  });

  afterEach(() => {
    setTriageAccountGate(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips the cycle without spawning while every account is limited", async () => {
    setTriageAccountGate({ beforeCall: () => ({ skip: true, accountId: "a", untilMs: Date.now() + 60_000 }), reportFailure: vi.fn(() => false) });
    const result = await runner.triage([signal]);
    expect(result.llmCalled).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("reports a limit against the account that ran the call; with another account usable it does not pause", async () => {
    const reportFailure = vi.fn<TriageAccountGate["reportFailure"]>(() => true);
    setTriageAccountGate({ beforeCall: () => ({ skip: false, accountId: "a" }), reportFailure });
    mockQuery.mockReturnValue(resultStream("You've hit your session limit · resets 4am (Africa/Cairo)", true));
    const result = await runner.triage([signal]);
    expect(result.llmCalled).toBe(false);
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure.mock.calls[0]![0]).toBe("a");
    expect(reportFailure.mock.calls[0]![1].class).toBe("usage_limit_account");
    expect(runner.pausedUntil).toBe(0);
  });

  it("pauses as before when no other account can serve", async () => {
    setTriageAccountGate({ beforeCall: () => ({ skip: false, accountId: "a" }), reportFailure: () => false });
    mockQuery.mockReturnValue(resultStream("You've hit your session limit · resets 4am (Africa/Cairo)", true));
    await runner.triage([signal]);
    expect(runner.pausedUntil).toBeGreaterThan(Date.now());
  });

  it("without a gate triage behaves as before", async () => {
    mockQuery.mockReturnValue(resultStream("[]"));
    expect((await runner.triage([signal])).llmCalled).toBe(true);
  });
});
