import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, HookJSONOutput, Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { ComputerUseConfigSchema } from "../config/sections/computer-use.js";
import { chatCallContext, SdkOptionsPipeline, type SdkCallContext } from "../engine/sdk-options.js";
import { TurnContextRegistry, originOf, type TurnOrigin } from "../engine/turn-context.js";
import { AuditTrail } from "../security/audit-trail.js";
import { checkComputerUseBash, createComputerUseGate } from "./gate.js";
import { ComputerUseService } from "./service.js";
import type { ComputerUseExecFn } from "./driver.js";
import type { ComputerUseAppInfo } from "./policy.js";

const HOME = "/Users/tester";
const DRIVER = `${HOME}/.local/bin/cua-driver`;
const OWNER_KEY = "telegram:dm:1001";
const CWD = "/tmp/kirie-cu-gate";
const APPS: Record<number, ComputerUseAppInfo> = {
  10: { bundleId: "com.apple.Notes", name: "Notes" },
  11: { bundleId: "com.apple.finder", name: "Finder" },
  14: { bundleId: "com.1password.1password", name: "1Password" },
};

const healthyExec: ComputerUseExecFn = async (file, args) => {
  const key = `${file} ${args.join(" ")}`;
  if (key.startsWith("/usr/bin/codesign -dv")) return { code: 0, stdout: "", stderr: "Identifier=com.trycua.driver\nTeamIdentifier=ABCDE12345\n" };
  if (key === `${DRIVER} permissions status --json`) {
    return { code: 0, stdout: JSON.stringify({ accessibility: true, screen_recording: true, attribution: "driver-daemon" }), stderr: "" };
  }
  return { code: 0, stdout: "ok", stderr: "" };
};

type Answer = "approved" | "denied" | "timeout";

