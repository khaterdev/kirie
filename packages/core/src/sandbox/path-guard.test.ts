import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookCallback, HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import { ApprovalsConfigSchema } from "../config/sections/approvals.js";
import { SdkOptionsPipeline, type SdkCallContext, type SdkCallKind, type ToolGateCall } from "../engine/sdk-options.js";
import { ApprovalEngine } from "../approvals/engine.js";
import { createApprovalsGate } from "../approvals/gate.js";
import type { ApprovalPrompter } from "../approvals/prompter.js";
import { createSandboxPathGuard, SandboxGuardStats, SANDBOX_PATH_GUARD_MATCHER } from "./path-guard.js";
import { createSandboxContributor } from "./sdk-contributor.js";
import { SANDBOX_BASH_TOOL, SandboxSpawnRegistry, type SandboxPolicySource } from "./policy.js";
import type { SandboxMode } from "./types.js";

let root: string;
let home: string;
let dataDir: string;
let ws: string;
let mode: SandboxMode;
let healthy: boolean;
let allowWrite: string[];
let configOver: Record<string, unknown>;

function source(): SandboxPolicySource {
  return {
    mode: () => mode,
    config: () => SandboxConfigSchema.parse({ mode, ...configOver }),
    allowWrite: () => allowWrite,
    pathEnv: () => ({ home, dataDir }),
    workspaceDir: () => ws,
    dockerReadPaths: () => [join(dataDir, "media")],
    docker: () => ({ healthy, container: "kirie-sandbox-shared" }),
    generation: () => 1,
  };
}

function ctx(kind: SdkCallKind = "chat"): SdkCallContext {
  return { kind, sessionKey: "telegram:dm:1", ownerDm: true, interactive: kind === "chat", label: `x ${kind}`, cwd: dataDir };
}

let spawns: SandboxSpawnRegistry;
let stats: SandboxGuardStats;
let audit: { record: ReturnType<typeof vi.fn> };

function guard() {
  return createSandboxPathGuard({ source: source(), spawns, audit, stats });
}

function call(tool: string, input: Record<string, unknown>, c: SdkCallContext = ctx(), extra: Partial<ToolGateCall> = {}): ToolGateCall {
  return { tool, input, toolUseId: "t1", cwd: dataDir, ctx: c, ...extra };
}

async function verdict(tool: string, input: Record<string, unknown>, c?: SdkCallContext): Promise<string> {
  const v = await guard().check(call(tool, input, c));
  return v.decision === "deny" ? `deny: ${v.reason}` : v.decision;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-sbx-guard-")));
  home = join(root, "home");
  dataDir = join(home, ".kirie");
  ws = join(dataDir, "sandbox-workspace");
  for (const d of [join(dataDir, "secrets"), join(dataDir, "state"), join(dataDir, "media"), ws, join(home, ".ssh"), join(home, "dev"), join(home, "other")]) {
    mkdirSync(d, { recursive: true });
  }
  mode = "off";
  healthy = true;
  allowWrite = [];
  configOver = {};
  spawns = new SandboxSpawnRegistry();
  stats = new SandboxGuardStats();
  audit = { record: vi.fn() };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sandbox-path-guard: off", () => {
  it("passes everything", async () => {
    expect(await verdict("Bash", { command: "rm -rf /" })).toBe("pass");
    expect(await verdict("Write", { file_path: join(home, ".ssh", "authorized_keys") })).toBe("pass");
    expect(await verdict(SANDBOX_BASH_TOOL, { command: "ls" })).toBe("pass");
  });

  it("matches only the tools it guards", () => {
    for (const t of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "Grep", "Glob", "Monitor", SANDBOX_BASH_TOOL]) expect(SANDBOX_PATH_GUARD_MATCHER.test(t), t).toBe(true);
    for (const t of ["WebFetch", "Agent", "mcp__kirie-tools__send_message", "BashOutput", "Bash2"]) expect(SANDBOX_PATH_GUARD_MATCHER.test(t), t).toBe(false);
  });
});

