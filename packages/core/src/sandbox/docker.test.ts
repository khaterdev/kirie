import { describe, it, expect } from "vitest";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import {
  SANDBOX_DOCKER_BINARY_CANDIDATES,
  buildSandboxCreateArgs,
  buildSandboxExecArgs,
  resolveSandboxDockerBinary,
  sandboxContainerFingerprint,
  sandboxDockerClientEnv,
  sandboxDockerImagePresent,
} from "./docker.js";
import { FakeDocker } from "./fake-docker.test-util.js";

const WS = "/Users/tester/.kirie/sandbox-workspace";

function params(over: Record<string, unknown> = {}) {
  return {
    name: "kirie-sandbox-shared",
    config: SandboxConfigSchema.parse({ mode: "docker", docker: over }),
    workspaceDir: WS,
    uid: 501,
    gid: 20,
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildSandboxCreateArgs", () => {
  it("carries every hardening flag", () => {
    const args = buildSandboxCreateArgs(params());
    expect(args[0]).toBe("create");
    expect(flag(args, "--user")).toBe("501:20");
    expect(args).toContain("--init");
    expect(args).toContain("--read-only");
    expect(flag(args, "--cap-drop")).toBe("ALL");
    expect(flag(args, "--security-opt")).toBe("no-new-privileges");
    expect(flag(args, "--pids-limit")).toBe("256");
    expect(flag(args, "--memory")).toBe("1g");
    expect(flag(args, "--cpus")).toBe("2");
    expect(flag(args, "--network")).toBe("none");
    expect(flag(args, "--tmpfs")).toBe("/tmp:rw,nosuid,nodev,size=256m");
    expect(flag(args, "--workdir")).toBe(WS);
    expect(args).toContain("kirie.sandbox=1");
    expect(args.slice(-3)).toEqual(["kirie-sandbox:latest", "sleep", "infinity"]);
  });

  it("mounts exactly the workspace, at the identical path, and nothing else", () => {
    const args = buildSandboxCreateArgs(params());
    const mounts = args.filter((_a, i) => args[i - 1] === "--mount");
    expect(mounts).toEqual([`type=bind,source=${WS},target=${WS}`]);
    expect(args).not.toContain("-v");
    expect(args).not.toContain("--volume");
    const joined = args.join(" ");
    expect(joined).not.toMatch(/docker\.sock/);
    expect(joined).not.toMatch(/source=\/Users\/tester,|source=\/Users\/tester\/\.kirie,/);
    expect(args).not.toContain("--privileged");
  });

  it("only none or bridge networks, never host", () => {
    expect(flag(buildSandboxCreateArgs(params({ network: "bridge" })), "--network")).toBe("bridge");
    // A value that slipped past the schema still becomes none.
    const bad = params();
    (bad.config.docker as { network: string }).network = "host";
    expect(flag(buildSandboxCreateArgs(bad), "--network")).toBe("none");
    expect(() => SandboxConfigSchema.parse({ docker: { network: "host" } })).toThrow();
  });

  it("ignores attempts to weaken the hardening in config", () => {
    const args = buildSandboxCreateArgs(params({ readOnlyRoot: false, capDrop: ["NET_RAW"] }));
    expect(args).toContain("--read-only");
    expect(flag(args, "--cap-drop")).toBe("ALL");
  });

  it("passes no environment except HOME=/tmp", () => {
    const args = buildSandboxCreateArgs(params());
    const envs = args.filter((_a, i) => args[i - 1] === "--env" || args[i - 1] === "-e");
    expect(envs).toEqual(["HOME=/tmp"]);
  });

  it("fingerprint changes when anything that sets the strength changes", () => {
    const base = sandboxContainerFingerprint(params());
    expect(sandboxContainerFingerprint(params())).toBe(base);
    expect(sandboxContainerFingerprint(params({ network: "bridge" }))).not.toBe(base);
    expect(sandboxContainerFingerprint(params({ memory: "2g" }))).not.toBe(base);
    expect(sandboxContainerFingerprint(params({ image: "other:1" }))).not.toBe(base);
  });
});

describe("buildSandboxExecArgs", () => {
  it("uses the in-container timeout and passes the command as one argument", () => {
    const cmd = "echo hi; rm -rf $HOME/x && echo \"$(whoami)\"";
    expect(buildSandboxExecArgs({ container: "kirie-sandbox-shared", workdir: WS, command: cmd, timeoutSeconds: 30 })).toEqual([
      "exec", "-i", "-w", WS, "kirie-sandbox-shared", "timeout", "-k", "5", "30", "bash", "-lc", cmd,
    ]);
  });

  it("caps the timeout at 600 s and floors it at 1 s", () => {
    expect(buildSandboxExecArgs({ container: "c", workdir: WS, command: "x", timeoutSeconds: 9999 })[8]).toBe("600");
    expect(buildSandboxExecArgs({ container: "c", workdir: WS, command: "x", timeoutSeconds: 0 })[8]).toBe("1");
  });

  it("never forwards environment variables into the container", () => {
    const args = buildSandboxExecArgs({ container: "c", workdir: WS, command: "env", timeoutSeconds: 5 });
    expect(args).not.toContain("-e");
    expect(args).not.toContain("--env");
    expect(args).not.toContain("--env-file");
  });
});

describe("resolveSandboxDockerBinary", () => {
  it("uses the configured absolute path", () => {
    expect(resolveSandboxDockerBinary("/opt/docker/bin/docker", () => true)).toEqual({ ok: true, path: "/opt/docker/bin/docker" });
  });

  it("refuses a relative or missing configured path, without falling back", () => {
    expect(resolveSandboxDockerBinary("docker", () => true).ok).toBe(false);
    expect(resolveSandboxDockerBinary("/nope/docker", () => false).ok).toBe(false);
  });

  it("tries the known locations in order and never PATH", () => {
    const seen: string[] = [];
    const r = resolveSandboxDockerBinary(undefined, (p) => {
      seen.push(p);
      return p === "/opt/homebrew/bin/docker";
    });
    expect(r).toEqual({ ok: true, path: "/opt/homebrew/bin/docker" });
    expect(seen).toEqual(SANDBOX_DOCKER_BINARY_CANDIDATES.slice(0, 2));
    const none = resolveSandboxDockerBinary(undefined, () => false);
    expect(none.ok).toBe(false);
  });
});

describe("sandboxDockerClientEnv", () => {
  it("keeps only what the docker CLI needs; no secrets reach the client", () => {
    const token = ["sk", "ant", "synthetic", "x".repeat(20)].join("-");
    const env = sandboxDockerClientEnv({
      HOME: "/Users/tester",
      DOCKER_CONTEXT: "desktop-linux",
      ANTHROPIC_API_KEY: token,
      CLAUDE_CONFIG_DIR: "/Users/tester/.claude2",
      KIRIE_DB_DIR: "/Users/tester/.kirie",
      TELEGRAM_BOT_TOKEN: token,
      PATH: "/evil/bin:/usr/bin",
    });
    expect(Object.keys(env).sort()).toEqual(["DOCKER_CONTEXT", "HOME", "PATH"]);
    expect(env.PATH).not.toContain("/evil/bin");
    expect(JSON.stringify(env)).not.toContain(token);
  });
});

describe("image presence", () => {
  it("inspects and never pulls", async () => {
    const fake = new FakeDocker();
    expect(await sandboxDockerImagePresent(fake.exec, "kirie-sandbox:latest")).toBe(true);
    expect(await sandboxDockerImagePresent(fake.exec, "missing:latest")).toBe(false);
    expect(fake.allArgs()).not.toContain("pull");
  });
});
