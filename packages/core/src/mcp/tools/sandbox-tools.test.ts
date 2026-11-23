import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createSandboxTools, createSandboxToolsWith } from "./sandbox-tools.js";
import { truncateSandboxOutput, sandboxBashTimeoutSeconds } from "../../sandbox/bash-runner.js";

const DOCKER_ENV = {
  KIRIE_SANDBOX_MODE: "docker",
  KIRIE_SANDBOX_CONTAINER: "kirie-sandbox-shared",
  KIRIE_SANDBOX_WORKDIR: "/Users/tester/.kirie/sandbox-workspace",
  KIRIE_DOCKER_BIN: "/usr/local/bin/docker",
  KIRIE_SANDBOX_TIMEOUT: "120",
};

interface FakeRun {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  /** Never close (to test the client kill). */
  hang?: boolean;
}

function fakeSpawn(run: FakeRun) {
  const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
  const spawn = vi.fn((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(child, { stdout, stderr, stdin, kill: vi.fn(() => { setImmediate(() => child.emit("close", null)); return true; }) });
    if (!run.hang) {
      setImmediate(() => {
        if (run.stdout) stdout.write(run.stdout);
        if (run.stderr) stderr.write(run.stderr);
        stdout.end();
        stderr.end();
        setImmediate(() => child.emit("close", run.code ?? 0));
      });
    }
    return child;
  });
  return { spawn, calls };
}

const ctx = (env: Record<string, string | undefined>) => ({ dbDir: "/nonexistent", env, gatewayUrl: "http://127.0.0.1:1" });

