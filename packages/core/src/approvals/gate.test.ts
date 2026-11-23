/**
 * End to end through the real seam: SdkOptionsPipeline (one PreToolUse hook,
 * one canUseTool) -> the approvals gate -> ApprovalPrompter -> OwnerPrompts ->
 * a fake Telegram adapter, with the owner pressing buttons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseTool, HookCallback, HookInput, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, type SdkCallContext } from "../engine/sdk-options.js";
import { AuditTrail } from "../security/audit-trail.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { InteractionRouter } from "../interaction/router.js";
import { OwnerPrompts } from "../interaction/owner-prompts.js";
import { makeFakeAdapter, makeFakeRegistry, type FakeAdapter } from "../interaction/fake-channel.test-util.js";
import { ApprovalsConfigSchema } from "../config/sections/approvals.js";
import { ApprovalEngine } from "./engine.js";
import { ApprovalPrompter } from "./prompter.js";
import { ApprovalStats, createApprovalsGate } from "./gate.js";
import { FakeApprovalSettings } from "./fake-settings.test-util.js";

const OWNER = "1001";
const CWD = "/Users/tester/dev/x";

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function chat(over: Partial<SdkCallContext> = {}): SdkCallContext {
  return { kind: "chat", sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true, interactive: true, label: "chat telegram:dm", cwd: CWD, ...over };
}

describe("approvals gate through the SDK options pipeline", () => {
  let dir: string;
  let audit: AuditTrail;
  let adapter: FakeAdapter;
  let prompts: OwnerPrompts;
  let settings: FakeApprovalSettings;
  let pipeline: SdkOptionsPipeline;
  let stats: ApprovalStats;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "kirie-apr-gate-"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    adapter = makeFakeAdapter("telegram");
    const registry = makeFakeRegistry([adapter]);
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    const router = new InteractionRouter({ channelRegistry: registry, owners, audit });
    router.attach(adapter);
    prompts = new OwnerPrompts({ router, channelRegistry: registry, owners, audit, maxPending: 10 });
    settings = new FakeApprovalSettings();
    const engine = new ApprovalEngine({
      config: ApprovalsConfigSchema.parse({}),
      settings,
      homeDir: "/Users/tester",
      dataDir: "/Users/tester/.kirie",
      isOwnerChat: (ch, id) => owners.isOwner(ch as never, id),
      realpath: (p) => p,
    });
    const prompter = new ApprovalPrompter({ prompts, policy: () => engine.policy(), audit });
    stats = new ApprovalStats();
    pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(createApprovalsGate(engine, prompter, { audit, stats }));
  });

  afterEach(() => {
    prompts.cancelAll("test");
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function options(ctx: SdkCallContext = chat()): Options {
    return pipeline.apply({ permissionMode: "bypassPermissions", allowedTools: ["Bash(*)"] } as Options, ctx);
  }

  function hook(opts: Options): HookCallback {
    const matchers = opts.hooks?.PreToolUse ?? [];
    expect(matchers).toHaveLength(1);
    return matchers[0]!.hooks[0]!;
  }

  async function pre(opts: Options, tool: string, input: Record<string, unknown>, toolUseId: string, extra: Record<string, unknown> = {}) {
    const hookInput = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: toolUseId, session_id: "s", transcript_path: "/tmp/t", cwd: CWD, ...extra } as HookInput;
    return hook(opts)(hookInput, toolUseId, { signal: new AbortController().signal });
  }

  function canUse(opts: Options, tool: string, input: Record<string, unknown>, toolUseId: string, signal = new AbortController().signal, agentID?: string): Promise<PermissionResult | null> {
    return (opts.canUseTool as CanUseTool)(tool, input, { signal, toolUseID: toolUseId, requestId: "r", ...(agentID ? { agentID } : {}) } as never);
  }

  async function press(label: string, senderId = OWNER, chatId = OWNER): Promise<void> {
    const card = adapter.sentInteractive.at(-1)!;
    const results = (adapter.sendInteractive as ReturnType<typeof vi.fn>).mock.results;
    const messageId = (await (results.at(-1)!.value as Promise<{ id: string }>)).id;
    const data = card.buttons.flat().find((b) => b.label === label)!.data!;
    await adapter.press({ data, messageId, senderId, chatId });
  }

  it("yolo: plain and risky commands pass untouched; hardline is denied", async () => {
    const opts = options();
    expect(await pre(opts, "Bash", { command: "ls -la" }, "t1")).toEqual({});
    expect(await pre(opts, "Bash", { command: "git push --force" }, "t2")).toEqual({});
    const denied = await pre(opts, "Bash", { command: "rm -rf ~" }, "t3");
    expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect((denied as { hookSpecificOutput: { permissionDecisionReason: string } }).hookSpecificOutput.permissionDecisionReason).toMatch(/hardline/);
    expect(stats.snapshot()).toMatchObject({ allowed: 1, allowedFlagged: 1, denied: 1 });
  });

  it("yolo with hardline off denies nothing", async () => {
    settings.set("approvals.hardline", false);
    const opts = options();
    for (const command of ["rm -rf /", "rm -rf ~", ":(){ :|:& };:", "mkfs.ext4 /dev/sda1"]) {
      expect(await pre(opts, "Bash", { command }, `t-${command}`), command).toEqual({});
    }
  });

  it("a mode switch applies to an already-built options object (v2 sessions)", async () => {
    const opts = options();
    expect(await pre(opts, "Bash", { command: "git push --force" }, "t1")).toEqual({});
    settings.set("approvals.mode", "ask");
    expect(await pre(opts, "Bash", { command: "git push --force" }, "t2")).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("ask: the owner approves on the card and the call runs with its input unchanged", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    const out = await pre(opts, "Bash", { command: "git push --force origin main" }, "t1");
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const result = canUse(opts, "Bash", { command: "git push --force origin main" }, "t1");
    await flush();
    const card = adapter.sentInteractive.at(-1)!;
    expect(card.ctx.chatId).toBe(OWNER);
    expect(card.text).toContain("git push --force origin main");
    expect(card.buttons.flat().map((b) => b.label)).toEqual(["Approve", "Deny", "Deny + stop"]);
    await press("Approve");
    expect(await result).toEqual({ behavior: "allow", updatedInput: { command: "git push --force origin main" } });
  });

  it("ask: Deny blocks with the fixed message; Deny + stop interrupts", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    await pre(opts, "Bash", { command: "kubectl delete pod x" }, "t1");
    const r1 = canUse(opts, "Bash", { command: "kubectl delete pod x" }, "t1");
    await flush();
    await press("Deny");
    const d1 = await r1;
    expect(d1).toMatchObject({ behavior: "deny" });
    expect((d1 as { message: string }).message).toMatch(/Do not retry it and do not try an equivalent command/);
    expect(d1).not.toHaveProperty("interrupt");

    await pre(opts, "Bash", { command: "helm uninstall x" }, "t2");
    const r2 = canUse(opts, "Bash", { command: "helm uninstall x" }, "t2");
    await flush();
    await press("Deny + stop");
    expect(await r2).toMatchObject({ behavior: "deny", interrupt: true });
  });

  it("a non-owner press does nothing; no answer in time means deny", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    await pre(opts, "Bash", { command: "cat ~/.ssh/id_ed25519" }, "t1");
    const r = canUse(opts, "Bash", { command: "cat ~/.ssh/id_ed25519" }, "t1");
    await flush();
    await press("Approve", "6666", "6666");
    await press("Approve", OWNER, "-100200");
    let settled = false;
    void r.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await r;
    expect(result).toMatchObject({ behavior: "deny" });
    expect((result as { message: string }).message).toMatch(/timed out after 300s/);
  });

  it("an aborted turn cancels the prompt and denies", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    await pre(opts, "Bash", { command: "rm -rf build" }, "t1");
    const ac = new AbortController();
    const r = canUse(opts, "Bash", { command: "rm -rf build" }, "t1", ac.signal);
    await flush();
    ac.abort();
    expect(await r).toMatchObject({ behavior: "deny" });
  });

  it("a subagent's Bash is gated the same way", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    const out = await pre(opts, "Bash", { command: "rm -rf build" }, "t1", { agent_id: "sub-1", agent_type: "general-purpose" });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const r = canUse(opts, "Bash", { command: "rm -rf build" }, "t1", undefined, "sub-1");
    await flush();
    expect(adapter.sentInteractive.at(-1)!.text).toContain("subagent general-purpose");
    await press("Deny");
    expect(await r).toMatchObject({ behavior: "deny" });
  });

  it("prompts go to the owner's DM even when the turn started in a group", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options(chat({ sessionKey: "telegram:group:-100200", chatType: "group", ownerDm: false, label: "chat telegram:group" }));
    await pre(opts, "Bash", { command: "git push -f" }, "t1");
    const r = canUse(opts, "Bash", { command: "git push -f" }, "t1");
    await flush();
    expect(adapter.sentInteractive.at(-1)!.ctx.chatId).toBe(OWNER);
    await press("Approve");
    expect(await r).toMatchObject({ behavior: "allow" });
  });

  it("webhook work: asks are denied without a card, whatever the mode", async () => {
    const opts = options({ kind: "webhook", interactive: false, label: "webhook hook-1", cwd: CWD, ownerDm: false });
    const out = await pre(opts, "Bash", { command: "git push -f" }, "t1");
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    expect(await canUse(opts, "Bash", { command: "git push -f" }, "t1")).toMatchObject({ behavior: "deny" });
    expect(adapter.sentInteractive).toHaveLength(0);
  });

  it("triage, judge and one-shot calls get no hook at all", () => {
    for (const kind of ["triage", "judge", "oneshot"] as const) {
      const opts = pipeline.apply({} as Options, { kind, ownerDm: false, interactive: false, label: kind, cwd: CWD });
      expect(opts.hooks?.PreToolUse).toBeUndefined();
      expect(opts.canUseTool).toBeUndefined();
    }
  });

  it("decisions are audited; plain allows are only counted", async () => {
    settings.set("approvals.mode", "ask");
    const opts = options();
    await pre(opts, "Bash", { command: "ls" }, "t0");
    await pre(opts, "Bash", { command: "rm -rf /" }, "t1");
    await pre(opts, "Bash", { command: "rm -rf build" }, "t2");
    const r = canUse(opts, "Bash", { command: "rm -rf build" }, "t2");
    await flush();
    await press("Approve");
    await r;
    const actions = audit.recent({ feature: "approvals" }).map((x) => x.action).reverse();
    expect(actions).toEqual(["denied.hardline", "asked", "approved"]);
    const details = JSON.stringify(audit.recent({ feature: "approvals" }));
    expect(details).not.toContain("rm -rf build");
  });
});

describe("gate failure policy", () => {
  it("an engine that throws passes in yolo and asks in ask; never throws into the chain", () => {
    for (const [mode, expected] of [["yolo", "pass"], ["ask", "ask"]] as const) {
      const engine = { evaluate: () => { throw new Error("boom"); }, mode: () => mode } as unknown as ApprovalEngine;
      const prompter = { request: vi.fn(async () => ({ approved: false, stop: false, messageForAgent: "no", outcome: "denied" })) } as unknown as ApprovalPrompter;
      const gate = createApprovalsGate(engine, prompter);
      const verdict = gate.check({ tool: "Bash", input: { command: "x" }, toolUseId: "t", cwd: CWD, ctx: chat() });
      expect((verdict as { decision: string }).decision).toBe(expected);
    }
  });

  it("has the fixed name and order", () => {
    const gate = createApprovalsGate({} as ApprovalEngine, {} as ApprovalPrompter);
    expect(gate.name).toBe("approvals");
    expect(gate.order).toBe(900);
    expect(() => new SdkOptionsPipeline().registerGate(gate)).not.toThrow();
  });
});