describe("computer-use gate through the SDK options pipeline", () => {
  let dir: string;
  let audit: AuditTrail;
  let turns: TurnContextRegistry;
  let pipeline: SdkOptionsPipeline;
  let service: ComputerUseService;
  let answer: Answer;
  let requestApproval: ReturnType<typeof vi.fn>;
  let beforeAnswer: (() => Promise<void> | void) | undefined;
  let execCalls: string[];

  function build(over: Record<string, unknown> = {}): void {
    const config = ComputerUseConfigSchema.parse({ enabled: true, ...over });
    execCalls = [];
    service = new ComputerUseService({
      config,
      driver: {
        exec: async (file, args, opts) => { execCalls.push(`${file} ${args.join(" ")}`); return healthyExec(file, args, opts); },
        isExecutable: (p) => p === DRIVER,
        homeDir: HOME,
      },
      originOf: (c) => originOf(c, turns),
      isDangerousText: (t) => /rm -rf/.test(t),
      audit,
      prompts: { requestApproval },
      resolveApp: async (pid) => APPS[pid] ?? null,
    });
    pipeline = new SdkOptionsPipeline();
    pipeline.claimMcpPrefix("mcp__cua-driver", (c) => service.claimAllows(c));
    pipeline.registerContributor("computer-use", (o, c) => service.contribute(o, c), 60);
    pipeline.registerGate(createComputerUseGate(service));
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-cu-gate-"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    turns = new TurnContextRegistry();
    answer = "approved";
    beforeAnswer = undefined;
    requestApproval = vi.fn(async () => {
      await beforeAnswer?.();
      return { outcome: answer, optionId: answer === "approved" ? "approve" : "deny", code: "K7Q2" };
    });
    build();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ownerCtx(over: Partial<SdkCallContext> = {}): SdkCallContext {
    return { ...chatCallContext({ sessionKey: OWNER_KEY, channel: "telegram", chatType: "dm", senderRole: "owner", cwd: CWD }), ...over };
  }

  function begin(origin: TurnOrigin, key = OWNER_KEY): void {
    turns.begin(key, { origin, startedAt: Date.now(), senderId: "1001", senderRole: "owner" });
  }

  function spawn(ctx: SdkCallContext): Options {
    const options: Options = {
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash(*)", "Read"],
      mcpServers: { "kirie-tools": { command: "node", args: ["x.js"] } },
    };
    return pipeline.apply(options, ctx);
  }

  let seq = 0;
  async function call(options: Options, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ pre: HookJSONOutput; final?: PermissionResult }> {
    const id = `tu-${++seq}`;
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const pre = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id, session_id: "s", transcript_path: "", cwd: CWD, ...extra } as HookInput, id, { signal: new AbortController().signal });
    const decision = (pre as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
    if (decision !== "ask") return { pre };
    const final = await options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: id, requestId: "r" } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
    return { pre, ...(final ? { final } : {}) };
  }

  function verdict(r: { pre: HookJSONOutput; final?: PermissionResult }): "allow" | "deny" {
    if (r.final) return r.final.behavior === "allow" ? "allow" : "deny";
    const d = (r.pre as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
    return d === "deny" ? "deny" : "allow";
  }

  function reason(r: { pre: HookJSONOutput; final?: PermissionResult }): string {
    if (r.final && r.final.behavior === "deny") return r.final.message;
    return (r.pre as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? "";
  }

  async function armNow(apps?: string[]): Promise<void> {
    const res = await service.arm({ minutes: 10, ...(apps ? { apps } : {}), by: "owner:telegram:1001" });
    expect(res.ok).toBe(true);
  }

  it("feature off: no server for the owner DM, every cua call denied, tools hidden by full name", async () => {
    build({ enabled: false });
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(options.mcpServers).not.toHaveProperty("cua-driver");
    expect(options.disallowedTools).toContain("mcp__cua-driver__click");
    expect(verdict(await call(options, "mcp__cua-driver__list_apps", {}))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-computer-use__click", { pid: 10 }))).toBe("deny");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("enabled but not armed: no server, every call denied", async () => {
    await service.probe();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(options.mcpServers).not.toHaveProperty("cua-driver");
    expect(verdict(await call(options, "mcp__cua-driver__list_apps", {}))).toBe("deny");
  });

  it("armed: the owner DM gets the server; observe allowed; the first action in an app asks once, then runs", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(options.mcpServers!["cua-driver"]).toMatchObject({ command: DRIVER, args: ["mcp"] });
    expect(service.offeredSessions()).toEqual([OWNER_KEY]);

    expect(verdict(await call(options, "mcp__cua-driver__list_apps", {}))).toBe("allow");
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10, x: 1, y: 2 }))).toBe("allow");
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ kind: "computer", timeoutMs: 120_000 });
    expect(verdict(await call(options, "mcp__cua-driver__type_text", { pid: 10, text: "milk" }))).toBe("allow");
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // Another app asks again.
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 11 }))).toBe("allow");
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("a denied or timed-out approval denies the action and stores no grant", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    answer = "denied";
    const r = await call(options, "mcp__cua-driver__click", { pid: 10 });
    expect(verdict(r)).toBe("deny");
    expect(reason(r)).toMatch(/did not approve/);
    answer = "timeout";
    const t = await call(options, "mcp__cua-driver__click", { pid: 10 });
    expect(verdict(t)).toBe("deny");
    expect(reason(t)).toMatch(/in time/);
    expect(service.arming.grants().size).toBe(0);
  });

  it("/computer off denies the very next call, and the app grant is gone", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10 }))).toBe("allow");
    await service.disarm("owner", "owner:telegram:1001");
    expect(execCalls).toContain(`${DRIVER} stop`);
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10 }))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-driver__list_apps", {}))).toBe("deny");
  });

  it("an approval that arrives after /computer off is not honoured", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    beforeAnswer = async () => { await service.disarm("owner"); };
    const r = await call(options, "mcp__cua-driver__click", { pid: 10 });
    expect(verdict(r)).toBe("deny");
    expect(reason(r)).toMatch(/turned off/);
  });

  it("never for a group, a background task, a goal, a webhook, a voice call, a scheduled or loop turn, or a subagent", async () => {
    await armNow();
    const cases: Array<{ name: string; ctx: SdkCallContext; origin?: TurnOrigin; extra?: Record<string, unknown> }> = [
      { name: "group", ctx: chatCallContext({ sessionKey: "telegram:group:-100", channel: "telegram", chatType: "group", senderRole: "owner", cwd: CWD }), origin: "owner_message" },
      { name: "stranger dm", ctx: chatCallContext({ sessionKey: "telegram:dm:2002", channel: "telegram", chatType: "dm", senderRole: "user", cwd: CWD }), origin: "other_user" },
      { name: "background", ctx: { kind: "background", sessionKey: OWNER_KEY, ownerDm: false, interactive: false, label: "task", cwd: CWD } },
      { name: "goal", ctx: { kind: "goal", sessionKey: OWNER_KEY, ownerDm: false, interactive: false, label: "goal", cwd: CWD } },
      { name: "webhook", ctx: { kind: "webhook", sessionKey: OWNER_KEY, ownerDm: false, interactive: false, label: "hook", cwd: CWD } },
      { name: "voice", ctx: chatCallContext({ sessionKey: "voice:dm:+20100", channel: "voice", chatType: "dm", senderRole: "owner", cwd: CWD }), origin: "owner_message" },
      { name: "schedule", ctx: ownerCtx(), origin: "schedule" },
      { name: "loop", ctx: ownerCtx(), origin: "loop" },
    ];
    for (const c of cases) {
      if (c.origin && c.ctx.sessionKey) begin(c.origin, c.ctx.sessionKey);
      const options = spawn(c.ctx);
      expect(options.mcpServers, c.name).not.toHaveProperty("cua-driver");
      expect(options.disallowedTools, c.name).toContain("mcp__cua-driver__click");
      expect(verdict(await call(options, "mcp__cua-driver__list_apps", {})), c.name).toBe("deny");
      expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10 })), c.name).toBe("deny");
    }
    // A subagent inside the owner's own turn.
    begin("owner_message");
    const owner = spawn(ownerCtx());
    const sub = await call(owner, "mcp__cua-driver__list_apps", {}, { agent_id: "sub-1", agent_type: "general-purpose" });
    expect(verdict(sub)).toBe("deny");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("a docker sandbox keeps the server out even while armed", async () => {
    await armNow();
    begin("owner_message");
    const sandboxed = new ComputerUseService({
      config: service.config,
      driver: { exec: healthyExec, isExecutable: () => true, homeDir: HOME },
      originOf: (c) => originOf(c, turns),
      isDangerousText: () => false,
      sandboxMode: () => "docker",
    });
    await sandboxed.arm({ minutes: 5, by: "owner" });
    const options: Options = { mcpServers: {} };
    sandboxed.contribute(options, ownerCtx());
    expect(options.mcpServers).not.toHaveProperty("cua-driver");
  });

  it("the server of the other reserved name is never usable", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(verdict(await call(options, "mcp__cua-computer-use__list_apps", {}))).toBe("deny");
  });

  it("denied apps, blocked hotkeys and dangerous text are denied without asking", async () => {
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(verdict(await call(options, "mcp__cua-driver__get_window_state", { pid: 14 }))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-driver__hotkey", { pid: 10, keys: ["cmd", "shift", "q"] }))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-driver__type_text", { pid: 10, text: "rm -rf ~" }))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-driver__run_script", { script: "x" }))).toBe("deny");
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("screenshots off: an acting call with include_screenshot false can still be approved (no deny loop)", async () => {
    build({ screenshots: "off" });
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10, include_screenshot: true }))).toBe("deny");
    expect(verdict(await call(options, "mcp__cua-driver__click", { pid: 10, include_screenshot: false }))).toBe("allow");
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("an approval answered after the window's time ran out is not honoured (timers pause in sleep)", async () => {
    let now = Date.now();
    const timed = new ComputerUseService({
      config: service.config,
      driver: { exec: healthyExec, isExecutable: (p) => p === DRIVER, homeDir: HOME },
      originOf: () => "owner_message",
      isDangerousText: () => false,
      prompts: { requestApproval: async () => { now += 11 * 60_000; return { outcome: "approved", optionId: "approve", code: "X" }; } },
      now: () => now,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await timed.arm({ minutes: 10, by: "owner" });
    const res = await timed.requestGrant({ bundleId: "com.apple.Notes" }, "computer:act:com.apple.Notes", { tool: "click", label: "t" }, true, new AbortController().signal);
    expect(res.approved).toBe(false);
    expect(timed.arming.grants().size).toBe(0);
  });

  it("a /computer off while /computer on is probing cancels the arm", async () => {
    const epoch = service.arming.epoch();
    await service.disarm("owner");
    const res = await service.arm({ minutes: 10, by: "owner", epoch });
    expect(res).toMatchObject({ ok: false, reason: "cancelled" });
    expect(service.arming.isArmed()).toBe(false);
  });

  it("screenshots off rewrites the input of get_window_state", async () => {
    build({ screenshots: "off" });
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    const r = await call(options, "mcp__cua-driver__get_window_state", { pid: 10 });
    expect(r.pre).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { pid: 10, include_screenshot: false } } });
  });

  it("audit records the decision and the typed length, never the typed text", async () => {
    build({ approval: "armed-only" });
    await armNow();
    begin("owner_message");
    const options = spawn(ownerCtx());
    const secretish = ["milk", "and", "eggs", "zq81"].join(" ");
    expect(verdict(await call(options, "mcp__cua-driver__type_text", { pid: 10, text: secretish }))).toBe("allow");
    const log = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(log).not.toContain(secretish);
    expect(log).not.toContain("zq81");
    const rec = audit.recent({ feature: "computer-use", action: "call.allowed" }).at(-1)!;
    expect(rec.detail).toMatchObject({ tool: "type_text", app: "com.apple.Notes", chars: secretish.length });
    expect(audit.recent({ feature: "computer-use", action: "armed" })).toHaveLength(1);
  });

  it("Bash tripwire through the gate: denied while disarmed, read-only allowed while armed", async () => {
    begin("owner_message");
    const off = spawn(ownerCtx());
    expect(verdict(await call(off, "Bash", { command: "cua-driver call click --pid 10" }))).toBe("deny");
    expect(verdict(await call(off, "Bash", { command: "ls -la" }))).toBe("allow");
    await armNow();
    const on = spawn(ownerCtx());
    expect(verdict(await call(on, "Bash", { command: "cua-driver status" }))).toBe("allow");
    expect(verdict(await call(on, "Bash", { command: "cua-driver call type_text hi" }))).toBe("deny");
    expect(verdict(await call(on, "Bash", { command: "cua-driver permissions grant" }))).toBe("deny");
  });

  it("CONF-B1: with computer use disabled the tripwire denies nothing, in Bash, Monitor or PowerShell", async () => {
    build({ enabled: false });
    begin("owner_message");
    const options = spawn(ownerCtx());
    for (const command of [
      "grep -rn \"cua-driver\" packages/core/src",
      "git commit -m \"docs: mention cua-driver setup\"",
      "ls /Applications/CuaDriver.app",
      "which cua-driver",
      "brew info cua-driver",
      "cua-driver call click --pid 10",
      "cua-driver permissions grant",
    ]) {
      expect(verdict(await call(options, "Bash", { command })), command).toBe("allow");
    }
    expect(verdict(await call(options, "Monitor", { description: "x", timeout_ms: 1000, command: "cua-driver call click" }))).toBe("allow");
  });

  it("CONF-B1: enabled but not armed, running the driver is denied from Bash, Monitor and PowerShell", async () => {
    begin("owner_message");
    const options = spawn(ownerCtx());
    expect(verdict(await call(options, "Bash", { command: "grep -rn cua-driver packages/core/src" }))).toBe("allow");
    expect(verdict(await call(options, "Bash", { command: "cua-driver call click --pid 10" }))).toBe("deny");
    expect(verdict(await call(options, "Monitor", { description: "x", timeout_ms: 1000, command: "cua-driver call click" }))).toBe("deny");
    expect(verdict(await call(options, "PowerShell", { command: "cua-driver call click" }))).toBe("deny");
    expect(verdict(await call(options, "Monitor", { description: "x", timeout_ms: 1000, command: "tail -f /tmp/x" }))).toBe("allow");
  });

  it("the probe and the driver stop never pass grant, connect, update or serve", async () => {
    await armNow();
    await service.disarm("owner");
    for (const c of execCalls) expect(c).not.toMatch(/\b(grant|connect|update|serve|install)\b/);
  });
});