describe("sandbox tools", () => {
  it("only sandbox_status exists outside docker mode", () => {
    expect(Object.keys(createSandboxTools(ctx({})))).toEqual(["sandbox_status"]);
    expect(Object.keys(createSandboxTools(ctx({ KIRIE_SANDBOX_MODE: "native" })))).toEqual(["sandbox_status"]);
    expect(Object.keys(createSandboxTools(ctx(DOCKER_ENV))).sort()).toEqual(["sandbox_bash", "sandbox_status"]);
  });

  it("no tool can change the mode, the write list or the container", () => {
    const names = Object.keys(createSandboxTools(ctx(DOCKER_ENV)));
    expect(names.every((n) => n === "sandbox_status" || n === "sandbox_bash")).toBe(true);
  });

  it("sandbox_bash takes the built-in Bash input shape", () => {
    const def = createSandboxTools(ctx(DOCKER_ENV)).sandbox_bash!;
    expect(Object.keys(def.parameters.properties).sort()).toEqual(["command", "description", "run_in_background", "timeout"]);
    expect(def.parameters.required).toEqual(["command"]);
  });

  it("runs docker exec with the in-container timeout; the command is one argument", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "hello\n", code: 0 });
    const tool = createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!;
    const out = await tool.handler({ command: "echo hello | tr a-z A-Z; ls ~", timeout: 30_000 });
    expect(out).toEqual({ exitCode: 0, output: "hello\n" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/local/bin/docker");
    expect(calls[0]!.args).toEqual([
      "exec", "-i", "-w", DOCKER_ENV.KIRIE_SANDBOX_WORKDIR, "kirie-sandbox-shared",
      "timeout", "-k", "5", "30", "bash", "-lc", "echo hello | tr a-z A-Z; ls ~",
    ]);
    expect(calls[0]!.options.shell).toBe(false);
  });

  it("gives the docker client a minimal environment (no secrets)", async () => {
    const token = ["sk", "ant", "synthetic", "y".repeat(16)].join("-");
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = token;
    try {
      const { spawn, calls } = fakeSpawn({ stdout: "", code: 0 });
      await createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!.handler({ command: "env" });
      const env = calls[0]!.options.env as Record<string, string>;
      expect(JSON.stringify(env)).not.toContain(token);
      expect(Object.keys(env)).not.toContain("KIRIE_SANDBOX_CONTAINER");
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("accepts the pinned container id from the environment", async () => {
    const { spawn, calls } = fakeSpawn({ stdout: "", code: 0 });
    const id = "a".repeat(64);
    await createSandboxToolsWith({ spawn })(ctx({ ...DOCKER_ENV, KIRIE_SANDBOX_CONTAINER: id })).sandbox_bash!.handler({ command: "id" });
    expect(calls[0]!.args[4]).toBe(id);
  });

  it("reports a non-zero exit with stdout and stderr", async () => {
    const { spawn } = fakeSpawn({ stdout: "partial\n", stderr: "boom\n", code: 3 });
    const out = await createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!.handler({ command: "false" });
    expect(out).toEqual({ exitCode: 3, output: "partial\nboom\n" });
  });

  it("marks a timeout", async () => {
    const { spawn } = fakeSpawn({ stderr: "", code: 124 });
    const out = (await createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!.handler({ command: "sleep 999", timeout: 2000 })) as Record<string, unknown>;
    expect(out.timedOut).toBe(true);
    expect(out.note).toBe("stopped after 2 s");
  });

  it("truncates long output keeping head and tail", async () => {
    const big = `HEAD${"x".repeat(100_000)}TAIL`;
    const { spawn } = fakeSpawn({ stdout: big, code: 0 });
    const out = (await createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!.handler({ command: "cat big" })) as { output: string; truncated: boolean };
    expect(out.truncated).toBe(true);
    expect(out.output.length).toBeLessThan(31_000);
    expect(out.output.startsWith("HEAD")).toBe(true);
    expect(out.output.endsWith("TAIL")).toBe(true);
    expect(out.output).toMatch(/characters omitted/);
  });

  it("a missing container is an error and nothing runs on the host", async () => {
    const { spawn, calls } = fakeSpawn({ stderr: "Error response from daemon: No such container: kirie-sandbox-shared\n", code: 1 });
    const tool = createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!;
    await expect(tool.handler({ command: "touch /tmp/x" })).rejects.toThrow(/not available.*Nothing ran on this Mac/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("/usr/local/bin/docker");
  });

  it("Docker down is an error too", async () => {
    const { spawn } = fakeSpawn({ stderr: "Cannot connect to the Docker daemon at unix:///x. Is the docker daemon running?\n", code: 1 });
    await expect(createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!.handler({ command: "ls" })).rejects.toThrow(/not available/);
  });

  it("rejects run_in_background and the escape flag without running anything", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    const tool = createSandboxToolsWith({ spawn })(ctx(DOCKER_ENV)).sandbox_bash!;
    await expect(tool.handler({ command: "sleep 1", run_in_background: true })).rejects.toThrow(/run_in_background is not supported/);
    await expect(tool.handler({ command: "ls", dangerouslyDisableSandbox: true })).rejects.toThrow(/cannot be disabled/);
    await expect(tool.handler({ command: "   " })).rejects.toThrow(/command is required/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a bad target from the environment without running anything", async () => {
    const { spawn } = fakeSpawn({ code: 0 });
    for (const bad of [
      { ...DOCKER_ENV, KIRIE_DOCKER_BIN: "docker" },
      { ...DOCKER_ENV, KIRIE_SANDBOX_CONTAINER: "my-privileged-box" },
      { ...DOCKER_ENV, KIRIE_SANDBOX_WORKDIR: "relative" },
      { KIRIE_SANDBOX_MODE: "docker" },
    ]) {
      await expect(createSandboxToolsWith({ spawn })(ctx(bad)).sandbox_bash!.handler({ command: "ls" })).rejects.toThrow(/unavailable.*Nothing ran on this Mac/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("sandbox_status proxies GET only and adds the session's mode", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ mode: "docker", docker: { healthy: true } }), { status: 200 });
    });
    const out = await createSandboxToolsWith({ fetch: fetchMock as unknown as typeof fetch })(ctx(DOCKER_ENV)).sandbox_status!.handler({});
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:1/api/sandbox/status");
    expect(out).toEqual({ mode: "docker", docker: { healthy: true }, session: { modeAtSessionStart: "docker" } });
  });

  it("sandbox_status reports an unreachable gateway", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const out = await createSandboxToolsWith({ fetch: fetchMock as unknown as typeof fetch })(ctx({})).sandbox_status!.handler({});
    expect(out).toEqual({ session: { modeAtSessionStart: "off" }, error: "sandbox status is unavailable" });
  });
});

describe("helpers", () => {
  it("truncateSandboxOutput leaves short text alone", () => {
    expect(truncateSandboxOutput("abc")).toEqual({ text: "abc", truncated: false });
  });

  it("timeout seconds: Bash's milliseconds, default from config, max 600", () => {
    expect(sandboxBashTimeoutSeconds(undefined, 120)).toBe(120);
    expect(sandboxBashTimeoutSeconds(1500, 120)).toBe(2);
    expect(sandboxBashTimeoutSeconds(9_999_999, 120)).toBe(600);
    expect(sandboxBashTimeoutSeconds(-5, 900)).toBe(600);
  });
});
