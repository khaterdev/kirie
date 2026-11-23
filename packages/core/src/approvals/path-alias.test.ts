/**
 * GATES-B3 regression: protected paths reached through macOS path aliases
 * (`/System/Volumes/Data/...`, `/Volumes/<startup disk>/...`), case folding,
 * directory destinations of cp/mv/ln/install/rsync, recursive copies and
 * extractions into an ancestor of a protected path, and daemon kills.
 * The reviewer's exact `[B3]` and `[B3b]` inputs (review/gates-proof.test.ts.txt)
 * run against the real home directory and the real filesystem.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkCallContext } from "../engine/sdk-options.js";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import { createSandboxPathGuard } from "../sandbox/path-guard.js";
import { SandboxSpawnRegistry, type SandboxPolicySource } from "../sandbox/policy.js";
import { resolveSandboxPath } from "../sandbox/paths.js";
import { defaultApprovalPolicy, evaluateApprovalCall, type ApprovalEnvironment } from "./engine.js";
import { canonicalizeApprovalPath, normalizeApprovalPath } from "./paths.js";

const HOME = homedir();
const DATA = join(HOME, ".kirie");
const ctx: SdkCallContext = { kind: "chat", sessionKey: "telegram:dm:1", channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true, interactive: true, label: "chat telegram:dm", cwd: DATA };

function startupDiskAlias(): string | null {
  try {
    const p = "/Volumes/Macintosh HD";
    return lstatSync(p).isSymbolicLink() && readlinkSync(p) === "/" ? p : null;
  } catch {
    return null;
  }
}

function ask(tool: string, input: Record<string, unknown>, env: ApprovalEnvironment = { home: HOME, dataDir: DATA }, cwd = DATA) {
  return evaluateApprovalCall({ tool, input, cwd, ctx }, defaultApprovalPolicy({ mode: "ask" }), env);
}

describe("GATES-B3: the reviewer's [B3] lines (real home, real realpath)", () => {
  const alias = `/System/Volumes/Data${HOME}`;
  const calls: Array<[string, Record<string, unknown>]> = [
    ["Write", { file_path: `${alias}/.kirie/state/runtime-settings.json`, content: "{}" }],
    ["Write", { file_path: `${alias}/.kirie/config.yaml`, content: "x" }],
    ["Read", { file_path: `${alias}/.ssh/id_ed25519` }],
    ["Bash", { command: "cp /tmp/config.yaml ~/.kirie/" }],
    ["Bash", { command: "cp /tmp/config.yaml ." }],
    ["Bash", { command: "mv /tmp/.zshrc ~/" }],
    ["Bash", { command: "echo x >> \"${ZDOTDIR:-$HOME}/.zshrc\"" }],
    ["Bash", { command: "pkill -f apps/daemon" }],
  ];
  it.each(calls)("%s %j asks", (tool, input) => {
    const r = ask(tool, input);
    expect(r.decision, r.summary).toBe("ask");
  });

  const disk = startupDiskAlias();
  it.skipIf(disk === null)("the startup-disk alias under /Volumes asks", () => {
    expect(ask("Edit", { file_path: `${disk}${HOME}/.zshrc`, old_string: "a", new_string: "b" }).decision).toBe("ask");
    expect(ask("Bash", { command: `cat '${disk}${HOME}/.ssh/id_ed25519'` }).decision).toBe("ask");
  });

  it("the plain path still asks (control)", () => {
    expect(ask("Write", { file_path: `${HOME}/.kirie/state/runtime-settings.json`, content: "{}" }).decision).toBe("ask");
  });
});

describe("GATES-B3b: the native sandbox read guard through the aliases", () => {
  const disk = startupDiskAlias();
  it("denies Read through /System/Volumes/Data and the startup-disk alias", () => {
    const config = SandboxConfigSchema.parse({ mode: "native" });
    const source = {
      mode: () => "native", config: () => config, allowWrite: () => [], pathEnv: () => ({ home: HOME, dataDir: DATA }),
      workspaceDir: () => join(DATA, "sandbox-workspace"), dockerReadPaths: () => [], docker: () => ({ healthy: false, container: "x" }), generation: () => 0,
    } as unknown as SandboxPolicySource;
    const gate = createSandboxPathGuard({ source, spawns: new SandboxSpawnRegistry() });
    const check = (tool: string, input: Record<string, unknown>) => (gate.check({ tool, input, toolUseId: "t", cwd: DATA, ctx }) as { decision: string }).decision;
    expect(check("Read", { file_path: `${HOME}/.kirie/config.yaml` })).toBe("deny");
    expect(check("Read", { file_path: `/System/Volumes/Data${HOME}/.kirie/config.yaml` })).toBe("deny");
    expect(check("Read", { file_path: `/system/volumes/data${HOME}/.kirie/config.yaml` })).toBe("deny");
    expect(check("Write", { file_path: `/System/Volumes/Data${HOME}/.kirie/config.yaml`, content: "x" })).toBe("deny");
    if (disk) expect(check("Read", { file_path: `${disk}${HOME}/.ssh/id_ed25519` })).toBe("deny");
  });
});

describe("one canonical form for macOS path aliases", () => {
  const aliases = { volumeRootAliases: () => ["Macintosh HD"] };
  it("strips the data-volume firmlink and maps a /Volumes link to /", () => {
    expect(canonicalizeApprovalPath("/System/Volumes/Data/Users/t/.zshrc", aliases)).toBe("/Users/t/.zshrc");
    expect(canonicalizeApprovalPath("/SYSTEM/volumes/DATA/Users/t", aliases)).toBe("/Users/t");
    expect(canonicalizeApprovalPath("/System/Volumes/Data", aliases)).toBe("/");
    expect(canonicalizeApprovalPath("/Volumes/Macintosh HD/Users/t/.ssh/id_rsa", aliases)).toBe("/Users/t/.ssh/id_rsa");
    expect(canonicalizeApprovalPath("/volumes/macintosh hd", aliases)).toBe("/");
    expect(canonicalizeApprovalPath("/System/Volumes/Data/Volumes/Macintosh HD/etc/hosts", aliases)).toBe("/etc/hosts");
    expect(canonicalizeApprovalPath("/Volumes/Backup/Users/t", aliases)).toBe("/Volumes/Backup/Users/t");
    expect(canonicalizeApprovalPath("/System/Volumes/Database", aliases)).toBe("/System/Volumes/Database");
  });

  it("is used by both path modules", () => {
    const env = { home: "/Users/t", dataDir: "/Users/t/.kirie", realpath: (p: string) => p, ...aliases };
    expect(normalizeApprovalPath("/Volumes/Macintosh HD/Users/t/.kirie/config.yaml", "/", env).lexical).toBe("/Users/t/.kirie/config.yaml");
    expect(resolveSandboxPath("/System/Volumes/Data/Users/t/.kirie/config.yaml", "/", { ...env, realpath: (p: string) => { throw new Error(p); } }).lexical).toBe("/Users/t/.kirie/config.yaml");
  });

  it("hardline sees a home or root wipe through the aliases", () => {
    const env = { home: "/Users/t", dataDir: "/Users/t/.kirie", realpath: (p: string) => p, ...aliases };
    for (const command of ["rm -rf /System/Volumes/Data/Users/t", "rm -rf '/Volumes/Macintosh HD/Users/t'", "rm -rf '/Volumes/Macintosh HD'", "rm -rf /System/Volumes/Data"]) {
      const r = evaluateApprovalCall({ tool: "Bash", input: { command }, cwd: "/tmp", ctx }, defaultApprovalPolicy({ mode: "yolo" }), env);
      expect(r.decision, command).toBe("deny");
    }
  });

  it("APFS case folding: long s, upper case and decomposed forms match", () => {
    const env = { home: "/Users/t", dataDir: "/Users/t/.kirie", realpath: (p: string) => p };
    for (const file_path of ["/Users/t/.zſhrc", "/Users/t/.ZSHRC", "/Users/t/.kirie/UſER.md", "/Users/t/.npmrc".normalize("NFD"), "/USERS/T/.ssh/authorized_keys", "/Users/t/.KIRIE/CONFIG.YAML"]) {
      expect(ask("Write", { file_path, content: "x" }, env, "/tmp").decision, file_path).toBe("ask");
    }
  });
});

describe("cp, mv, ln, install, rsync into a directory", () => {
  let home: string;
  let env: ApprovalEnvironment;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "kirie-b3-"));
    mkdirSync(join(home, ".kirie", "state"), { recursive: true });
    mkdirSync(join(home, "project"), { recursive: true });
    env = { home, dataDir: join(home, ".kirie") };
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const bash = (command: string, cwd?: string) => ask("Bash", { command }, env, cwd ?? join(home, ".kirie"));

  it("checks dest/basename(source) when the destination is a directory", () => {
    for (const command of [
      "cp /tmp/config.yaml ~/.kirie",
      "cp /tmp/config.yaml ~/.kirie/",
      "cp /tmp/a /tmp/config.yaml ~/.kirie",
      "cp -t ~/.kirie /tmp/config.yaml",
      "mv /tmp/.zshrc ~",
      "mv -f /tmp/runtime-settings.json ~/.kirie/state",
      "ln -sf /tmp/config.yaml ~/.kirie/",
      "install -m 600 /tmp/config.yaml ~/.kirie/",
      "rsync /tmp/.zshrc ~/",
      "ditto /tmp/config.yaml ~/.kirie/",
      "cp /tmp/x/config.yaml ..",
    ]) {
      const cwd = command.endsWith("..") ? join(home, ".kirie", "state") : undefined;
      const r = bash(command, cwd);
      expect(r.decision, `${command}: ${r.summary}`).toBe("ask");
      expect(r.findings.map((f) => f.ruleId), command).toContain("fs.protected-write");
    }
  });

  it("a recursive copy or an extraction into an ancestor of a protected path is a protected write", () => {
    for (const [command, cwd] of [
      ["cp -r /tmp/stuff ~/.kirie", undefined],
      ["cp -a /tmp/stuff/. ~/", undefined],
      ["rsync -a /tmp/stuff/ ~/.kirie/", undefined],
      ["ditto /tmp/stuff ~/.kirie", undefined],
      ["tar xf /tmp/a.tar -C ~/.kirie", undefined],
      ["tar -xzf /tmp/a.tgz", undefined],
      ["unzip -o /tmp/a.zip", undefined],
      ["unzip /tmp/a.zip -d ~", undefined],
    ] as Array<[string, string | undefined]>) {
      const r = bash(command, cwd);
      expect(r.decision, `${command}: ${r.summary}`).toBe("ask");
    }
  });

  it("ordinary copies and extractions in a project folder do not ask", () => {
    const cwd = join(home, "project");
    for (const command of ["cp -r src dist", "cp a.txt b.txt", "mv build/ out/", "tar xf /tmp/a.tar", "unzip -o /tmp/a.zip", "rsync -a src/ /tmp/backup/", "cp /tmp/notes.txt ~/project/"]) {
      const r = bash(command, cwd);
      expect(r.decision, `${command}: ${r.summary}`).toBe("allow");
    }
  });
});

describe("sys.kill-kirie: kills aimed at the daemon", () => {
  const env: ApprovalEnvironment = { home: "/Users/t", dataDir: "/Users/t/.kirie", realpath: (p) => p, daemonCommandLine: "/opt/homebrew/bin/node /Users/t/dev/kirie/apps/daemon/dist/index.js" };
  const rules = (command: string) => ask("Bash", { command }, env, "/tmp").findings.map((f) => f.ruleId);

  it.each([
    "pkill -f apps/daemon",
    "pkill -f 'node.*index.js'",
    "pkill -f daemon/dist",
    "pkill nod",
    "kill $(pgrep -f apps/daemon)",
    "kill -9 `pgrep node`",
    "kill $(lsof -ti :18789)",
    "kill -TERM $(lsof -t -i tcp:18789)",
    "lsof -ti :18789 | xargs kill",
    "pgrep -f kirie | xargs kill -9",
    "pgrep -f apps/daemon | xargs -r kill",
    "launchctl kickstart -k gui/501/com.codingjet.kirie",
    "launchctl kickstart gui/501/com.codingjet.kirie",
    "launchctl stop com.codingjet.kirie",
    "launchctl bootout gui/501/com.codingjet.kirie",
    "launchctl bootout gui/501",
    "launchctl kill SIGKILL gui/501/com.codingjet.kirie",
  ])("flags %s", (command) => {
    expect(rules(command)).toContain("sys.kill-kirie");
  });

  it.each([
    "pkill -f 'sleep 100'",
    "kill 12345",
    "kill $(pgrep -f vite)",
    "lsof -ti :3000 | xargs kill",
    "pkill -f python",
    "launchctl list",
  ])("does not flag %s", (command) => {
    expect(rules(command)).not.toContain("sys.kill-kirie");
  });
});
