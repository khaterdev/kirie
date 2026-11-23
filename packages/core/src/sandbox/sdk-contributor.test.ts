import { describe, it, expect } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import type { SdkCallContext, SdkCallKind } from "../engine/sdk-options.js";
import { createSandboxContributor } from "./sdk-contributor.js";
import { SANDBOX_BASH_TOOL, SandboxSpawnRegistry, type SandboxPolicySource } from "./policy.js";
import type { SandboxMode } from "./types.js";

const HOME = "/Users/tester";
const DATA = `${HOME}/.kirie`;
const WS = `${DATA}/sandbox-workspace`;

function source(mode: SandboxMode, over: { healthy?: boolean; allowWrite?: string[]; config?: Record<string, unknown> } = {}): SandboxPolicySource {
  const config = SandboxConfigSchema.parse({ mode, ...(over.config ?? {}) });
  return {
    mode: () => mode,
    config: () => config,
    allowWrite: () => over.allowWrite ?? [],
    pathEnv: () => ({ home: HOME, dataDir: DATA, realpath: (p) => p, readdir: () => [] }),
    workspaceDir: () => WS,
    dockerReadPaths: () => [`${DATA}/media`],
    docker: () => ({ healthy: over.healthy ?? true, container: "kirie-sandbox-shared", binary: "/usr/local/bin/docker" }),
    generation: () => 7,
  };
}

function ctx(kind: SdkCallKind = "chat"): SdkCallContext {
  return { kind, sessionKey: "telegram:dm:1", ownerDm: true, interactive: kind === "chat", label: `x ${kind}`, cwd: DATA };
}

function baseOptions(): Options {
  return {
    cwd: DATA,
    permissionMode: "bypassPermissions",
    allowedTools: ["Bash(*)", "Read"],
    disallowedTools: ["WebSearch"],
    mcpServers: { "kirie-tools": { command: "node", args: ["stdio.js"], env: { KIRIE_DB_DIR: DATA } }, other: { command: "x" } },
  };
}

