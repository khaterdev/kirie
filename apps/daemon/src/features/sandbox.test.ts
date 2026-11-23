import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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
  type SdkCallContext,
} from "@kirie/core";
import type { DaemonContext } from "./types.js";

/** The SDK's Options type, without a direct dependency of the daemon on the SDK package. */
type Options = Parameters<SdkOptionsPipeline["apply"]>[0];
import { setupApprovals, approvalEngineFor } from "./approvals.js";
import { setupSandbox, sandboxControllerFor } from "./sandbox.js";

const OWNER = "1001";

describe("setupSandbox", () => {
  let dir: string;
  let ctx: DaemonContext;
  let sdkOptions: SdkOptionsPipeline;
  let heartbeat: EventEmitter;

  function build(sandbox: Record<string, unknown> = {}): DaemonContext {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    sdkOptions = new SdkOptionsPipeline();
    heartbeat = new EventEmitter();
    ctx = {
      config: KirieConfigSchema.parse({ sandbox }),
      dataDir: join(dir, "kirie"),
      agentCwd: join(dir, "kirie"),
      commands: new CommandRegistry({ owners }),
      owners,
      ownerPrompts: { requestApproval: vi.fn(async () => ({ outcome: "denied", optionId: "deny", code: "K7Q2" })), pending: () => [] },
      settings: new RuntimeSettings(join(dir, "state", "runtime-settings.json")),
      audit: new AuditTrail(join(dir, "audit.jsonl")),
      sdkOptions,
      turnContext: new TurnContextRegistry(),
      promptAddenda: new PromptAddenda(),
      internalApi: new InternalApi(),
      heartbeat,
      v2Sessions: null,
      kirieToolsEnv: {},
      notifyOwner: vi.fn(async () => {}),
    } as unknown as DaemonContext;
    return ctx;
  }

  const chat = (): SdkCallContext => ({ kind: "chat", sessionKey: "telegram:dm:1001", ownerDm: true, interactive: true, label: "chat telegram:dm", cwd: join(dir, "kirie") });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-sbx-feature-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers the contributor, the gate, /sandbox, the addendum and the read-only route", async () => {
    build();
    const handle = await setupSandbox(ctx);
    expect(handle.name).toBe("sandbox");
    expect(sdkOptions.gateNames()).toEqual(["reserved-mcp", "task-profile", "sandbox-path-guard"]);
    expect(ctx.commands.get("sandbox")).toMatchObject({ ownerOnly: true, scope: "dm", category: "security" });
    expect(ctx.promptAddenda.names()).toEqual(["sandbox"]);
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toBe("");
    expect(ctx.internalApi.apps().map((a) => a.name)).toEqual(["sandbox"]);
    // No tool flag in the shared kirie-tools env: the contributor sets it per spawn.
    expect(ctx.kirieToolsEnv).toEqual({});
    expect(sandboxControllerFor(ctx)?.mode()).toBe("off");
  });

  it("off by default: the options passed to query() are untouched", async () => {
    build();
    await setupSandbox(ctx);
    const servers = { "kirie-tools": { command: "node", args: ["x"], env: { KIRIE_DB_DIR: "/x" } } };
    const opts: Options = { cwd: join(dir, "kirie"), permissionMode: "bypassPermissions", allowedTools: ["Bash(*)"], mcpServers: servers };
    sdkOptions.apply(opts, chat());
    expect(opts.sandbox).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
    expect(opts.toolAliases).toBeUndefined();
    expect(opts.mcpServers).toBe(servers);
    expect(opts.allowedTools).toEqual(["Bash(*)"]);
  });

  it("native from config: the spawn gets the SDK sandbox", async () => {
    build({ mode: "native" });
    await setupSandbox(ctx);
    const opts: Options = { cwd: join(dir, "kirie") };
    sdkOptions.apply(opts, chat());
    expect(opts.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(ctx.promptAddenda.render({ kind: "chat", ownerDm: true })).toMatch(/macOS sandbox/);
  });

  it("docker from config without a running container: Bash disallowed, no alias (fail closed)", async () => {
    build({ mode: "docker" });
    await setupSandbox(ctx); // setup only; start (which talks to Docker) is not run here
    const opts: Options = { cwd: join(dir, "kirie") };
    sdkOptions.apply(opts, chat());
    expect(opts.disallowedTools).toEqual(["Bash", "Monitor", "PowerShell"]);
    expect(opts.toolAliases).toBeUndefined();
  });

  it("hands the live sandbox state to the approval engine", async () => {
    build({ mode: "docker" });
    await setupApprovals(ctx);
    const engine = approvalEngineFor(ctx)!;
    const spy = vi.spyOn(engine, "setSandboxInfo");
    await setupSandbox(ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    const provider = spy.mock.calls[0]![0] as () => unknown;
    // The container is not up, so the engine is not told it is sandboxed.
    expect(provider()).toEqual({ mode: "off" });
    expect(sdkOptions.gateNames()).toEqual(["reserved-mcp", "task-profile", "sandbox-path-guard", "approvals"]);
  });

  it("start and stop in off mode touch nothing but the heartbeat listener", async () => {
    build();
    const handle = await setupSandbox(ctx);
    await handle.start?.();
    expect(heartbeat.listenerCount("tick")).toBe(1);
    heartbeat.emit("tick", { tickNumber: 30 });
    await handle.stop?.();
    expect(heartbeat.listenerCount("tick")).toBe(0);
    expect(sdkOptions.gateNames()).not.toContain("sandbox-path-guard");
    expect(ctx.notifyOwner).not.toHaveBeenCalled();
  });

  it("the status route answers GET only", async () => {
    build();
    await setupSandbox(ctx);
    const app = ctx.internalApi.apps()[0]!.app;
    expect((await app.request("/status")).status).toBe(200);
    expect((await app.request("/status", { method: "POST" })).status).toBe(404);
  });
});