describe("sandbox-path-guard: native", () => {
  beforeEach(() => {
    mode = "native";
  });

  it("allows writes in the cwd, the base dirs and allowed folders", async () => {
    allowWrite = [join(home, "dev")];
    expect(await verdict("Write", { file_path: join(dataDir, "notes.md") })).toBe("pass");
    expect(await verdict("Write", { file_path: "/tmp/kirie-x.txt" })).toBe("pass");
    expect(await verdict("Edit", { file_path: join(home, "dev", "a.ts") })).toBe("pass");
    expect(await verdict("NotebookEdit", { notebook_path: join(dataDir, "media", "n.ipynb") })).toBe("pass");
  });

  it("denies writes outside them", async () => {
    expect(await verdict("Write", { file_path: join(home, "other", "a.txt") })).toMatch(/deny: .*outside.*allow-write/);
    expect(await verdict("MultiEdit", { file_path: join(home, ".zshrc") })).toMatch(/^deny/);
  });

  it("denies protected files even under the cwd, in any letter case", async () => {
    expect(await verdict("Write", { file_path: join(dataDir, "config.yaml") })).toMatch(/deny: .*protected/);
    expect(await verdict("Edit", { file_path: join(dataDir, "state", "runtime-settings.json") })).toMatch(/deny: .*protected/);
    expect(await verdict("Write", { file_path: join(dataDir, "SECRETS", "x.env") })).toMatch(/deny: .*protected/);
    expect(await verdict("Write", { file_path: join(dataDir, "goals.db") })).toMatch(/deny: .*protected/);
  });

  it("denies a symlink escape and a .. traversal out of an allowed folder", async () => {
    allowWrite = [join(home, "dev")];
    symlinkSync(join(home, "other"), join(home, "dev", "out"));
    expect(await verdict("Write", { file_path: join(home, "dev", "out", "x.txt") })).toMatch(/deny: .*outside/);
    expect(await verdict("Write", { file_path: `${home}/dev/../other/x.txt` })).toMatch(/deny: .*"\.\."/);
    symlinkSync(join(dataDir, "secrets"), join(home, "dev", "s"));
    expect(await verdict("Write", { file_path: join(home, "dev", "s", "token.env") })).toMatch(/deny: .*protected/);
  });

  it("refuses any path with .. (symlink then .. cannot be checked safely)", async () => {
    allowWrite = [join(home, "dev")];
    mkdirSync(join(home, "other", "deep"), { recursive: true });
    symlinkSync(join(home, "other", "deep"), join(home, "dev", "deep"));
    // Lexically ~/dev/x.txt; really ~/other/x.txt.
    expect(await verdict("Write", { file_path: `${home}/dev/deep/../x.txt` })).toMatch(/deny: .*"\.\."/);
  });

  it("denies reads of protected credential files and passes ordinary reads", async () => {
    expect(await verdict("Read", { file_path: join(dataDir, "secrets", "voice.env") })).toMatch(/deny: .*protected/);
    expect(await verdict("Read", { file_path: join(home, ".ssh", "id_ed25519") })).toMatch(/^deny/);
    expect(await verdict("Read", { file_path: join(home, ".ssh", "id_ed25519.pub") })).toBe("pass");
    expect(await verdict("Read", { file_path: join(home, "other", "readme.md") })).toBe("pass");
    expect(await verdict("Grep", { pattern: "x" })).toBe("pass");
    expect(await verdict("Glob", { pattern: `${home}/.ssh/id_*` })).toMatch(/^deny/);
  });

  it("denies a write tool without a path and control characters", async () => {
    expect(await verdict("Write", { content: "x" })).toMatch(/deny: .*explicit path/);
    expect(await verdict("Write", { file_path: `${dataDir}/a\u0000b` })).toMatch(/^deny/);
  });

  it("denies the escape flag and shells the SDK sandbox does not cover", async () => {
    expect(await verdict("Bash", { command: "ls" })).toBe("pass");
    expect(await verdict("Bash", { command: "ls", dangerouslyDisableSandbox: true })).toMatch(/deny: .*cannot leave/);
    expect(await verdict("Monitor", { command: "tail -f x", description: "d", timeout_ms: 1000 })).toMatch(/^deny/);
    expect(await verdict("PowerShell", { command: "ls" })).toMatch(/^deny/);
    configOver = { native: { allowUnsandboxed: true } };
    expect(await verdict("Bash", { command: "ls", dangerouslyDisableSandbox: true })).toBe("pass");
  });

  it("audits denials without the command or file content", async () => {
    await verdict("Write", { file_path: join(dataDir, "config.yaml"), content: "token: abc" });
    const rec = audit.record.mock.calls[0]![0];
    expect(rec).toMatchObject({ feature: "sandbox", action: "gate.denied", detail: { tool: "Write", rule: "write.protected", mode: "native" } });
    expect(JSON.stringify(rec)).not.toContain("token: abc");
    expect(stats.denied).toBe(1);
  });
});

