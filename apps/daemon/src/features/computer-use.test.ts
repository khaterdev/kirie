import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  CommandRegistry,
  InternalApi,
  KirieConfigSchema,
  OwnerDirectory,
  PromptAddenda,
  SdkOptionsPipeline,
  TurnContextRegistry,
  chatCallContext,
  type CommandReply,
  type ComputerUseExecFn,
  type McpServerConfig,
  type ResolvedIdentity,
  type SdkCallContext,
  type UnifiedMessage,
} from "@kirie/core";
import { createComputerUseSetup, computerUseServiceFor } from "./computer-use.js";
import type { DaemonContext } from "./types.js";

type Options = Parameters<SdkOptionsPipeline["apply"]>[0];
type PreToolUseHook = NonNullable<NonNullable<Options["hooks"]>["PreToolUse"]>[number]["hooks"][number];

const OWNER = "1001";
const HOME = "/Users/tester";
const DRIVER = `${HOME}/.local/bin/cua-driver`;
const OWNER_KEY = `telegram:dm:${OWNER}`;
const CWD = "/tmp/kirie-cu-feature";

const healthyExec: ComputerUseExecFn = async (file, args) => {
  const key = `${file} ${args.join(" ")}`;
  if (key.startsWith("/usr/bin/codesign -dv")) return { code: 0, stdout: "", stderr: "Identifier=com.trycua.driver\nTeamIdentifier=ABCDE12345\n" };
  if (key === `${DRIVER} permissions status --json`) {
    return { code: 0, stdout: JSON.stringify({ accessibility: true, screen_recording: true, attribution: "driver-daemon" }), stderr: "" };
  }
  if (key.startsWith("/usr/bin/lsappinfo")) {
    return { code: 0, stdout: args.includes("bundleid") ? '"CFBundleIdentifier"="com.apple.Notes"' : '"LSDisplayName"="Notes"', stderr: "" };
  }
  return { code: 0, stdout: "ok", stderr: "" };
};

interface Harness {
  ctx: DaemonContext;
  pipeline: SdkOptionsPipeline;
  turns: TurnContextRegistry;
  commands: CommandRegistry;
  internalApi: InternalApi;
  addenda: PromptAddenda;
  closeAndWait: ReturnType<typeof vi.fn>;
  notifyOwner: ReturnType<typeof vi.fn>;
  requestApproval: ReturnType<typeof vi.fn>;
  execCalls: string[];
  mcpServers: Record<string, McpServerConfig>;
}

