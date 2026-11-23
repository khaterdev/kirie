import { describe, it, expect, vi } from "vitest";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookInput,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  addHook,
  chatCallContext,
  installCanUseToolWarningFilter,
  isSubagentTool,
  CAN_USE_TOOL_SHADOWED_WARNING,
  GATE_ERROR_REASON,
  PRE_TOOL_USE_TIMEOUT_SECONDS,
  UNASKED_PERMISSION_REASON,
  SdkOptionsPipeline,
  type SdkCallContext,
  type SdkCallKind,
  type SdkStreamEvent,
  type ToolGate,
  type ToolGateCall,
} from "./sdk-options.js";

const CWD = "/tmp/kirie-sdk-options-test";

function ctxOf(kind: SdkCallKind = "chat", extra: Partial<SdkCallContext> = {}): SdkCallContext {
  return { kind, ownerDm: false, interactive: kind === "chat", label: `test ${kind}`, cwd: CWD, ...extra };
}

/** Base options shaped like the chat call sites build them. */
function chatOptions(): Options {
  return {
    model: "claude-test",
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash", "Read"],
    cwd: CWD,
    settingSources: ["user", "project"],
  };
}

function preHook(options: Options): HookCallback {
  const matchers = options.hooks?.PreToolUse ?? [];
  expect(matchers).toHaveLength(1);
  return matchers[0]!.hooks[0]!;
}

function preInput(tool: string, input: Record<string, unknown> = {}, toolUseId = "tu-1", extra: Record<string, unknown> = {}): HookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
    tool_use_id: toolUseId,
    session_id: "sess",
    transcript_path: "/tmp/t.jsonl",
    cwd: CWD,
    ...extra,
  } as HookInput;
}

async function runPre(options: Options, tool: string, input: Record<string, unknown> = {}, toolUseId = "tu-1", extra: Record<string, unknown> = {}) {
  const signal = new AbortController().signal;
  return preHook(options)(preInput(tool, input, toolUseId, extra), toolUseId, { signal });
}

function canUse(options: Options): CanUseTool {
  expect(options.canUseTool).toBeTypeOf("function");
  return options.canUseTool!;
}

async function callCanUse(options: Options, tool: string, input: Record<string, unknown>, toolUseId: string): Promise<PermissionResult | null> {
  return canUse(options)(tool, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: "req-1",
  });
}

function gate(name: string, order: number, check: ToolGate["check"], matcher?: RegExp): ToolGate {
  return { name, order, check, ...(matcher ? { matcher } : {}) };
}

const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("SdkOptionsPipeline: contributors", () => {
  it("runs contributors in ascending order, core-defaults first", () => {
    const pipeline = new SdkOptionsPipeline();
    const seen: string[] = [];
    pipeline.registerContributor("checkpointing", () => seen.push("checkpointing"), 40);
    pipeline.registerContributor("account-env", () => seen.push("account-env"), 20);
    pipeline.registerContributor("voice-profile", (_o, ctx) => seen.push(`voice:${ctx.kind}`), 70);
    const options = chatOptions();
    pipeline.apply(options, ctxOf("background"));
    expect(seen).toEqual(["account-env", "checkpointing", "voice:background"]);
  });

  it("throws on a duplicate contributor name and on an order outside the fixed table", () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerContributor("sandbox", () => {}, 50);
    expect(() => pipeline.registerContributor("sandbox", () => {}, 50)).toThrow(/already registered/);
    expect(() => pipeline.registerContributor("core-defaults", () => {}, 10)).toThrow(/already registered/);
    expect(() => pipeline.registerContributor("checkpointing", () => {}, 41)).toThrow(/fixed order/);
    expect(() => pipeline.registerContributor("my-feature", () => {}, 80)).toThrow(/fixed order/);
  });

  it("a failing contributor fails apply with its name", () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerContributor("sandbox", () => {
      throw new Error("no docker");
    }, 50);
    expect(() => pipeline.apply(chatOptions(), ctxOf())).toThrow(/"sandbox" failed: no docker/);
  });

  it("core-defaults sets strictMcpConfig only when configured and leaves disallowedTools alone (E8)", () => {
    let strict = false;
    const pipeline = new SdkOptionsPipeline({ strictMcpConfig: () => strict });
    pipeline.claimMcpPrefix("mcp__cua-driver", (ctx) => ctx.ownerDm);
    const a = pipeline.apply({ ...chatOptions(), disallowedTools: ["WebFetch"] }, ctxOf());
    expect(a.disallowedTools).toEqual(["WebFetch"]);
    expect(a.strictMcpConfig).toBeUndefined();
    expect(pipeline.apply(chatOptions(), ctxOf()).disallowedTools).toBeUndefined();

    strict = true;
    const b = pipeline.apply(chatOptions(), ctxOf());
    expect(b.strictMcpConfig).toBe(true);
  });
});

