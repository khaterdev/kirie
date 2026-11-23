import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditTrail,
  CommandRegistry,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  RuntimeSettings,
  SdkOptionsPipeline,
  TurnContextRegistry,
} from "@kirie/core";
import type { DaemonContext } from "./types.js";
import { setupApprovals, approvalEngineFor, APPROVALS_PROMPT_ADDENDUM } from "./approvals.js";

const OWNER = "1001";

describe("setupApprovals", () => {
  let dir: string;
  let ctx: DaemonContext;
  let sdkOptions: SdkOptionsPipeline;
  let settings: RuntimeSettings;

  function build(approvals: Record<string, unknown> = {}): DaemonContext {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    sdkOptions = new SdkOptionsPipeline();
    settings = new RuntimeSettings(join(dir, "state", "runtime-settings.json"));
    ctx = {
      config: KirieConfigSchema.parse({ approvals }),
      dataDir: join(dir, "kirie"),
      agentCwd: join(dir, "kirie"),
      commands: new CommandRegistry({ owners }),
      owners,
      ownerPrompts: { requestApproval: vi.fn(async () => ({ outcome: "denied", optionId: "deny", code: "K7Q2" })), pending: () => [] },
      settings,
      audit: new AuditTrail(join(dir, "audit.jsonl")),
      sdkOptions,
      turnContext: new TurnContextRegistry(),
      promptAddenda: new PromptAddenda(),
      internalApi: new InternalApi(),
      notifyOwner: vi.fn(async () => {}),
    } as unknown as DaemonContext;
    return ctx;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-apr-feature-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers the gate, the command, the addendum and the read-only status route", async () => {
    build();
    const handle = await setupApprovals(ctx);
    expect(handle.name).toBe("approvals");
    expect(sdkOptions.gateNames()).toEqual(["reserved-mcp", "task-profile", "approvals"]);
    expect(ctx.commands.get("approvals")).toBeDefined();
    expect(ctx.promptAddenda.names()).toEqual(["approvals"]);
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toBe(APPROVALS_PROMPT_ADDENDUM);
    expect(APPROVALS_PROMPT_ADDENDUM.split("\n").length).toBe(5);
    const apps = ctx.internalApi.apps();
    expect(apps.map((a) => a.name)).toEqual(["approvals"]);
    const res = await apps[0]!.app.request("/status");
    expect(await res.json()).toEqual({ enabled: true, mode: "yolo", askScope: "dangerous", pending: 0 });
    expect(approvalEngineFor(ctx)).toBeDefined();
  });

  it("approvals.enabled: false installs no gate and no addendum; the command still reports it", async () => {
    build({ enabled: false });
    await setupApprovals(ctx);
    expect(sdkOptions.gateNames()).toEqual(["reserved-mcp", "task-profile"]);
    expect(ctx.promptAddenda.names()).toEqual([]);
    expect(ctx.commands.get("approvals")).toBeDefined();
  });

  it("the installed gate blocks hardline in yolo and follows a runtime mode change", async () => {
    build();
    await setupApprovals(ctx);
    const options = sdkOptions.apply({ permissionMode: "bypassPermissions" } as Parameters<SdkOptionsPipeline["apply"]>[0], {
      kind: "chat", sessionKey: `telegram:dm:${OWNER}`, channel: "telegram", chatType: "dm", senderRole: "owner",
      ownerDm: true, interactive: true, label: "chat telegram:dm", cwd: join(dir, "kirie"),
    });
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const run = (command: string, id: string) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id, session_id: "s", transcript_path: "/tmp/t", cwd: join(dir, "kirie") } as Parameters<typeof hook>[0], id, { signal: new AbortController().signal });
    expect(await run("rm -rf ~", "t1")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await run("git push --force", "t2")).toEqual({});
    settings.set("approvals.mode", "ask", "owner:telegram:1001");
    expect(await run("git push --force", "t3")).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("the sandbox mode override reaches the engine", async () => {
    build();
    await setupApprovals(ctx);
    settings.set("approvals.mode", "ask", "test");
    const engine = approvalEngineFor(ctx)!;
    const sb = { tool: "mcp__kirie-tools__sandbox_bash", input: { command: "rm -rf build" }, cwd: "/", ctx: { kind: "chat" as const, ownerDm: true, interactive: true, label: "x", cwd: "/" } };
    expect(engine.evaluate(sb).decision).toBe("ask");
    settings.set("sandbox.mode", "docker", "test");
    expect(engine.evaluate(sb).decision).toBe("allow");
  });

  it("an engine error notifies the owner at most once an hour", async () => {
    build();
    await setupApprovals(ctx);
    const engine = approvalEngineFor(ctx)!;
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "command", { get() { throw new Error("boom"); }, enumerable: true });
    const call = { tool: "Bash", input: evil, cwd: "/", ctx: { kind: "chat" as const, ownerDm: true, interactive: true, label: "x", cwd: "/" } };
    expect(engine.evaluate(call).decision).toBe("allow");
    engine.evaluate(call);
    expect(ctx.notifyOwner).toHaveBeenCalledTimes(1);
  });
});