describe("sandbox-path-guard: docker", () => {
  beforeEach(() => {
    mode = "docker";
  });

  it("denies every host shell by name, the backstop for the alias", async () => {
    for (const t of ["Bash", "Monitor", "PowerShell"]) expect(await verdict(t, { command: "id" }), t).toMatch(/deny: .*sandbox container.*sandbox_bash/);
  });

  it("denies a subagent's literal Bash too", async () => {
    const v = await guard().check(call("Bash", { command: "id" }, ctx(), { agentId: "a1", agentType: "general-purpose" }));
    expect(v.decision).toBe("deny");
  });

  it("allows sandbox_bash only while the container is healthy", async () => {
    expect(await verdict(SANDBOX_BASH_TOOL, { command: "id" })).toBe("pass");
    healthy = false;
    expect(await verdict(SANDBOX_BASH_TOOL, { command: "id" })).toMatch(/deny: .*not running.*Nothing ran/);
  });

  it("limits file writes to the workspace", async () => {
    expect(await verdict("Write", { file_path: join(ws, "out.txt") })).toBe("pass");
    expect(await verdict("Write", { file_path: join(dataDir, "notes.md") })).toMatch(/deny: .*only write inside/);
    expect(await verdict("Edit", { file_path: `${ws}/../config.yaml` })).toMatch(/^deny/);
    symlinkSync(join(home, ".ssh"), join(ws, "keys"));
    expect(await verdict("Write", { file_path: join(ws, "keys", "authorized_keys") })).toMatch(/^deny/);
  });

  it("limits reads to the workspace, media and listed folders", async () => {
    expect(await verdict("Read", { file_path: join(ws, "a.txt") })).toBe("pass");
    expect(await verdict("Read", { file_path: join(dataDir, "media", "photo.jpg") })).toBe("pass");
    expect(await verdict("Read", { file_path: join(home, "other", "a.txt") })).toMatch(/deny: .*only read inside/);
    expect(await verdict("Grep", { pattern: "x" })).toMatch(/^deny/);
    expect(await verdict("Grep", { pattern: "x", path: ws })).toBe("pass");
    expect(await verdict("Glob", { pattern: "**/*.ts", path: ws })).toBe("pass");
    expect(await verdict("Glob", { pattern: `${home}/other/*`, path: ws })).toMatch(/^deny/);
  });

  it("passes tools it does not guard", async () => {
    expect((await guard().check(call("WebFetch", { url: "https://example.com" }))).decision).toBe("pass");
  });
});