describe("checkComputerUseBash", () => {
  it("always denies the state-changing subcommands", () => {
    for (const cmd of [
      "cua-driver permissions grant",
      "~/.local/bin/cua-driver connect claude",
      "cua-driver update",
      "cua-driver serve --port 9000",
      "cua-driver config set mode unrestricted",
      "cua-driver telemetry enable",
      "echo hi && /Users/x/.local/bin/cua-driver install",
    ]) {
      expect(checkComputerUseBash(cmd, true), cmd).toMatch(/never grants/);
      expect(checkComputerUseBash(cmd, false), cmd).toMatch(/never grants/);
    }
  });

  it("disarmed: denies running the driver or opening its app", () => {
    for (const cmd of [
      "cua-driver status", "npx cua-driver mcp", "open -a /Applications/CuaDriver.app", "echo x; cua-driver call click", "c'u'a-driver call click",
      "cua\\-driver call click", '"cua-driver" mcp', "open -a CuaDriver", "open /Applications/CuaDriver.app", "open -b com.trycua.driver",
      "~/.local/bin/cua-driver call click", "env cua-driver call click", "sudo -u me cua-driver call click", "bash -c 'cua-driver call click'",
      "echo 1 | xargs cua-driver call click", "c=cua; \"$c-driver\" call click", "~/.local/bin/cua-* call click", "d=driver; cua-$d call click",
      "pnpm dlx cua-driver mcp", "bunx cua-driver@latest mcp", "osascript -e 'tell application \"CuaDriver\" to activate'",
    ]) {
      expect(checkComputerUseBash(cmd, false), cmd).not.toBeNull();
    }
  });

  it("disarmed: a mention that does not run the driver passes (CONF-B1)", () => {
    for (const cmd of [
      "grep -rn \"cua-driver\" packages/core/src", "git commit -m \"docs: mention cua-driver setup\"", "ls /Applications/CuaDriver.app", "which cua-driver",
      "brew info cua-driver", "echo \"cua-driver is not installed\"", "pgrep -f com.trycua.driver", "cat docs/computer-use-setup.md | grep CuaDriver.app",
      "rg -n 'checkComputerUseBash|cua-driver' packages", "\"$PYTHON\" tool.py", "$EDITOR notes.md",
    ]) {
      expect(checkComputerUseBash(cmd, false), cmd).toBeNull();
    }
  });

  it("computer use disabled: nothing is denied, not even the state-changing subcommands (CONF-B1)", () => {
    for (const cmd of ["cua-driver call click", "cua-driver permissions grant", "/Applications/CuaDriver.app/Contents/MacOS/CuaDriver serve", "open -a CuaDriver"]) {
      expect(checkComputerUseBash(cmd, false, false), cmd).toBeNull();
      expect(checkComputerUseBash(cmd, true, false), cmd).toBeNull();
    }
  });

  it("armed: only read-only subcommands", () => {
    for (const cmd of ["cua-driver status", "cua-driver --version", "cua-driver permissions status --json", "cua-driver doctor", "cua-driver list-tools", "cua-driver stop"]) {
      expect(checkComputerUseBash(cmd, true), cmd).toBeNull();
    }
    for (const cmd of ["cua-driver call click", "cua-driver mcp", "cua-driver", "ls && cua-driver call hotkey cmd+q", "c'u'a-driver call click", "/Applications/CuaDriver.app/Contents/MacOS/CuaDriver serve", "/Applications/CuaDriver.app/Contents/MacOS/CuaDriver"]) {
      expect(checkComputerUseBash(cmd, true), cmd).not.toBeNull();
    }
    expect(checkComputerUseBash("c'u'a-dri\\ver serve", true)).toMatch(/never grants/);
  });

  it("passes commands that do not involve the driver", () => {
    for (const cmd of ["ls", "git status", "echo cua-driver-notes.txt", "cat my-cua-driver.log", ""]) {
      expect(checkComputerUseBash(cmd, false), cmd).toBeNull();
    }
  });
});