describe("computer-use feature", () => {
  let dir: string;
  let timers: Array<{ fn: () => void; ms: number }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-cu-feature-"));
    timers = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function harness(computerUse: Record<string, unknown> = { enabled: true }): Promise<Harness & { handle: Awaited<ReturnType<ReturnType<typeof createComputerUseSetup>>> }> {
    const owners = new OwnerDirectory({ telegram: [OWNER] });
    const audit = new AuditTrail(join(dir, "audit.jsonl"));
    const requestApproval = vi.fn(async () => ({ outcome: "approved", optionId: "approve", code: "K7Q2" }));
    const commands = new CommandRegistry({ owners, prompts: { requestApproval } as never, audit });
    const pipeline = new SdkOptionsPipeline();
    const turns = new TurnContextRegistry();
    const internalApi = new InternalApi();
    const addenda = new PromptAddenda();
    const closeAndWait = vi.fn(async () => {});
    const notifyOwner = vi.fn(async () => {});
    const execCalls: string[] = [];
    const mcpServers: Record<string, McpServerConfig> = {
      "kirie-tools": { command: "node", args: ["stdio-server.js"] },
      "cua-driver": { command: DRIVER, args: ["mcp"] },
      desktop: { command: "/opt/bin/cua-driver", args: ["mcp"] },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    };
    const ctx = {
      config: KirieConfigSchema.parse({ computerUse }),
      dataDir: dir,
      agentCwd: dir,
      commands,
      owners,
      ownerPrompts: { requestApproval },
      settings: { effective: (_k: string, _s: unknown, v: unknown) => v },
      audit,
      sdkOptions: pipeline,
      turnContext: turns,
      promptAddenda: addenda,
      internalApi,
      v2Sessions: { isBusy: () => false, closeAndWait },
      mcpServers,
      kirieToolsEnv: {},
      notifyOwner,
    } as unknown as DaemonContext;
    const setup = createComputerUseSetup({
      driver: {
        exec: async (f, a, o) => { execCalls.push(`${f} ${a.join(" ")}`); return healthyExec(f, a, o); },
        isExecutable: (p) => p === DRIVER,
        homeDir: HOME,
      },
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => {},
    });
    const handle = await setup(ctx);
    return { ctx, pipeline, turns, commands, internalApi, addenda, closeAndWait, notifyOwner, requestApproval, execCalls, mcpServers, handle };
  }

  async function command(h: Harness, text: string): Promise<string> {
    const replies: CommandReply[] = [];
    const message = { id: "1", channel: "telegram", senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null } as UnifiedMessage;
    await h.commands.dispatch({
      message,
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r) => { replies.push(r); },
    });
    return replies.map((r) => r.text).join("\n");
  }

  function ownerCtx(): SdkCallContext {
    return chatCallContext({ sessionKey: OWNER_KEY, channel: "telegram", chatType: "dm", senderRole: "owner", cwd: CWD });
  }

  function spawn(h: Harness, ctx: SdkCallContext): Options {
    return h.pipeline.apply({
      permissionMode: "bypassPermissions",
      mcpServers: h.mcpServers,
      allowedTools: ["Read", "mcp__cua-driver__*"],
    }, ctx);
  }

  async function pre(options: Options, tool: string, input: Record<string, unknown>): Promise<string | undefined> {
    const hook: PreToolUseHook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const hookInput = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: CWD };
    const out = await hook(hookInput as Parameters<PreToolUseHook>[0], "t1", { signal: new AbortController().signal });
    return (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;
  }

  it("removes cua-driver servers from the shared map and registers its seams", async () => {
    const h = await harness();
    expect(Object.keys(h.mcpServers).sort()).toEqual(["kirie-tools", "linear"]);
    expect(h.pipeline.gateNames()).toContain("computer-use");
    expect(h.commands.get("computer")).toBeDefined();
    expect(h.internalApi.apps().map((a) => a.name)).toEqual(["computer-use"]);
    expect(h.addenda.names()).toContain("computer-use");
  });

  it("feature off: still registered, every cua call denied, no server, and /computer off is a kill switch", async () => {
    const h = await harness({ enabled: false });
    await h.handle.start?.();
    expect(h.execCalls).toEqual([]);
    h.turns.begin(OWNER_KEY, { origin: "owner_message", startedAt: Date.now() });
    const options = spawn(h, ownerCtx());
    expect(options.mcpServers).not.toHaveProperty("cua-driver");
    expect(options.allowedTools).toEqual(["Read"]);
    expect(await pre(options, "mcp__cua-driver__list_apps", {})).toBe("deny");
    expect(await command(h, "/computer on 10")).toMatch(/off in config/);
    expect(await command(h, "/computer off")).toMatch(/it is off/);
    expect(h.execCalls.filter((c) => c.startsWith(DRIVER))).toEqual([`${DRIVER} stop`]);
    expect(h.addenda.render({ kind: "chat", channel: "telegram", chatType: "dm", ownerDm: true })).not.toMatch(/computer_use/);
  });

  it("start probes the driver; /computer on arms and restarts the owner's idle session; only the owner DM spawn gets the server", async () => {
    const h = await harness();
    await h.handle.start?.();
    await vi.waitFor(() => expect(h.execCalls.some((c) => c.endsWith("permissions status --json"))).toBe(true));
    // Disarmed after start.
    h.turns.begin(OWNER_KEY, { origin: "owner_message", startedAt: Date.now() });
    expect(spawn(h, ownerCtx()).mcpServers).not.toHaveProperty("cua-driver");

    expect(await command(h, "/computer on 10 Notes")).toMatch(/Armed for 10 min, apps: Notes/);
    expect(h.closeAndWait).toHaveBeenCalledWith(OWNER_KEY, 5_000);

    const owner = spawn(h, ownerCtx());
    expect(owner.mcpServers!["cua-driver"]).toMatchObject({ command: DRIVER, args: ["mcp"], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" } });
    expect(await pre(owner, "mcp__cua-driver__list_apps", {})).toBeUndefined();
    expect(await pre(owner, "mcp__cua-driver__click", { pid: 42 })).toBe("ask");

    const groupKey = "telegram:group:-100";
    h.turns.begin(groupKey, { origin: "owner_message", startedAt: Date.now() });
    const group = spawn(h, chatCallContext({ sessionKey: groupKey, channel: "telegram", chatType: "group", senderRole: "owner", cwd: CWD }));
    expect(group.mcpServers).not.toHaveProperty("cua-driver");
    expect(await pre(group, "mcp__cua-driver__list_apps", {})).toBe("deny");

    const voiceKey = "voice:dm:+201000000000";
    h.turns.begin(voiceKey, { origin: "owner_message", startedAt: Date.now() });
    const voice = spawn(h, chatCallContext({ sessionKey: voiceKey, channel: "voice", chatType: "dm", senderRole: "owner", cwd: CWD }));
    expect(voice.mcpServers).not.toHaveProperty("cua-driver");
    expect(await pre(voice, "mcp__cua-driver__list_apps", {})).toBe("deny");

    const task = spawn(h, { kind: "background", sessionKey: OWNER_KEY, ownerDm: false, interactive: false, label: "task", cwd: CWD });
    expect(task.mcpServers).not.toHaveProperty("cua-driver");
    expect(await pre(task, "mcp__cua-driver__list_apps", {})).toBe("deny");

    // The addendum exists for the owner's DM while the feature is enabled.
    expect(h.addenda.render({ kind: "chat", channel: "telegram", chatType: "dm", ownerDm: true })).toMatch(/computer_use/);
  });

  it("the window's end disarms, tells the owner, stops the driver and restarts the sessions that had the server", async () => {
    const h = await harness();
    await h.handle.start?.();
    await command(h, "/computer on 5");
    h.turns.begin(OWNER_KEY, { origin: "owner_message", startedAt: Date.now() });
    const options = spawn(h, ownerCtx());
    expect(options.mcpServers).toHaveProperty("cua-driver");
    h.closeAndWait.mockClear();
    const timer = timers.at(-1)!;
    expect(timer.ms).toBe(5 * 60_000);
    timer.fn();
    expect(computerUseServiceFor(h.ctx)!.arming.isArmed()).toBe(false);
    expect(h.notifyOwner).toHaveBeenCalledWith(expect.stringMatching(/window ended/));
    expect(h.closeAndWait).toHaveBeenCalledWith(OWNER_KEY, 5_000);
    await vi.waitFor(() => expect(h.execCalls).toContain(`${DRIVER} stop`));
    expect(await pre(options, "mcp__cua-driver__list_apps", {})).toBe("deny");
  });

  it("a restart (new setup) always comes up disarmed; stop disarms", async () => {
    const first = await harness();
    await first.handle.start?.();
    await command(first, "/computer on 30");
    expect(computerUseServiceFor(first.ctx)!.arming.isArmed()).toBe(true);
    await first.handle.stop?.();
    expect(computerUseServiceFor(first.ctx)!.arming.isArmed()).toBe(false);
    const second = await harness();
    expect(computerUseServiceFor(second.ctx)!.arming.isArmed()).toBe(false);
  });

  it("no MCP tool and no HTTP route can arm it", async () => {
    const h = await harness();
    await h.handle.start?.();
    const app = h.internalApi.apps()[0]!.app;
    for (const [method, path] of [["POST", "/on"], ["POST", "/arm"], ["POST", "/status"], ["GET", "/on"]] as const) {
      expect((await app.request(path, { method })).status).toBe(404);
    }
    expect((await app.request("/status")).status).toBe(200);
    expect(computerUseServiceFor(h.ctx)!.arming.isArmed()).toBe(false);
  });
});