describe("sandbox-path-guard: spawn mode versus live mode", () => {
  it("a query spawned in docker keeps its rules after the owner switches off", async () => {
    mode = "docker";
    const c = ctx("background");
    createSandboxContributor({ source: source(), spawns })({ cwd: dataDir }, c);
    mode = "off";
    expect(await verdict("Bash", { command: "id" }, c)).toMatch(/^deny/);
    expect(await verdict("Write", { file_path: join(dataDir, "x.md") }, c)).toMatch(/^deny/);
  });

  it("a query spawned before a switch to docker loses host Bash at once (fail closed)", async () => {
    const c = ctx();
    createSandboxContributor({ source: source(), spawns })({ cwd: dataDir }, c);
    mode = "docker";
    expect(await verdict("Bash", { command: "id" }, c)).toMatch(/^deny/);
  });

  it("a query spawned off keeps its Bash after a switch to native (background tasks keep their mode)", async () => {
    const c = ctx("background");
    createSandboxContributor({ source: source(), spawns })({ cwd: dataDir }, c);
    mode = "native";
    expect(await verdict("Bash", { command: "ls", dangerouslyDisableSandbox: true }, c)).toBe("pass");
    // File tools follow the stricter mode at once.
    expect(await verdict("Write", { file_path: join(home, "other", "x") }, c)).toMatch(/^deny/);
  });

  it("utility, judge, triage and oneshot calls are not judged", async () => {
    mode = "docker";
    for (const kind of ["utility", "judge", "triage", "oneshot"] as const) expect(await verdict("Bash", { command: "touch x" }, ctx(kind)), kind).toBe("pass");
  });
});

