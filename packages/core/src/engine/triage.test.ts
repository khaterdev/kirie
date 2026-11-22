import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { TriageRunner } from "./triage.js";
import { ProactiveConfigSchema } from "../config/schema.js";
import type { Signal } from "./signals.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;

const signal: Signal = {
  id: "sig-1",
  type: "test",
  severity: "warning",
  title: "Test signal",
  details: "details",
  timestamp: Date.now(),
  source: "test",
};

function resultStream(result: string, isError = false) {
  return (async function* () {
    yield { type: "result", subtype: "success", is_error: isError, result, total_cost_usd: 0, num_turns: 1 };
  })();
}

describe("TriageRunner (no-tools one-shot)", () => {
  let dir: string;
  let runner: TriageRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "kirie-triage-test-"));
    const config = ProactiveConfigSchema.parse({ heartbeatFile: join(dir, "missing-HEARTBEAT.md") });
    runner = new TriageRunner(config, undefined, { cwd: join(dir, "oneshot") });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it("calls the model with no tools, no MCP servers and no settings", async () => {
    mockQuery.mockReturnValue(resultStream('[{"action":"silent","signalId":"sig-1"}]'));
    const result = await runner.triage([signal]);
    expect(result).toMatchObject({ llmCalled: true, decisions: [{ action: "silent", signalId: "sig-1" }] });

    const { options } = mockQuery.mock.calls[0]![0];
    expect(options.tools).toEqual([]);
    expect(options.mcpServers).toEqual({});
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe("default");
    expect(options.allowedTools).toEqual([]);
    expect(options.maxTurns).toBe(1);
    expect(options.cwd).toBe(join(dir, "oneshot"));
  });

  it("skips cycles until the reset time after a usage limit, logging it once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z")); // 12:00 in Cairo
    mockQuery.mockReturnValue(resultStream("You've hit your session limit · resets 2pm (Africa/Cairo)", true));

    const first = await runner.triage([signal]);
    expect(first.llmCalled).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(runner.pausedUntil).toBe(new Date("2026-11-23T12:00:00Z").getTime() + 60_000);

    vi.setSystemTime(new Date("2026-11-23T11:30:00Z"));
    const second = await runner.triage([signal]);
    expect(second.llmCalled).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-11-23T12:05:00Z"));
    mockQuery.mockReturnValue(resultStream("[]"));
    const third = await runner.triage([signal]);
    expect(third.llmCalled).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(runner.pausedUntil).toBe(0);
  });

  it("pauses 15 minutes when the limit has no reset time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    mockQuery.mockReturnValue(
      (async function* () {
        throw new Error("Claude Code returned an error result: You've hit your monthly spend limit · raise it in the console");
      })(),
    );
    await runner.triage([signal]);
    expect(runner.pausedUntil).toBe(new Date("2026-11-23T10:15:00Z").getTime());
  });

  it("does not pause on an overload or an unknown error", async () => {
    mockQuery.mockReturnValue(resultStream("API Error: 529 overloaded_error", true));
    expect((await runner.triage([signal])).llmCalled).toBe(false);
    expect(runner.pausedUntil).toBe(0);

    mockQuery.mockReturnValue(resultStream("[]"));
    expect((await runner.triage([signal])).llmCalled).toBe(true);
  });

  it("an unparseable answer still counts as a call with no decisions", async () => {
    mockQuery.mockReturnValue(resultStream("nothing to report"));
    expect(await runner.triage([signal])).toEqual({ decisions: [], signalsProcessed: 1, llmCalled: true });
  });
});