describe("SdkOptionsPipeline: what apply installs", () => {
  it("installs exactly one PreToolUse hook (30 s) and one canUseTool, even with no extra gates", () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PreToolUse?.[0]?.timeout).toBe(PRE_TOOL_USE_TIMEOUT_SECONDS);
    expect(options.canUseTool).toBeTypeOf("function");
    expect(options.hooks?.PostToolUse).toBeUndefined();
    // yolo stays today's behaviour
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowedTools).toEqual(["Bash", "Read"]);
  });

  it.each(["judge", "triage", "oneshot"] as const)("%s calls get no hook and no canUseTool, but contributors still run", (kind) => {
    const pipeline = new SdkOptionsPipeline();
    const contributor = vi.fn();
    pipeline.registerContributor("account-env", contributor, 20);
    const options = pipeline.apply({ model: "m" }, ctxOf(kind));
    expect(contributor).toHaveBeenCalledTimes(1);
    expect(options.hooks).toBeUndefined();
    expect(options.canUseTool).toBeUndefined();
  });

  it("keeps hooks the call site already set", () => {
    const pipeline = new SdkOptionsPipeline();
    const own: HookCallbackMatcher = { hooks: [async () => ({})] };
    const options = chatOptions();
    addHook(options, "SubagentStart", own);
    addHook(options, "PreToolUse", own);
    pipeline.apply(options, ctxOf());
    expect(options.hooks?.SubagentStart).toEqual([own]);
    expect(options.hooks?.PreToolUse).toHaveLength(2);
    expect(options.hooks?.PreToolUse?.[0]).toBe(own);
  });

  it("installs a PostToolUse hook only when a post observer is registered at spawn time", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerToolObserver({ name: "pre-only", pre: () => {} });
    expect(pipeline.apply(chatOptions(), ctxOf()).hooks?.PostToolUse).toBeUndefined();

    const post = vi.fn();
    pipeline.registerToolObserver({ name: "audit", post });
    const options = pipeline.apply(chatOptions(), ctxOf());
    const hook = options.hooks?.PostToolUse?.[0]?.hooks[0];
    expect(hook).toBeDefined();
    const out = await hook!(
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok", tool_use_id: "tu-9", session_id: "s", transcript_path: "", cwd: CWD } as HookInput,
      "tu-9",
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({});
    await flushImmediate();
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ tool: "Bash", toolUseId: "tu-9" }), "ok");
  });
});

