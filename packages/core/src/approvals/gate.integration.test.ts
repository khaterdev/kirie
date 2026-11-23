/**
 * Opt-in live checks of the approvals gate against the real Agent SDK
 * (R2 section 0.1 P3 to P7, plus P10: a string prompt).
 *
 * Skipped unless KIRIE_SDK_PROBE=1. Spends a few tiny model turns on the
 * default account (model: KIRIE_SDK_PROBE_MODEL, default claude-haiku-4-5).
 * Runs in a fresh temp directory with no settings sources and no persisted
 * transcript. The model is only ever asked to run `touch <marker>`: the gate
 * is made to block it with a deny pattern or ask scope "all", never by asking
 * a live model to run a destructive command.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, installCanUseToolWarningFilter, type SdkCallContext, type ToolGateCall } from "../engine/sdk-options.js";
import { ApprovalsConfigSchema } from "../config/sections/approvals.js";
import type { OwnerApprovalRequest } from "../interaction/owner-prompts.js";
import { ApprovalEngine } from "./engine.js";
import { ApprovalPrompter } from "./prompter.js";
import { createApprovalsGate } from "./gate.js";

const enabled = process.env.KIRIE_SDK_PROBE === "1";
const model = process.env.KIRIE_SDK_PROBE_MODEL ?? "claude-haiku-4-5";

async function run(prompt: string, options: Options, keepOpenForSubagent = false): Promise<void> {
  let results = 0;
  for await (const msg of query({ prompt, options })) {
    if (msg.type === "result") {
      results++;
      if (!keepOpenForSubagent || results >= 2) break;
    }
  }
}

describe.skipIf(!enabled)("approvals gate against the live SDK (KIRIE_SDK_PROBE=1)", () => {
  let cwd: string;
  let ctx: SdkCallContext;
  let seen: ToolGateCall[];
  let answer: "approved" | "denied";

  beforeEach(() => {
    installCanUseToolWarningFilter();
    cwd = mkdtempSync(join(tmpdir(), "kirie-apr-probe-"));
    ctx = { kind: "chat", ownerDm: true, interactive: true, label: "probe", cwd };
    seen = [];
    answer = "approved";
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  function pipelineWith(config: Record<string, unknown>, opts: { chainTimeoutMs?: number } = {}): SdkOptionsPipeline {
    const engine = new ApprovalEngine({ config: ApprovalsConfigSchema.parse(config), homeDir: cwd, dataDir: join(cwd, "kirie") });
    const prompter = new ApprovalPrompter({
      prompts: {
        requestApproval: async (_req: OwnerApprovalRequest) => ({ outcome: answer, optionId: answer === "approved" ? "approve" : "deny", code: "PRB1" }),
        pending: () => [],
      } as never,
      policy: () => engine.policy(),
    });
    const pipeline = new SdkOptionsPipeline(opts.chainTimeoutMs ? { chainTimeoutMs: opts.chainTimeoutMs } : {});
    const gate = createApprovalsGate(engine, prompter);
    pipeline.registerGate({ ...gate, check: (call) => { seen.push(call); return gate.check(call); } });
    return pipeline;
  }

  function baseOptions(tools: string[] = ["Bash"]): Options {
    return { model, cwd, permissionMode: "bypassPermissions", allowedTools: tools, settingSources: [], persistSession: false, maxTurns: 6, maxBudgetUsd: 0.05 };
  }

  const ask = (marker: string) => `Run exactly this shell command with your Bash tool, then reply DONE: touch ${marker}`;

  it("P3/P4: the hook sees the call under bypassPermissions and a deny-list match blocks it", async () => {
    await run(ask("deny_marker"), pipelineWith({ deny: ["touch deny_marker*"] }).apply(baseOptions(), ctx));
    expect(seen.some((c) => c.tool === "Bash")).toBe(true);
    expect(existsSync(join(cwd, "deny_marker"))).toBe(false);
  }, 120_000);

  it("P5/P10: an ask reaches canUseTool with a string prompt; Approve runs it, Deny blocks it", async () => {
    await run(ask("approved_marker"), pipelineWith({ mode: "ask", askScope: "all" }).apply(baseOptions(), ctx));
    expect(existsSync(join(cwd, "approved_marker"))).toBe(true);
    answer = "denied";
    await run(ask("denied_marker"), pipelineWith({ mode: "ask", askScope: "all" }).apply(baseOptions(), ctx));
    expect(existsSync(join(cwd, "denied_marker"))).toBe(false);
  }, 240_000);

  it("P6: a subagent's Bash reaches the same gate with its agent type and is blocked", async () => {
    const prompt = "Use the Agent tool to start a general-purpose subagent whose only job is to run this shell command with Bash: touch sub_marker. Then reply DONE.";
    await run(prompt, pipelineWith({ deny: ["touch sub_marker*"] }).apply(baseOptions(["Bash", "Agent", "Task"]), ctx), true);
    expect(existsSync(join(cwd, "sub_marker"))).toBe(false);
    expect(seen.some((c) => c.tool === "Bash" && c.agentType !== undefined)).toBe(true);
  }, 240_000);

  it("P7: a gate chain that does not answer in time fails closed", async () => {
    const pipeline = new SdkOptionsPipeline({ chainTimeoutMs: 2_000 });
    pipeline.registerGate({ name: "approvals", order: 900, check: () => new Promise(() => {}) });
    await run(ask("stuck_marker"), pipeline.apply(baseOptions(), ctx));
    expect(existsSync(join(cwd, "stuck_marker"))).toBe(false);
  }, 120_000);
});
