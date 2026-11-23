import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { judgeGoal, type GoalJudgeInput } from "./goal-judge.js";
import { SdkOptionsPipeline } from "../engine/sdk-options.js";

/** The judge through the real runOneShot, with the SDK's query() mocked: no model call. */
const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;

function stream(messages: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

const input: GoalJudgeInput = {
  goalId: "g-abcdef",
  goal: "ship it",
  checks: [],
  report: "Done. GOAL_REPORT status: done",
  previousRounds: [],
  round: 1,
  roundLimit: 3,
};

describe("judgeGoal over runOneShot", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-goal-judge-"));
    mockQuery.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs with no tools, no MCP servers, no settings and the verdict schema; reads structured_output", async () => {
    mockQuery.mockImplementation(() =>
      stream([{ type: "result", subtype: "success", is_error: false, result: "", structured_output: { verdict: "done", reason: "evidence shown", missing: [] }, total_cost_usd: 0.003, num_turns: 2 }]),
    );
    const out = await judgeGoal(input, { model: "claude-haiku-4-5", cwd: dir, sdkOptions: new SdkOptionsPipeline() });
    expect(out).toEqual({ ok: true, verdict: { verdict: "done", reason: "evidence shown", missing: [] }, costUsd: 0.003 });
    const options = mockQuery.mock.calls[0]![0].options;
    expect(options).toMatchObject({ tools: [], mcpServers: {}, settingSources: [], allowedTools: [], strictMcpConfig: true, persistSession: false });
    expect(options.outputFormat).toMatchObject({ type: "json_schema" });
    expect(options.hooks).toBeUndefined();
  });

  it("falls back to fenced JSON in the text", async () => {
    mockQuery.mockImplementation(() =>
      stream([{ type: "result", subtype: "success", is_error: false, result: "```json\n{\"verdict\":\"continue\",\"reason\":\"no evidence\",\"missing\":[\"test output\"]}\n```", total_cost_usd: 0.001, num_turns: 1 }]),
    );
    const out = await judgeGoal(input, { model: "m", cwd: dir });
    expect(out).toMatchObject({ ok: true, verdict: { verdict: "continue", missing: ["test output"] } });
  });

  it("a prose answer that says done is not done", async () => {
    mockQuery.mockImplementation(() =>
      stream([{ type: "result", subtype: "success", is_error: false, result: "The goal is done.", total_cost_usd: 0.001, num_turns: 1 }]),
    );
    const out = await judgeGoal(input, { model: "m", cwd: dir });
    expect(out.ok).toBe(false);
  });

  it("an error result is a failure", async () => {
    mockQuery.mockImplementation(() =>
      stream([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["overloaded"], total_cost_usd: 0, num_turns: 0 }]),
    );
    const out = await judgeGoal(input, { model: "m", cwd: dir });
    expect(out.ok).toBe(false);
  });
});
