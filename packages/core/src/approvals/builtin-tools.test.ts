/**
 * GATES-B1 regression: every SDK built-in that runs a shell command is
 * classified like Bash (hardline, deny list, ask rules, hash, card), and the
 * built-ins that schedule or start work outside the normal tools ask in ask
 * mode. Driven through the real SdkOptionsPipeline + approvals gate, as in the
 * reviewer's proof (review/gates-proof.test.ts.txt).
 */

import { describe, it, expect } from "vitest";
import type { HookInput, HookJSONOutput, Options } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, type SdkCallContext } from "../engine/sdk-options.js";
import { ApprovalsConfigSchema } from "../config/sections/approvals.js";
import { ApprovalEngine, approvalCallHash, defaultApprovalPolicy, evaluateApprovalCall } from "./engine.js";
import { createApprovalsGate } from "./gate.js";
import { ApprovalPrompter, approvalCallDisplay } from "./prompter.js";

const HOME = "/Users/tester";
const DATA = `${HOME}/.kirie`;
const ctx: SdkCallContext = { kind: "chat", sessionKey: "telegram:dm:1", channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true, interactive: true, label: "chat telegram:dm", cwd: DATA };
const env = { home: HOME, dataDir: DATA, realpath: (p: string) => p };

function pipelineWith(mode: "yolo" | "ask", deny: string[] = []) {
  const engine = new ApprovalEngine({ config: ApprovalsConfigSchema.parse({ mode, deny }), homeDir: HOME, dataDir: DATA, realpath: (p) => p });
  const prompter = new ApprovalPrompter({
    prompts: { requestApproval: async () => ({ outcome: "denied", optionId: "deny", code: "x" }), pending: () => [] } as never,
    policy: () => engine.policy(),
  });
  const p = new SdkOptionsPipeline();
  p.registerGate(createApprovalsGate(engine, prompter));
  return p;
}

async function hook(p: SdkOptionsPipeline, tool: string, input: Record<string, unknown>): Promise<string> {
  const options: Options = {};
  p.apply(options, ctx);
  const h = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const out = (await h({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t1", cwd: DATA, session_id: "s", transcript_path: "/tmp/t" } as HookInput, "t1", { signal: new AbortController().signal })) as HookJSONOutput & { hookSpecificOutput?: { permissionDecision?: string } };
  return out?.hookSpecificOutput?.permissionDecision ?? "allow(no decision)";
}

const monitor = (command: string) => ({ description: "x", timeout_ms: 1000, command });

describe("GATES-B1: shell-running built-ins through the real pipeline", () => {
  it("Monitor and PowerShell commands hit the hardline list in yolo and ask", async () => {
    for (const mode of ["yolo", "ask"] as const) {
      const p = pipelineWith(mode);
      expect(await hook(p, "Bash", { command: "rm -rf ~" }), mode).toBe("deny");
      expect(await hook(p, "Monitor", monitor("rm -rf ~")), mode).toBe("deny");
      expect(await hook(p, "PowerShell", { command: "rm -rf ~" }), mode).toBe("deny");
    }
  });

  it("Monitor runs the ask rules in ask mode and stays allowed in yolo", async () => {
    expect(await hook(pipelineWith("ask"), "Monitor", monitor("git push --force; kubectl delete ns prod"))).toBe("ask");
    expect(await hook(pipelineWith("yolo"), "Monitor", monitor("git push --force; kubectl delete ns prod"))).toBe("allow(no decision)");
    expect(await hook(pipelineWith("yolo"), "Monitor", monitor("tail -f /tmp/log"))).toBe("allow(no decision)");
    expect(await hook(pipelineWith("ask"), "Monitor", monitor("tail -f /tmp/log"))).toBe("allow(no decision)");
  });

  it("the owner's shell deny list applies to Monitor and PowerShell", async () => {
    const p = pipelineWith("yolo", ["terraform destroy*"]);
    expect(await hook(p, "Monitor", monitor("terraform destroy -auto-approve"))).toBe("deny");
    expect(await hook(p, "PowerShell", { command: "terraform destroy" })).toBe("deny");
  });

  it("Monitor with a WebSocket and no command is not a shell call", async () => {
    expect(await hook(pipelineWith("ask"), "Monitor", { description: "x", timeout_ms: 1000, ws: { url: "wss://example.invalid" } })).toBe("allow(no decision)");
  });

  it("PowerShell is never read with certainty (asks in ask mode)", () => {
    const r = evaluateApprovalCall({ tool: "PowerShell", input: { command: "Get-ChildItem" }, cwd: DATA, ctx }, defaultApprovalPolicy({ mode: "ask" }), env);
    expect(r.decision).toBe("ask");
    expect(r.uncertain.map((u) => u.code)).toContain("powershell");
  });

  it("hash and card treat the shell built-ins like Bash", () => {
    expect(approvalCallHash("Monitor", monitor("ls"))).toBe(approvalCallHash("Monitor", { ...monitor("ls"), timeout_ms: 5000, description: "y" }));
    const shown = approvalCallDisplay({ tool: "Monitor", input: monitor("tail -f x"), cwd: DATA, ctx }, (t) => t);
    expect(shown.label).toBe("Command");
    expect(shown.text).toBe("tail -f x");
    expect(approvalCallDisplay({ tool: "PowerShell", input: { command: "Get-Item x" }, cwd: DATA, ctx }, (t) => t).label).toBe("Command");
  });
});

describe("GATES-B1: built-ins that schedule or start work elsewhere", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Workflow", { script: "export const meta = { name: 'x', description: 'x' }" }],
    ["Workflow", { scriptPath: "/tmp/w.js" }],
    ["CronCreate", { cron: "* * * * *", prompt: "rm -rf ~" }],
    ["ScheduleWakeup", { delaySeconds: 60, prompt: "rm -rf ~", reason: "x" }],
    ["RemoteTrigger", { action: "run", trigger_id: "t" }],
    ["RemoteTrigger", { action: "create", body: {} }],
    ["EnterWorktree", { name: "x" }],
    ["ExitWorktree", { action: "remove", discard_changes: true }],
  ];

  it("ask in ask mode, stay allowed in yolo", async () => {
    for (const [tool, input] of cases) {
      expect(await hook(pipelineWith("ask"), tool, input), `${tool} ${JSON.stringify(input)}`).toBe("ask");
      expect(await hook(pipelineWith("yolo"), tool, input), tool).toBe("allow(no decision)");
    }
  });

  it("read-only forms do not ask", async () => {
    for (const [tool, input] of [
      ["RemoteTrigger", { action: "list" }],
      ["RemoteTrigger", { action: "get_run_log", session_id: "s" }],
      ["ExitWorktree", { action: "keep" }],
      ["CronList", {}],
      ["CronDelete", { id: "x" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(await hook(pipelineWith("ask"), tool, input), tool).toBe("allow(no decision)");
    }
  });
});