describe("SdkOptionsPipeline: behaviour with only the built-in gates", () => {
  it("a normal tool call is not altered: the hook returns {} with no updatedInput", async () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf());
    for (const tool of ["Bash", "Write", "Read", "Agent", "mcp__kirie-tools__send_message", "mcp__playwright__click"]) {
      expect(await runPre(options, tool, { command: "echo hi" })).toEqual({});
    }
  });

  it("a normal tool call is not delayed: the hook settles before the next macrotask", async () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf("background", { toolAllowlist: undefined }));
    const raced = await Promise.race([
      runPre(options, "Bash", { command: "ls" }),
      new Promise((resolve) => setImmediate(() => resolve("late"))),
    ]);
    expect(raced).toEqual({});
  });

  it("canUseTool for a request no gate raised refuses it, as a headless session did before", async () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await callCanUse(options, "Bash", { command: "ls" }, "tu-2")).toEqual({
      behavior: "deny",
      message: UNASKED_PERMISSION_REASON,
    });
  });

  it("canUseTool for a request no gate raised still resolves a gate's ask when the re-run chain asks", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(gate("approvals", 900, () => ({
      decision: "ask",
      summary: "?",
      resolve: async () => ({ approved: true, reason: "owner ok" }),
    })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await callCanUse(options, "Bash", { command: "ls" }, "tu-unstored")).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
  });

  it("subagent calls are seen with their agent id", async () => {
    const pipeline = new SdkOptionsPipeline();
    const seen: ToolGateCall[] = [];
    pipeline.registerGate(gate("approvals", 900, (call) => {
      seen.push(call);
      return { decision: "pass" };
    }));
    const options = pipeline.apply(chatOptions(), ctxOf());
    await runPre(options, "Bash", { command: "ls" }, "tu-3", { agent_id: "agent-7", agent_type: "general-purpose" });
    expect(seen[0]).toMatchObject({ tool: "Bash", agentId: "agent-7", agentType: "general-purpose", toolUseId: "tu-3" });
  });
});