describe("sandbox contributor", () => {
  it("off: options are untouched", () => {
    const spawns = new SandboxSpawnRegistry();
    const fn = createSandboxContributor({ source: source("off"), spawns });
    const opts = baseOptions();
    const before = JSON.parse(JSON.stringify(opts));
    const c = ctx();
    fn(opts, c);
    expect(JSON.parse(JSON.stringify(opts))).toEqual(before);
    expect(spawns.get(c)?.mode).toBe("off");
  });

  it("native: sets the SDK sandbox, fail-closed and without an escape hatch", () => {
    const fn = createSandboxContributor({ source: source("native", { allowWrite: [`${HOME}/dev`] }), spawns: new SandboxSpawnRegistry() });
    const opts = baseOptions();
    fn(opts, ctx());
    const sb = opts.sandbox!;
    expect(sb.enabled).toBe(true);
    expect(sb.failIfUnavailable).toBe(true);
    expect(sb.allowUnsandboxedCommands).toBe(false);
    expect(sb.autoAllowBashIfSandboxed).toBe(true);
    expect(sb.filesystem?.allowWrite).toEqual(expect.arrayContaining(["/tmp", "/private/tmp", `${DATA}/media`, `${HOME}/dev`]));
    for (const p of ["config.yaml", "state", "secrets", "credentials"]) expect(sb.filesystem?.denyWrite).toContain(`${DATA}/${p}`);
    expect(sb.filesystem?.denyRead).toContain(`${DATA}/secrets`);
    expect(sb.network).toBeUndefined();
    expect(opts.disallowedTools).toEqual(["WebSearch"]);
    expect(opts.toolAliases).toBeUndefined();
  });

  it("native: network limits only when the owner lists domains", () => {
    const fn = createSandboxContributor({ source: source("native", { config: { native: { allowedDomains: ["github.com"] } } }), spawns: new SandboxSpawnRegistry() });
    const opts = baseOptions();
    fn(opts, ctx());
    expect(opts.sandbox?.network).toEqual({ allowedDomains: ["github.com"] });
  });

  it("docker healthy: disallows host shells, aliases Bash, and gives this spawn's kirie-tools the container", () => {
    const fn = createSandboxContributor({ source: source("docker"), spawns: new SandboxSpawnRegistry() });
    const opts = baseOptions();
    const sharedServers = opts.mcpServers!;
    const sharedAllowed = opts.allowedTools!;
    fn(opts, ctx());
    expect(opts.disallowedTools).toEqual(["WebSearch", "Bash", "Monitor", "PowerShell"]);
    expect(opts.toolAliases).toEqual({ Bash: SANDBOX_BASH_TOOL });
    expect(opts.allowedTools).toContain(SANDBOX_BASH_TOOL);
    const env = (opts.mcpServers!["kirie-tools"] as { env: Record<string, string> }).env;
    expect(env).toMatchObject({
      KIRIE_DB_DIR: DATA,
      KIRIE_SANDBOX_MODE: "docker",
      KIRIE_SANDBOX_CONTAINER: "kirie-sandbox-shared",
      KIRIE_SANDBOX_WORKDIR: WS,
      KIRIE_DOCKER_BIN: "/usr/local/bin/docker",
      KIRIE_SANDBOX_TIMEOUT: "120",
      KIRIE_SANDBOX_NETWORK: "none",
    });
    // Shared objects the engines reuse are never mutated.
    expect((sharedServers["kirie-tools"] as { env: Record<string, string> }).env).toEqual({ KIRIE_DB_DIR: DATA });
    expect(sharedAllowed).toEqual(["Bash(*)", "Read"]);
    expect(opts.mcpServers!.other).toBe(sharedServers.other);
    expect(opts.sandbox).toBeUndefined();
  });

  it("docker unhealthy: fail closed, Bash disallowed with no alias", () => {
    const fn = createSandboxContributor({ source: source("docker", { healthy: false }), spawns: new SandboxSpawnRegistry() });
    const opts = baseOptions();
    opts.toolAliases = { Bash: SANDBOX_BASH_TOOL, Foo: "Bar" };
    fn(opts, ctx());
    expect(opts.disallowedTools).toContain("Bash");
    expect(opts.toolAliases).toEqual({ Foo: "Bar" });
    expect(opts.allowedTools).not.toContain(SANDBOX_BASH_TOOL);
  });

  it("applies to background, goal and webhook tasks too", () => {
    for (const kind of ["background", "goal", "webhook"] as const) {
      const opts = baseOptions();
      createSandboxContributor({ source: source("docker"), spawns: new SandboxSpawnRegistry() })(opts, ctx(kind));
      expect(opts.disallowedTools, kind).toContain("Bash");
    }
  });

  it("never touches judge, triage, oneshot or utility calls", () => {
    for (const kind of ["judge", "triage", "oneshot", "utility"] as const) {
      for (const mode of ["native", "docker"] as const) {
        const opts = baseOptions();
        const before = JSON.parse(JSON.stringify(opts));
        createSandboxContributor({ source: source(mode), spawns: new SandboxSpawnRegistry() })(opts, ctx(kind));
        expect(JSON.parse(JSON.stringify(opts)), `${kind} ${mode}`).toEqual(before);
      }
    }
  });

  it("does not duplicate an existing disallowed Bash", () => {
    const opts = baseOptions();
    opts.disallowedTools = ["Bash"];
    createSandboxContributor({ source: source("docker"), spawns: new SandboxSpawnRegistry() })(opts, ctx());
    expect(opts.disallowedTools.filter((t) => t === "Bash")).toHaveLength(1);
  });

  it("records what each spawn got", () => {
    const spawns = new SandboxSpawnRegistry();
    const c = ctx();
    createSandboxContributor({ source: source("docker", { healthy: false }), spawns })(baseOptions(), c);
    expect(spawns.get(c)).toEqual({ mode: "docker", generation: 7, cwd: DATA, dockerHealthy: false });
    expect(spawns.staleChats(7)).toEqual([]);
    expect(spawns.staleChats(8)).toEqual(["telegram:dm:1"]);
  });
});
