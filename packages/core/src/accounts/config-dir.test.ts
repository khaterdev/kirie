import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AccountPathError,
  carryTranscript,
  checkLogin,
  discoverConfigDirs,
  keychainServiceName,
  maskEmail,
  normalizeConfigDirPath,
  readAccountIdentity,
  sameProjects,
  validateConfigDir,
} from "./config-dir.js";

const SID = "11111111-2222-3333-4444-555555555555";

function writeIdentity(file: string, uuid: string, email = "someone@example.invalid", extra: Record<string, unknown> = {}): void {
  writeFileSync(
    file,
    JSON.stringify({
      numStartups: 3,
      projects: { "/x": { trusted: true } },
      oauthAccount: { accountUuid: uuid, emailAddress: email, organizationType: "claude_max", displayName: "Someone", ...extra },
    }),
  );
}

describe("config dirs", () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-cfgdir-")));
    home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeIdentity(join(home, ".claude.json"), "uuid-main");
    mkdirSync(join(home, ".claude2"));
    writeIdentity(join(home, ".claude2", ".claude.json"), "uuid-two", "second@example.invalid");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("normalizeConfigDirPath", () => {
    it("expands ~, resolves and strips trailing slashes", () => {
      expect(normalizeConfigDirPath("~/.claude2/", home)).toBe(join(home, ".claude2"));
      expect(normalizeConfigDirPath(`${home}/.claude2///`, home)).toBe(join(home, ".claude2"));
      expect(normalizeConfigDirPath(`${home}/x/../.claude2`, home)).toBe(join(home, ".claude2"));
    });

    it("rejects relative and empty paths", () => {
      expect(() => normalizeConfigDirPath(".claude2", home)).toThrow(AccountPathError);
      expect(() => normalizeConfigDirPath("  ", home)).toThrow(AccountPathError);
    });
  });

  describe("validateConfigDir", () => {
    it("a path that resolves to ~/.claude becomes the default account (variable unset)", () => {
      const v = validateConfigDir("~/.claude/", { home });
      expect(v.kind).toBe("default");
      expect(v.configDir).toBeNull();
      expect(v.identityFile).toBe(join(home, ".claude.json"));
    });

    it("a ~/.claudeN path is a config_dir account with its own identity file", () => {
      const v = validateConfigDir("~/.claude2/", { home });
      expect(v).toMatchObject({ kind: "config_dir", configDir: join(home, ".claude2"), identityFile: join(home, ".claude2", ".claude.json") });
    });

    it("rejects a missing path and a non-directory", () => {
      expect(() => validateConfigDir("~/.claude9", { home })).toThrow(/does not exist/);
      writeFileSync(join(home, "file"), "x");
      expect(() => validateConfigDir("~/file", { home })).toThrow(/not a directory/);
    });

    it("rejects a group- or world-writable dir", () => {
      chmodSync(join(home, ".claude2"), 0o777);
      expect(() => validateConfigDir("~/.claude2", { home })).toThrow(/writable/);
    });

    it("rejects a dir owned by another user", () => {
      const uid = statSync(join(home, ".claude2")).uid + 1;
      expect(() => validateConfigDir("~/.claude2", { home, uid })).toThrow(/not owned/);
    });

    it("rejects a dir outside the import roots", () => {
      const outside = join(root, "elsewhere");
      mkdirSync(outside);
      expect(() => validateConfigDir(outside, { home })).toThrow(/outside/);
      expect(validateConfigDir(outside, { home, importRoots: [root] }).configDir).toBe(outside);
    });
  });

  describe("readAccountIdentity", () => {
    it("reads only the uuid, the masked email and the organization type", () => {
      const r = readAccountIdentity(join(home, ".claude2", ".claude.json"));
      expect(r).toEqual({ ok: true, identity: { accountUuid: "uuid-two", label: "se***@example.invalid", organizationType: "claude_max" } });
    });

    it("reports missing, unreadable and logged-out files", () => {
      expect(readAccountIdentity(join(home, "nope.json"))).toEqual({ ok: false, reason: "missing" });
      writeFileSync(join(home, "half.json"), '{"oauthAcc');
      expect(readAccountIdentity(join(home, "half.json"))).toEqual({ ok: false, reason: "unreadable" });
      writeFileSync(join(home, "out.json"), JSON.stringify({ numStartups: 1 }));
      expect(readAccountIdentity(join(home, "out.json"))).toEqual({ ok: false, reason: "not_logged_in" });
    });
  });

  it("maskEmail keeps two characters and the domain", () => {
    expect(maskEmail("mostly@example.invalid")).toBe("mo***@example.invalid");
    expect(maskEmail("a@b.invalid")).toBe("a***@b.invalid");
    expect(maskEmail("no-at-sign")).toBe("***");
  });

  describe("login check", () => {
    it("uses the CLI's Keychain service names: no suffix when unset, sha256(dir)[:8] otherwise", () => {
      const dir = "/Users/someone/.claude2";
      const suffix = createHash("sha256").update(dir).digest("hex").slice(0, 8);
      expect(keychainServiceName(null)).toBe("Claude Code-credentials");
      expect(keychainServiceName(dir)).toBe(`Claude Code-credentials-${suffix}`);
      // A trailing slash is a different string and so a different (empty) login.
      expect(keychainServiceName(`${dir}/`)).not.toBe(keychainServiceName(dir));
    });

    it("runs security with -s only (never -w or -g) and uses the exit code", () => {
      const run = vi.fn(() => 0);
      const dir = join(home, ".claude2");
      expect(checkLogin(dir, { home, platform: "darwin", runSecurity: run })).toBe("logged_in");
      expect(run).toHaveBeenCalledWith(["find-generic-password", "-s", keychainServiceName(dir)]);
      const args = (run.mock.calls[0] as unknown as [string[]])[0];
      expect(args).not.toContain("-w");
      expect(args).not.toContain("-g");
      run.mockReturnValue(44);
      expect(checkLogin(dir, { home, platform: "darwin", runSecurity: run })).toBe("not_found");
    });

    it("counts a .credentials.json by existence only, and is unknown off macOS", () => {
      const run = vi.fn(() => 1);
      writeFileSync(join(home, ".claude2", ".credentials.json"), "{}");
      expect(checkLogin(join(home, ".claude2"), { home, platform: "darwin", runSecurity: run })).toBe("logged_in");
      expect(run).not.toHaveBeenCalled();
      expect(checkLogin(null, { home, platform: "linux", runSecurity: run })).toBe("unknown");
    });
  });

  it("discover lists ~/.claude and ~/.claudeN dirs, not ~/.claude.json, with identity and login", () => {
    mkdirSync(join(home, ".claude10"));
    mkdirSync(join(home, ".claudex"));
    const run = vi.fn(() => 0);
    const found = discoverConfigDirs({ home, platform: "darwin", runSecurity: run });
    expect(found.map((d) => [d.path, d.kind, d.suggestedId])).toEqual([
      [join(home, ".claude"), "default", "main"],
      [join(home, ".claude2"), "config_dir", "claude2"],
      [join(home, ".claude10"), "config_dir", "claude10"],
    ]);
    expect(found[0]!.identity.ok).toBe(true);
    expect(found[2]!.identity).toEqual({ ok: false, reason: "missing" });
    expect(found.every((d) => d.login === "logged_in")).toBe(true);
  });

  describe("transcripts", () => {
    function transcript(dataDir: string, text: string): string {
      const dir = join(dataDir, "projects", "-tmp-work");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${SID}.jsonl`);
      writeFileSync(file, text);
      return file;
    }

    it("sameProjects is true for the symlinked layout and false otherwise", () => {
      const a = join(home, ".claude");
      mkdirSync(join(a, "projects"));
      const b = join(home, ".claude2");
      symlinkSync(join(a, "projects"), join(b, "projects"));
      expect(sameProjects(a, b)).toBe(true);
      const c = join(home, ".claude3");
      mkdirSync(join(c, "projects"), { recursive: true });
      expect(sameProjects(a, c)).toBe(false);
    });

    it("carry is a no-op when both dirs share projects/", () => {
      const a = join(home, ".claude");
      transcript(a, "line1\n");
      symlinkSync(join(a, "projects"), join(home, ".claude2", "projects"));
      expect(carryTranscript(a, join(home, ".claude2"), SID)).toEqual({ status: "same" });
    });

    it("copies the jsonl (0600) and the sidecar dir when the layouts differ", () => {
      const a = join(home, ".claude");
      transcript(a, "line1\nline2\n");
      mkdirSync(join(a, "projects", "-tmp-work", SID, "tool-results"), { recursive: true });
      writeFileSync(join(a, "projects", "-tmp-work", SID, "tool-results", "r.txt"), "r");
      const b = join(home, ".claude2");
      expect(carryTranscript(a, b, SID)).toEqual({ status: "copied" });
      const copied = join(b, "projects", "-tmp-work", `${SID}.jsonl`);
      expect(readFileSync(copied, "utf8")).toBe("line1\nline2\n");
      expect(statSync(copied).mode & 0o777).toBe(0o600);
      expect(existsSync(join(b, "projects", "-tmp-work", SID, "tool-results", "r.txt"))).toBe(true);
    });

    it("replaces an older copy (a prefix) but never a diverged one", () => {
      const a = join(home, ".claude");
      transcript(a, "line1\nline2\n");
      const b = join(home, ".claude2");
      const older = transcript(b, "line1\n");
      expect(carryTranscript(a, b, SID).status).toBe("copied");
      expect(readFileSync(older, "utf8")).toBe("line1\nline2\n");
      writeFileSync(older, "line1\nother\n");
      expect(carryTranscript(a, b, SID).status).toBe("diverged");
      expect(readFileSync(older, "utf8")).toBe("line1\nother\n");
    });

    it("reports a missing source and refuses a non-uuid session id", () => {
      expect(carryTranscript(join(home, ".claude"), join(home, ".claude2"), SID).status).toBe("missing");
      expect(carryTranscript(join(home, ".claude"), join(home, ".claude2"), "../../etc").status).toBe("failed");
    });
  });
});