describe("SdkOptionsPipeline: the gate chain", () => {
  it("throws on a duplicate gate name and on an order outside the fixed table", () => {
    const pipeline = new SdkOptionsPipeline();
    expect(() => pipeline.registerGate(gate("reserved-mcp", 50, () => ({ decision: "pass" })))).toThrow(/already registered/);
    expect(() => pipeline.registerGate(gate("approvals", 901, () => ({ decision: "pass" })))).toThrow(/fixed order/);
    expect(pipeline.gateNames()).toEqual(["reserved-mcp", "task-profile"]);
  });

  it("the first deny wins and later gates do not run", async () => {
    const pipeline = new SdkOptionsPipeline();
    const later = vi.fn(() => ({ decision: "deny" as const, reason: "second" }));
    pipeline.registerGate(gate("approvals", 900, later));
    pipeline.registerGate(gate("skill-write-guard", 100, () => ({ decision: "deny", reason: "first" })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "Write", { file_path: "/x" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "first" },
    });
    expect(later).not.toHaveBeenCalled();
  });

  it("updatedInput reaches later gates and the tool", async () => {
    const pipeline = new SdkOptionsPipeline();
    const seenByApprovals: Array<Record<string, unknown>> = [];
    pipeline.registerGate(gate("computer-use", 300, (call) => ({ decision: "pass", updatedInput: { ...call.input, screenshot: "window" } })));
    pipeline.registerGate(gate("approvals", 900, (call) => {
      seenByApprovals.push(call.input);
      return { decision: "pass" };
    }));
    const options = pipeline.apply(chatOptions(), ctxOf());
    const out = await runPre(options, "mcp__x__shot", { app: "Notes" });
    expect(seenByApprovals).toEqual([{ app: "Notes", screenshot: "window" }]);
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { app: "Notes", screenshot: "window" } },
    });
  });

  it("a gate whose matcher does not match is skipped", async () => {
    const pipeline = new SdkOptionsPipeline();
    const check = vi.fn(() => ({ decision: "deny" as const, reason: "no" }));
    pipeline.registerGate(gate("sandbox-path-guard", 200, check, /^(Write|Edit)$/g));
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "Read")).toEqual({});
    expect(await runPre(options, "Write")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await runPre(options, "Write")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("asks are collected and resolved in gate order inside canUseTool; the first refusal denies", async () => {
    const pipeline = new SdkOptionsPipeline();
    const order: string[] = [];
    pipeline.registerGate(gate("approvals", 900, () => ({
      decision: "ask",
      summary: "run rm?",
      resolve: async () => {
        order.push("approvals");
        return { approved: false, reason: "owner said no", interrupt: true };
      },
    })));
    pipeline.registerGate(gate("computer-use", 300, () => ({
      decision: "ask",
      summary: "click in Notes?",
      resolve: async () => {
        order.push("computer-use");
        return { approved: true, reason: "ok" };
      },
    })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    const out = await runPre(options, "Bash", { command: "rm x" }, "tu-ask");
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "click in Notes?; run rm?" },
    });
    expect(order).toEqual([]);

    const result = await callCanUse(options, "Bash", { command: "rm x" }, "tu-ask");
    expect(order).toEqual(["computer-use", "approvals"]);
    expect(result).toEqual({ behavior: "deny", message: "owner said no", interrupt: true });
  });

  it("all asks approved allows with the final input", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(gate("computer-use", 300, (call) => ({ decision: "pass", updatedInput: { ...call.input, safe: true } })));
    pipeline.registerGate(gate("approvals", 900, () => ({
      decision: "ask",
      summary: "ok?",
      resolve: async () => ({ approved: true, reason: "yes" }),
    })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    const out = await runPre(options, "Bash", { command: "x" }, "tu-ok");
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask", updatedInput: { command: "x", safe: true } } });
    expect(await callCanUse(options, "Bash", { command: "x", safe: true }, "tu-ok")).toEqual({
      behavior: "allow",
      updatedInput: { command: "x", safe: true },
    });
  });

  it("a deny after an ask still denies", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(gate("computer-use", 300, () => ({ decision: "ask", summary: "?", resolve: async () => ({ approved: true, reason: "" }) })));
    pipeline.registerGate(gate("approvals", 900, () => ({ decision: "deny", reason: "hardline" })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "Bash")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "hardline" } });
  });

  it("a throwing gate denies with 'tool gate error'", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(gate("approvals", 900, () => {
      throw new Error("bug");
    }));
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "Bash")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: GATE_ERROR_REASON },
    });
    const rejecting = new SdkOptionsPipeline();
    rejecting.registerGate(gate("approvals", 900, async () => {
      throw new Error("async bug");
    }));
    expect(await runPre(rejecting.apply(chatOptions(), ctxOf()), "Bash")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: GATE_ERROR_REASON },
    });
  });

  it("a chain that takes too long denies", async () => {
    const pipeline = new SdkOptionsPipeline({ chainTimeoutMs: 30 });
    pipeline.registerGate(gate("approvals", 900, () => new Promise((resolve) => setTimeout(() => resolve({ decision: "pass" }), 500))));
    const options = pipeline.apply(chatOptions(), ctxOf());
    const started = Date.now();
    expect(await runPre(options, "Bash")).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: GATE_ERROR_REASON },
    });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("a rejected ask resolver denies instead of throwing", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate(gate("approvals", 900, () => ({
      decision: "ask",
      summary: "?",
      resolve: () => Promise.reject(new Error("broken")),
    })));
    const options = pipeline.apply(chatOptions(), ctxOf());
    await runPre(options, "Bash", {}, "tu-r");
    expect(await callCanUse(options, "Bash", {}, "tu-r")).toEqual({ behavior: "deny", message: GATE_ERROR_REASON });
  });

  it("gates registered after apply are seen by an already-built session (closures read live state)", async () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "Bash")).toEqual({});
    pipeline.registerGate(gate("approvals", 900, () => ({ decision: "deny", reason: "now gated" })));
    expect(await runPre(options, "Bash")).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: "now gated" } });
    pipeline.unregisterGate("approvals");
    expect(await runPre(options, "Bash")).toEqual({});
  });
});