describe("through the real pipeline with the approval gate", () => {
  function setup(): { pipeline: SdkOptionsPipeline; opts: Options; c: SdkCallContext } {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerContributor("sandbox", createSandboxContributor({ source: source(), spawns }), 50);
    pipeline.registerGate(guard());
    const engine = new ApprovalEngine({
      config: ApprovalsConfigSchema.parse({}),
      homeDir: home,
      dataDir,
      sandboxInfo: () => (mode === "docker" && healthy ? { mode: "docker", network: "none" } : { mode: "off" }),
    });
    const prompter = { request: vi.fn(async () => ({ approved: false, reason: "no" })) } as unknown as ApprovalPrompter;
    pipeline.registerGate(createApprovalsGate(engine, prompter));
    const c = ctx();
    const opts: Options = { cwd: dataDir, permissionMode: "bypassPermissions", mcpServers: { "kirie-tools": { command: "node", args: ["x"], env: {} } } };
    pipeline.apply(opts, c);
    return { pipeline, opts, c };
  }

  function hook(opts: Options): HookCallback {
    return opts.hooks!.PreToolUse![0]!.hooks[0]!;
  }

  async function run(opts: Options, tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const id = `u-${Math.random()}`;
    const hookInput = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, tool_use_id: id, session_id: "s", transcript_path: "/tmp/t", cwd: dataDir, ...extra } as HookInput;
    return hook(opts)(hookInput, id, { signal: new AbortController().signal });
  }

  it("docker: the hardline list still blocks a sandboxed command (same classifier)", async () => {
    mode = "docker";
    const { opts } = setup();
    const out = await run(opts, SANDBOX_BASH_TOOL, { command: "rm -rf /" });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(JSON.stringify(out)).toMatch(/hardline|catastrophic|rm/i);
    expect(await run(opts, SANDBOX_BASH_TOOL, { command: "ls -la" })).toEqual({});
  });

  it("docker: a subagent's literal Bash is denied before the approval gate", async () => {
    mode = "docker";
    const { opts } = setup();
    const out = await run(opts, "Bash", { command: "id" }, { agent_id: "a1", agent_type: "general-purpose" });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(JSON.stringify(out)).toContain("sandbox_bash");
  });

  it("native: the hardline list still blocks Bash", async () => {
    mode = "native";
    const { opts } = setup();
    expect(opts.sandbox?.enabled).toBe(true);
    const out = await run(opts, "Bash", { command: "rm -rf ~" });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("off: nothing changes and plain calls pass", async () => {
    const { opts } = setup();
    expect(opts.sandbox).toBeUndefined();
    expect(opts.disallowedTools).toBeUndefined();
    expect(await run(opts, "Bash", { command: "ls" })).toEqual({});
  });
});

describe("review regressions (W3-SBX independent review)", () => {
  it("docker: .. after a planted symlink or a missing folder never passes (reported escape)", async () => {
    mode = "docker";
    symlinkSync(join(home, ".ssh"), join(ws, "link"));
    mkdirSync(join(ws, "a", "b"), { recursive: true });
    symlinkSync(join(ws, "a", "b"), join(ws, "deep"));
    expect(await verdict("Write", { file_path: `${ws}/nope/../link/authorized_keys` })).toMatch(/^deny/);
    expect(await verdict("Write", { file_path: `${ws}/deep/../link/authorized_keys` })).toMatch(/^deny/);
    expect(await verdict("Read", { file_path: `${ws}/nope/../link/id_rsa` })).toMatch(/^deny/);
    expect(await verdict("Glob", { pattern: "../**", path: ws })).toMatch(/^deny/);
  });

  it("native: .. is refused too", async () => {
    mode = "native";
    expect(await verdict("Write", { file_path: `${dataDir}/nope/../notes.md` })).toMatch(/^deny/);
    expect(await verdict("Read", { file_path: "../x" })).toMatch(/^deny/);
  });

  it("docker: no symlink inside the workspace is followed by host file tools, even one pointing inside", async () => {
    mode = "docker";
    mkdirSync(join(ws, "real"));
    symlinkSync(join(ws, "real"), join(ws, "alias"));
    expect(await verdict("Write", { file_path: join(ws, "alias", "x.txt") })).toMatch(/deny: .*symlink inside the sandbox workspace/);
    expect(await verdict("Read", { file_path: join(ws, "alias", "x.txt") })).toMatch(/deny: .*symlink/);
    expect(await verdict("Write", { file_path: join(ws, "real", "x.txt") })).toBe("pass");
  });

  it("docker: a link swapped in after creation is seen at call time (lstat on every call)", async () => {
    mode = "docker";
    mkdirSync(join(ws, "x"));
    expect(await verdict("Write", { file_path: join(ws, "x", "f") })).toBe("pass");
    rmSync(join(ws, "x"), { recursive: true });
    symlinkSync(home, join(ws, "x"));
    expect(await verdict("Write", { file_path: join(ws, "x", "f") })).toMatch(/^deny/);
  });

  it("adding an MCP server is denied while a sandbox is on", async () => {
    for (const m of ["native", "docker"] as const) {
      mode = m;
      expect(await verdict("mcp__kirie-tools__mcp_servers_add", { name: "x", command: "sh" }), m).toMatch(/deny: .*MCP servers/);
    }
    mode = "off";
    expect(await verdict("mcp__kirie-tools__mcp_servers_add", { name: "x", command: "sh" })).toBe("pass");
  });

  it("native: Monitor is denied even without a command", async () => {
    mode = "native";
    expect(await verdict("Monitor", { ws: { url: "wss://x" }, description: "d", timeout_ms: 1 })).toMatch(/^deny/);
  });

  it("native: Kirie's scripts, node_modules, bot API data and config backups are protected", async () => {
    mode = "native";
    for (const p of ["scripts/run.sh", "node_modules/x/index.js", "telegram-bot-api/x", "hook.py", "config.yaml.bak-1"]) {
      expect(await verdict("Write", { file_path: join(dataDir, p) }), p).toMatch(/deny: .*protected/);
    }
    for (const p of ["telegram-bot-api/x", "config.yaml.bak-1", "state/runtime-settings.json", "backups/a"]) {
      expect(await verdict("Read", { file_path: join(dataDir, p) }), p).toMatch(/deny: .*protected/);
    }
  });
});
