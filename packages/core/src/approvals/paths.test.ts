import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVALS_PROTECTED_READ_PATHS,
  APPROVALS_PROTECTED_WRITE_PATHS,
  approvalPathIsAncestorOf,
  approvalPathMatches,
  compileApprovalPathList,
  expandApprovalHome,
  isApprovalRawDevice,
  isApprovalRootTarget,
  isApprovalSystemPath,
  normalizeApprovalPath,
} from "./paths.js";
import { matchApprovalGlob, matchApprovalPathGlob } from "./glob.js";

const HOME = "/Users/tester";
const ident = { home: HOME, realpath: (p: string) => p };

describe("glob matchers", () => {
  it("matches shell globs with * and ?", () => {
    expect(matchApprovalGlob("git push --force*", "git push --force origin main")).toBe(true);
    expect(matchApprovalGlob("git status*", "git status && rm -rf ~")).toBe(true);
    expect(matchApprovalGlob("ls ?", "ls a")).toBe(true);
    expect(matchApprovalGlob("ls ?", "ls ab")).toBe(false);
    expect(matchApprovalGlob("pnpm *", "npm i")).toBe(false);
    expect(matchApprovalGlob("*", "")).toBe(true);
  });

  it("is linear on adversarial input", { timeout: 5_000 }, () => {
    const start = performance.now();
    expect(matchApprovalGlob(`${"*a".repeat(100)}b`, "a".repeat(50_000))).toBe(false);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("matches path globs with **, * and case-insensitively", () => {
    expect(matchApprovalPathGlob("/Users/tester/.ssh/**", "/Users/tester/.ssh/id_rsa")).toBe(true);
    expect(matchApprovalPathGlob("/Users/tester/.ssh/**", "/users/TESTER/.SSH/config")).toBe(true);
    expect(matchApprovalPathGlob("/Users/tester/.ssh/id_*", "/Users/tester/.ssh/sub/id_rsa")).toBe(false);
    expect(matchApprovalPathGlob("**/.env", "/a/b/c/.env")).toBe(true);
    expect(matchApprovalPathGlob("**/.env.*", "/a/.env.local")).toBe(true);
    expect(matchApprovalPathGlob("**/.env", "/a/.envrc")).toBe(false);
  });
});

describe("expandApprovalHome", () => {
  it("expands ~, ~/x, $HOME, ${HOME} and ~user", () => {
    expect(expandApprovalHome("~", HOME)).toBe(HOME);
    expect(expandApprovalHome("~/x", HOME)).toBe(`${HOME}/x`);
    expect(expandApprovalHome("$HOME/x", HOME)).toBe(`${HOME}/x`);
    expect(expandApprovalHome("${HOME}/x", HOME)).toBe(`${HOME}/x`);
    expect(expandApprovalHome("~tester/x", HOME)).toBe(`${HOME}/x`);
    expect(expandApprovalHome("~other/x", HOME)).toBe("/Users/other/x");
    expect(expandApprovalHome("$HOMEBREW/x", HOME)).toBe("$HOMEBREW/x");
  });
});

describe("normalizeApprovalPath", () => {
  it("never resolves symlinks under network mount points", () => {
    const realpath = (p: string) => { if (p.startsWith("/Volumes")) throw new Error("must not be called"); return p; };
    expect(normalizeApprovalPath("/Volumes/nas/x", "/", { home: HOME, realpath }).real).toBe("/Volumes/nas/x");
  });

  it("resolves relative paths and .. against cwd", () => {
    expect(normalizeApprovalPath("x", "/a/b", ident).lexical).toBe("/a/b/x");
    expect(normalizeApprovalPath("../../.ssh/id_rsa", `${HOME}/dev/x`, ident).lexical).toBe(`${HOME}/.ssh/id_rsa`);
    expect(normalizeApprovalPath("/a//b/./c/", "/", ident).lexical).toBe("/a/b/c");
    expect(normalizeApprovalPath("~/.ssh/../.ssh/id_rsa", "/", ident).lexical).toBe(`${HOME}/.ssh/id_rsa`);
  });

  describe("with real symlinks in a temp dir", () => {
    let root: string;
    beforeAll(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-apr-paths-")));
      mkdirSync(join(root, "home", ".ssh"), { recursive: true });
      writeFileSync(join(root, "home", ".ssh", "id_ed25519"), "synthetic");
      symlinkSync(join(root, "home", ".ssh"), join(root, "innocent"));
      symlinkSync(join(root, "home", ".ssh", "id_ed25519"), join(root, "notes.txt"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("a symlink into ~/.ssh is caught through its real path", () => {
      const env = { home: join(root, "home") };
      const read = compileApprovalPathList(APPROVALS_PROTECTED_READ_PATHS, env);
      const viaDir = normalizeApprovalPath("innocent/id_ed25519", root, env);
      expect(viaDir.lexical).toBe(join(root, "innocent", "id_ed25519"));
      expect(viaDir.real).toBe(join(root, "home", ".ssh", "id_ed25519"));
      expect(approvalPathMatches(viaDir, read)).toBe(true);
      expect(approvalPathMatches(normalizeApprovalPath("notes.txt", root, env), read)).toBe(true);
    });

    it("a non-existent leaf under a symlinked dir resolves through the deepest existing ancestor", () => {
      const env = { home: join(root, "home") };
      const write = compileApprovalPathList(APPROVALS_PROTECTED_WRITE_PATHS, env);
      const n = normalizeApprovalPath("innocent/new/authorized_keys", root, env);
      expect(n.real).toBe(join(root, "home", ".ssh", "new", "authorized_keys"));
      expect(approvalPathMatches(n, write)).toBe(true);
    });
  });
});

describe("protected lists", () => {
  const write = compileApprovalPathList(APPROVALS_PROTECTED_WRITE_PATHS, ident);
  const read = compileApprovalPathList(APPROVALS_PROTECTED_READ_PATHS, ident);
  const n = (p: string) => normalizeApprovalPath(p, `${HOME}/.kirie`, ident);

  it("include Kirie's own control files and stores (E.5)", () => {
    for (const p of [
      "~/.kirie/state/runtime-settings.json", "~/.kirie/state/plugin-approvals.json", "~/.kirie/logs/audit.jsonl",
      "~/.kirie/learning.db", "~/.kirie/learning.db-wal", "~/.kirie/accounts.db", "~/.kirie/webhooks.db",
      "~/.kirie/plugins/x/index.js", "~/.kirie/.claude/skills/x/SKILL.md", "~/.kirie/secrets/voice.env",
      "~/.kirie/credentials/store", "~/.kirie/config.yaml", "~/.kirie/USER.md", "~/.zshrc", "~/.bashrc",
      "~/Library/LaunchAgents/x.plist", "~/.claude/settings.json", "~/.ssh/authorized_keys", "/etc/hosts",
    ]) {
      expect(approvalPathMatches(n(p), write), p).toBe(true);
    }
  });

  it("protect every feature state store and tamper-evident file the plan defines (one test per path)", () => {
    const paths = [
      "~/.kirie/plugins/my-plugin/index.js", "~/.kirie/plugins/my-plugin/plugin.json",
      "~/.kirie/state/plugin-approvals.json", "~/.kirie/state/plugin-approvals.json.tmp",
      "~/.kirie/state/plugin-cache/abc/file", "~/.kirie/state/runtime-settings.json",
      "~/.kirie/state/runtime-settings.json.corrupt-1700000000", "~/.kirie/logs/audit.jsonl", "~/.kirie/logs/audit.jsonl.1",
      "~/.kirie/goals.db", "~/.kirie/goals.db-wal", "~/.kirie/goals.db-shm", "~/.kirie/learning.db", "~/.kirie/learning.db-wal",
      "~/.kirie/accounts.db", "~/.kirie/accounts.db-journal", "~/.kirie/checkpoints.db", "~/.kirie/webhooks.db",
      "~/.kirie/loops.db", "~/.kirie/loops.db-wal",
    ];
    for (const p of paths) expect(approvalPathMatches(n(p), write), p).toBe(true);
    // Not over-broad: ordinary files next to them stay writable.
    for (const p of ["~/.kirie/workspace/notes.md", "~/.kirie/logs/daemon.log", "~/.kirie/media/x.png"]) {
      expect(approvalPathMatches(n(p), write), p).toBe(false);
    }
  });

  it("are case-insensitive", () => {
    expect(approvalPathMatches(n("~/.SSH/ID_RSA"), read)).toBe(true);
    expect(approvalPathMatches(n("~/.Kirie/Config.YAML"), write)).toBe(true);
  });

  it("exclude public keys and known_hosts from reads", () => {
    expect(approvalPathMatches(n("~/.ssh/id_ed25519"), read)).toBe(true);
    expect(approvalPathMatches(n("~/.ssh/id_ed25519.pub"), read)).toBe(false);
    expect(approvalPathMatches(n("~/.ssh/known_hosts"), read)).toBe(false);
  });

  it("know which directories hold protected files", () => {
    expect(approvalPathIsAncestorOf(n("~"), read)).toBe(true);
    expect(approvalPathIsAncestorOf(n("/"), read)).toBe(true);
    expect(approvalPathIsAncestorOf(n("~/.kirie"), read)).toBe(true);
    expect(approvalPathIsAncestorOf(n("~/dev/project"), read)).toBe(false);
  });

  it("honour {kirie} pointing elsewhere", () => {
    const custom = compileApprovalPathList(APPROVALS_PROTECTED_WRITE_PATHS, { ...ident, dataDir: "/srv/kirie" });
    expect(approvalPathMatches(normalizeApprovalPath("/srv/kirie/config.yaml", "/", ident), custom)).toBe(true);
  });
});

describe("targets", () => {
  it("root targets", () => {
    for (const p of ["/", HOME, "/Users", "/System", "/usr", "/etc", "/private/var"]) {
      expect(isApprovalRootTarget(normalizeApprovalPath(p, "/", ident), ident), p).toBe(true);
    }
    for (const p of [`${HOME}/dev`, "/usr/local", "/tmp/x"]) {
      expect(isApprovalRootTarget(normalizeApprovalPath(p, "/", ident), ident), p).toBe(false);
    }
  });

  it("system paths exclude /usr/local", () => {
    expect(isApprovalSystemPath(normalizeApprovalPath("/usr/bin/x", "/", ident))).toBe(true);
    expect(isApprovalSystemPath(normalizeApprovalPath("/usr/local/bin/x", "/", ident))).toBe(false);
  });

  it("raw devices", () => {
    expect(isApprovalRawDevice("/dev/disk2")).toBe(true);
    expect(isApprovalRawDevice("/dev/rdisk0s1")).toBe(true);
    expect(isApprovalRawDevice("/dev/null")).toBe(false);
    expect(isApprovalRawDevice("/dev/disk")).toBe(false);
  });
});