describe("SdkOptionsPipeline: observers", () => {
  it("tool observers cannot change a verdict, and their errors are contained", async () => {
    const pipeline = new SdkOptionsPipeline();
    const verdicts: string[] = [];
    pipeline.registerToolObserver({
      name: "meddler",
      pre: (call, verdict) => {
        verdicts.push(`${call.tool}:${verdict}`);
        (call.input as Record<string, unknown>).command = "rm -rf /";
        throw new Error("observer bug");
      },
    });
    pipeline.registerToolObserver({ name: "async-bad", pre: () => Promise.reject(new Error("late")) as unknown as void });
    pipeline.registerGate(gate("approvals", 900, (call) =>
      call.tool === "Bash" ? { decision: "deny", reason: "no shell" } : { decision: "pass" },
    ));
    const options = pipeline.apply(chatOptions(), ctxOf());

    expect(await runPre(options, "Read", { file_path: "/a" })).toEqual({});
    expect(await runPre(options, "Bash", { command: "ls" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await flushImmediate();
    expect(verdicts).toEqual(["Read:allowed", "Bash:denied"]);
    expect(() => pipeline.registerToolObserver({ name: "meddler" })).toThrow(/already registered/);
  });

  it("stream observers get every event; a throwing one does not stop the others", () => {
    const pipeline = new SdkOptionsPipeline();
    const got: string[] = [];
    pipeline.registerStreamObserver("bad", () => {
      throw new Error("x");
    });
    pipeline.registerStreamObserver("good", (ev) => got.push(ev.type));
    expect(() => pipeline.registerStreamObserver("good", () => {})).toThrow(/already registered/);
    const ctx = ctxOf();
    const events: SdkStreamEvent[] = [
      { type: "turn_start", ctx, accountId: null, userMessageUuid: "u1" },
      { type: "message", ctx, message: { type: "system" } as unknown as SDKMessage },
      { type: "turn_end", ctx, accountId: null, result: { isError: false, wasAborted: false, costUsd: 0, numTurns: 1 } },
    ];
    for (const ev of events) pipeline.observe(ev);
    expect(got).toEqual(["turn_start", "message", "turn_end"]);
  });
});

describe("SdkOptionsPipeline: built-in gates", () => {
  it("reserved-mcp denies a reserved prefix unless a claim allows this context", async () => {
    const pipeline = new SdkOptionsPipeline();
    const unclaimed = pipeline.apply(chatOptions(), ctxOf("chat", { ownerDm: true }));
    expect(await runPre(unclaimed, "mcp__cua-driver__click")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await runPre(unclaimed, "mcp__cua-computer-use__type")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await runPre(unclaimed, "mcp__cua-driverX__click")).toEqual({});

    pipeline.claimMcpPrefix("mcp__cua-driver", (ctx) => ctx.ownerDm);
    expect(() => pipeline.claimMcpPrefix("mcp__cua-driver", () => true)).toThrow(/already claimed/);
    const owner = pipeline.apply(chatOptions(), ctxOf("chat", { ownerDm: true }));
    const stranger = pipeline.apply(chatOptions(), ctxOf("chat", { ownerDm: false }));
    expect(await runPre(owner, "mcp__cua-driver__click")).toEqual({});
    expect(await runPre(stranger, "mcp__cua-driver__click")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("task-profile treats Agent and Task as the same subagent tool (E5)", async () => {
    const pipeline = new SdkOptionsPipeline();
    const withTask = pipeline.apply(chatOptions(), ctxOf("goal", { toolAllowlist: ["Task", "Read"] }));
    expect(await runPre(withTask, "Agent")).toEqual({});
    const withAgent = pipeline.apply(chatOptions(), ctxOf("goal", { toolAllowlist: ["Agent"] }));
    expect(await runPre(withAgent, "Task")).toEqual({});
    const without = pipeline.apply(chatOptions(), ctxOf("goal", { toolAllowlist: ["Read"] }));
    expect(await runPre(without, "Agent")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(isSubagentTool("Agent") && isSubagentTool("Task") && !isSubagentTool("Bash")).toBe(true);
  });

  it("a claim callback that throws counts as not allowed", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.reserveMcpPrefix("mcp__probe");
    pipeline.claimMcpPrefix("mcp__probe", () => {
      throw new Error("x");
    });
    const options = pipeline.apply(chatOptions(), ctxOf());
    expect(await runPre(options, "mcp__probe__run")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("task-profile enforces the allowlist (exact names and prefix*) on every call, subagents included", async () => {
    const pipeline = new SdkOptionsPipeline();
    const options = pipeline.apply(chatOptions(), ctxOf("webhook", { toolAllowlist: ["Read", "mcp__kirie-tools__memory_*"] }));
    expect(await runPre(options, "Read")).toEqual({});
    expect(await runPre(options, "mcp__kirie-tools__memory_search")).toEqual({});
    expect(await runPre(options, "Bash")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await runPre(options, "Bash", {}, "tu-s", { agent_id: "a1" })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await runPre(options, "mcp__kirie-tools__send_message")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await callCanUse(options, "Bash", {}, "tu-none")).toMatchObject({ behavior: "deny" });
  });
});

describe("SdkOptionsPipeline.evaluate", () => {
  it("reports pass, deny and ask without ever prompting", async () => {
    const pipeline = new SdkOptionsPipeline();
    const resolve = vi.fn(async () => ({ approved: true, reason: "" }));
    pipeline.registerGate(gate("approvals", 900, (call) =>
      String(call.input.command).startsWith("rm") ? { decision: "ask", summary: "delete files", resolve } : { decision: "pass" },
    ));
    const base = { cwd: CWD, ctx: ctxOf("goal") };
    expect(await pipeline.evaluate({ ...base, tool: "Bash", input: { command: "npm test" } })).toEqual({ decision: "pass", reasons: [] });
    expect(await pipeline.evaluate({ ...base, tool: "Bash", input: { command: "rm -rf build" } })).toEqual({ decision: "ask", reasons: ["delete files"] });
    expect(await pipeline.evaluate({ ...base, tool: "mcp__cua-driver__click", input: {} })).toMatchObject({ decision: "deny" });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("chatCallContext marks only an owner's DM as ownerDm", () => {
    expect(chatCallContext({ sessionKey: "telegram:dm:1", channel: "telegram", chatType: "dm", senderRole: "owner", cwd: CWD })).toMatchObject({
      kind: "chat",
      ownerDm: true,
      interactive: true,
      label: "chat telegram:dm",
    });
    expect(chatCallContext({ sessionKey: "telegram:group:1", channel: "telegram", chatType: "group", senderRole: "owner", cwd: CWD }).ownerDm).toBe(false);
    expect(chatCallContext({ sessionKey: "telegram:dm:2", channel: "telegram", chatType: "dm", senderRole: "user", cwd: CWD }).ownerDm).toBe(false);
  });

  it("addHook appends instead of overwriting", () => {
    const options: Options = {};
    const a: HookCallbackMatcher = { hooks: [async () => ({})] };
    const b: HookCallbackMatcher = { hooks: [async () => ({})] };
    addHook(options, "Stop", a);
    addHook(options, "Stop", b);
    expect(options.hooks?.Stop).toEqual([a, b]);
  });
});

describe("installCanUseToolWarningFilter", () => {
  it("drops exactly the canUseTool-shadowed warning and passes everything else", () => {
    const emitted: unknown[][] = [];
    const target = { emitWarning: (...args: unknown[]) => void emitted.push(args) } as unknown as { emitWarning: (...args: never[]) => void };
    const uninstall = installCanUseToolWarningFilter(target);
    expect(installCanUseToolWarningFilter(target)).toBe(uninstall);

    const emit = target.emitWarning as unknown as (...args: unknown[]) => void;
    emit("canUseTool will not be invoked", { code: CAN_USE_TOOL_SHADOWED_WARNING });
    emit("legacy form", "Warning", CAN_USE_TOOL_SHADOWED_WARNING);
    emit(Object.assign(new Error("as error"), { code: CAN_USE_TOOL_SHADOWED_WARNING }));
    emit("MaxListenersExceededWarning", { code: "OTHER" });
    emit("plain warning");
    expect(emitted).toEqual([["MaxListenersExceededWarning", { code: "OTHER" }], ["plain warning"]]);

    uninstall();
    (target.emitWarning as unknown as (...args: unknown[]) => void)("after", { code: CAN_USE_TOOL_SHADOWED_WARNING });
    expect(emitted).toHaveLength(3);
  });
});
