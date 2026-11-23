import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSandboxAllowWritePath,
  expandSandboxPathList,
  resolveSandboxPath,
  sandboxDenyReadPaths,
  sandboxDenyWritePaths,
  sandboxMountRefusal,
  sandboxPathInside,
} from "./paths.js";

let root: string;
let home: string;
let dataDir: string;
const env = () => ({ home, dataDir });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-sbx-paths-")));
  home = join(root, "home");
  dataDir = join(home, ".kirie");
  mkdirSync(join(dataDir, "secrets"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(home, "dev"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("resolveSandboxPath", () => {
  it("expands ~ and resolves relative paths against cwd", () => {
    expect(resolveSandboxPath("~/dev/a.txt", "/", env()).real).toBe(join(home, "dev", "a.txt"));
    expect(resolveSandboxPath("a.txt", join(home, "dev"), env()).real).toBe(join(home, "dev", "a.txt"));
    expect(resolveSandboxPath("../.ssh/x", join(home, "dev"), env()).real).toBe(join(home, ".ssh", "x"));
  });

  it("follows a symlink out of an allowed folder", () => {
    symlinkSync(join(home, ".ssh"), join(home, "dev", "keys"));
    const r = resolveSandboxPath(join(home, "dev", "keys", "id_ed25519"), "/", env());
    expect(r.lexical).toBe(join(home, "dev", "keys", "id_ed25519"));
    expect(r.real).toBe(join(home, ".ssh", "id_ed25519"));
  });

  it("applies .. after the symlink, the way the kernel does", () => {
    mkdirSync(join(home, ".ssh", "sub"));
    symlinkSync(join(home, ".ssh", "sub"), join(home, "dev", "link"));
    const r = resolveSandboxPath(`${home}/dev/link/../authorized_keys`, "/", env());
    // Lexically this looks like ~/dev/authorized_keys; the kernel lands in ~/.ssh.
    expect(r.lexical).toBe(join(home, "dev", "authorized_keys"));
    expect(r.real).toBe(join(home, ".ssh", "authorized_keys"));
  });

  it("resolves plain .. traversal", () => {
    expect(resolveSandboxPath(`${home}/dev/../.ssh/x`, "/", env()).real).toBe(join(home, ".ssh", "x"));
  });

  it("follows a symlinked file", () => {
    writeFileSync(join(dataDir, "secrets", "token.env"), "");
    symlinkSync(join(dataDir, "secrets", "token.env"), join(home, "dev", "innocent.txt"));
    expect(resolveSandboxPath(join(home, "dev", "innocent.txt"), "/", env()).real).toBe(join(dataDir, "secrets", "token.env"));
  });
});

describe("sandboxPathInside", () => {
  it("is case-insensitive and separator-aware", () => {
    expect(sandboxPathInside("/a/b/c", "/a/b")).toBe(true);
    expect(sandboxPathInside("/A/B", "/a/b")).toBe(true);
    expect(sandboxPathInside("/a/bc", "/a/b")).toBe(false);
  });
});

describe("sandboxMountRefusal", () => {
  it("accepts a folder inside the data directory", () => {
    expect(sandboxMountRefusal(join(dataDir, "sandbox-workspace"), env())).toBeNull();
    expect(sandboxMountRefusal(join(home, "dev", "scratch"), env())).toBeNull();
  });

  it("never the root, home, the data directory, or their ancestors", () => {
    for (const p of ["/", home, root, dataDir, "/Users"]) expect(sandboxMountRefusal(p, env()), p).not.toBeNull();
  });

  it("never secrets, credentials, state, ~/.ssh, ~/.claude*, kubeconfig, the docker socket", () => {
    const bad = [
      join(dataDir, "secrets"), join(dataDir, "credentials", "x"), join(dataDir, "state"),
      join(home, ".ssh"), join(home, ".claude"), join(home, ".claude2", "projects"), join(home, ".kube"),
      "/var/run/docker.sock", "/var/run", join(home, ".docker"), join(home, "Library", "Keychains"), "/etc",
    ];
    for (const p of bad) expect(sandboxMountRefusal(p, env()), p).not.toBeNull();
  });

  it("refuses a symlink that points at a protected folder", () => {
    symlinkSync(join(home, ".ssh"), join(home, "dev", "ws"));
    expect(sandboxMountRefusal(join(home, "dev", "ws"), env())).toMatch(/protected/);
  });

  it("refuses relative paths, commas and control characters", () => {
    expect(sandboxMountRefusal("relative/ws", env())).not.toBeNull();
    expect(sandboxMountRefusal(join(home, "dev", "a,b"), env())).not.toBeNull();
    expect(sandboxMountRefusal(join(home, "dev", "a\nb"), env())).not.toBeNull();
  });
});

describe("checkSandboxAllowWritePath", () => {
  it("accepts a project folder and stores it absolute", () => {
    expect(checkSandboxAllowWritePath("~/dev", env())).toEqual({ ok: true, path: join(home, "dev") });
  });

  it("refuses home, root, system folders and anything containing home", () => {
    for (const p of ["~", "/", "/Users", "/System", "/etc", root]) expect(checkSandboxAllowWritePath(p, env()).ok, p).toBe(false);
  });

  it("refuses protected paths and folders that contain them", () => {
    for (const p of ["~/.ssh", `${dataDir}/secrets`, `${dataDir}/state`, `${dataDir}/config.yaml`, "~/Library", "~/.config", "~/Library/LaunchAgents"]) {
      expect(checkSandboxAllowWritePath(p, env()).ok, p).toBe(false);
    }
  });

  it("refuses wildcards, relative paths and empty input", () => {
    expect(checkSandboxAllowWritePath("~/dev/*", env()).ok).toBe(false);
    expect(checkSandboxAllowWritePath("dev", env()).ok).toBe(false);
    expect(checkSandboxAllowWritePath("  ", env()).ok).toBe(false);
  });
});

describe("protected lists for the SDK sandbox", () => {
  it("denyWrite covers Kirie's config, state, secrets and credentials as plain paths", () => {
    const deny = sandboxDenyWritePaths(env(), [dataDir]);
    for (const p of ["secrets", "credentials", "config.yaml", "state", "plugins"]) expect(deny).toContain(join(dataDir, p));
    expect(deny).toContain(join(home, ".ssh"));
    expect(deny).toContain(join(home, "Library", "LaunchAgents"));
  });

  it("expands wildcard patterns against what exists, honouring exclusions", () => {
    writeFileSync(join(dataDir, "goals.db"), "");
    writeFileSync(join(dataDir, "goals.db-wal"), "");
    writeFileSync(join(home, ".ssh", "id_ed25519"), "");
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "");
    mkdirSync(join(home, ".claude2"));
    writeFileSync(join(home, ".claude2", "settings.json"), "");
    const deny = sandboxDenyWritePaths(env(), [dataDir]);
    expect(deny).toContain(join(dataDir, "goals.db"));
    expect(deny).toContain(join(dataDir, "goals.db-wal"));
    expect(deny).toContain(join(home, ".claude2", "settings.json"));
    const read = sandboxDenyReadPaths(env(), [dataDir]);
    expect(read).toContain(join(home, ".ssh", "id_ed25519"));
    expect(read).not.toContain(join(home, ".ssh", "id_ed25519.pub"));
    expect(read).toContain(join(dataDir, "config.yaml"));
  });

  it("instantiates anywhere-patterns under each writable root", () => {
    const out = expandSandboxPathList(["**/.env", "**/.git/hooks/**"], env(), [join(home, "dev")]);
    expect(out).toContain(join(home, "dev", ".env"));
    expect(out).toContain(join(home, "dev", ".git", "hooks"));
  });

  it("every entry is absolute", () => {
    for (const p of [...sandboxDenyWritePaths(env(), [dataDir]), ...sandboxDenyReadPaths(env(), [dataDir])]) expect(p.startsWith("/"), p).toBe(true);
  });
});
