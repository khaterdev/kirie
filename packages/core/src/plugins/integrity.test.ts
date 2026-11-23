import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  hashDirectory,
  inspectPluginTree,
  listPluginDirectories,
  PluginIntegrityError,
  writePluginSnapshot,
} from "./integrity.js";
import { makePluginSandbox, writePlugin, type PluginSandbox } from "./fixture.test-util.js";

let sb: PluginSandbox;
beforeEach(() => { sb = makePluginSandbox(); });
afterEach(() => { sb.cleanup(); });

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof PluginIntegrityError ? err.code : `other:${String(err)}`;
  }
  return undefined;
}

describe("inspectPluginTree", () => {
  it("hashes a plugin tree; the hash is stable across runs", () => {
    writePlugin(sb.pluginsDir, "ok", { files: { "lib/a.js": "export const a = 1;\n" } });
    const a = inspectPluginTree(sb.pluginsDir, "ok");
    const b = inspectPluginTree(sb.pluginsDir, "ok");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(a.fileCount).toBe(3);
    expect(a.entries.map((e) => e.rel)).toEqual(["index.js", "lib/a.js", "package.json"]);
    expect(a.entries.every((e) => e.bytes === undefined)).toBe(true);
  });

  it("changes when any file changes, is added, or is renamed", () => {
    const dir = writePlugin(sb.pluginsDir, "ok", { files: { "lib/a.js": "1" } });
    const base = inspectPluginTree(sb.pluginsDir, "ok").sha256;
    writeFileSync(join(dir, "lib/a.js"), "2");
    const edited = inspectPluginTree(sb.pluginsDir, "ok").sha256;
    expect(edited).not.toBe(base);
    writeFileSync(join(dir, "lib/a.js"), "1");
    expect(inspectPluginTree(sb.pluginsDir, "ok").sha256).toBe(base);
    writeFileSync(join(dir, "extra.txt"), "");
    expect(inspectPluginTree(sb.pluginsDir, "ok").sha256).not.toBe(base);
  });

  it("is path-sensitive: moving a file with the same bytes changes the hash", () => {
    const dir = writePlugin(sb.pluginsDir, "p3", { files: { "a/b.js": "z" } });
    const h1 = inspectPluginTree(sb.pluginsDir, "p3").sha256;
    mkdirSync(join(dir, "c"), { mode: 0o755 });
    renameSync(join(dir, "a/b.js"), join(dir, "c/b.js"));
    expect(inspectPluginTree(sb.pluginsDir, "p3").sha256).not.toBe(h1);
  });

  it("rejects invalid names: traversal, absolute, uppercase, slash, empty", () => {
    for (const bad of ["../x", "/abs/path", "Upper", "a/b", "", ".", "..", "a..b", "-x"]) {
      expect(code(() => inspectPluginTree(sb.pluginsDir, bad))).toBe("invalid-name");
    }
  });

  it("a missing plugin directory is an error (no fallback anywhere)", () => {
    expect(code(() => inspectPluginTree(sb.pluginsDir, "lodash"))).toBe("missing");
  });

  it("a missing plugins directory is an error", () => {
    expect(code(() => inspectPluginTree(join(sb.dataDir, "nope"), "x"))).toBe("missing");
  });

  it("rejects a plugin directory that is a symlink", () => {
    const real = writePlugin(join(sb.dataDir), "elsewhere");
    symlinkSync(real, join(sb.pluginsDir, "linked"));
    expect(code(() => inspectPluginTree(sb.pluginsDir, "linked"))).toBe("symlink");
  });

  it("rejects a symlink pointing outside the tree, and a dangling one", () => {
    const dir = writePlugin(sb.pluginsDir, "s1");
    writeFileSync(join(sb.dataDir, "secret.txt"), "x");
    symlinkSync(join(sb.dataDir, "secret.txt"), join(dir, "leak.js"));
    expect(code(() => inspectPluginTree(sb.pluginsDir, "s1"))).toBe("symlink");

    const dir2 = writePlugin(sb.pluginsDir, "s2");
    symlinkSync("../../secret.txt", join(dir2, "rel.js"));
    expect(code(() => inspectPluginTree(sb.pluginsDir, "s2"))).toBe("symlink");

    const dir3 = writePlugin(sb.pluginsDir, "s3");
    symlinkSync("./does-not-exist", join(dir3, "dangling.js"));
    expect(code(() => inspectPluginTree(sb.pluginsDir, "s3"))).toBe("symlink");
  });

  it("rejects a link whose text climbs above the plugin root, even if it lands back inside", () => {
    const dir = writePlugin(sb.pluginsDir, "s5", { files: { "x.js": "1" } });
    symlinkSync("../s5/x.js", join(dir, "back-in.js"));
    expect(code(() => inspectPluginTree(sb.pluginsDir, "s5"))).toBe("symlink");
  });

  it("rejects a FIFO (never blocks on it)", () => {
    const dir = writePlugin(sb.pluginsDir, "fifo");
    execFileSync("mkfifo", [join(dir, "pipe.js")]);
    expect(code(() => inspectPluginTree(sb.pluginsDir, "fifo"))).toBe("special-file");
  });

  it("accepts a relative symlink inside the tree and hashes its target text", () => {
    const dir = writePlugin(sb.pluginsDir, "s4", { files: { "lib/real.js": "1" } });
    symlinkSync("lib/real.js", join(dir, "alias.js"));
    const snap = inspectPluginTree(sb.pluginsDir, "s4");
    expect(snap.entries.find((e) => e.rel === "alias.js")).toMatchObject({ kind: "symlink", target: "lib/real.js" });
  });

  it("rejects group- or world-writable files and directories", () => {
    const dir = writePlugin(sb.pluginsDir, "w1");
    chmodSync(join(dir, "index.js"), 0o666);
    expect(code(() => inspectPluginTree(sb.pluginsDir, "w1"))).toBe("permissions");
    chmodSync(join(dir, "index.js"), 0o644);
    chmodSync(dir, 0o775);
    expect(code(() => inspectPluginTree(sb.pluginsDir, "w1"))).toBe("permissions");
    chmodSync(dir, 0o755);
    chmodSync(sb.pluginsDir, 0o777);
    expect(code(() => inspectPluginTree(sb.pluginsDir, "w1"))).toBe("permissions");
    chmodSync(sb.pluginsDir, 0o700);
    expect(code(() => inspectPluginTree(sb.pluginsDir, "w1"))).toBeUndefined();
  });

  it("rejects files not owned by the current user", () => {
    writePlugin(sb.pluginsDir, "o1");
    const realUid = statSync(sb.pluginsDir).uid;
    expect(code(() => inspectPluginTree(sb.pluginsDir, "o1", { uid: realUid + 12345 }))).toBe("owner");
  });

  it("refuses trees with too many files or too many bytes", () => {
    writePlugin(sb.pluginsDir, "big", { files: { "a.txt": "x".repeat(2000), "b.txt": "y", "c.txt": "z" } });
    expect(code(() => inspectPluginTree(sb.pluginsDir, "big", { limits: { maxFiles: 3 } }))).toBe("too-many-files");
    expect(code(() => inspectPluginTree(sb.pluginsDir, "big", { limits: { maxBytes: 1000 } }))).toBe("too-large");
  });
});

describe("writePluginSnapshot", () => {
  it("writes the hashed bytes to <cache>/<name>/<sha> with private modes, and the copy hashes the same", () => {
    const dir = writePlugin(sb.pluginsDir, "c1", { files: { "lib/x.js": "x" } });
    symlinkSync("lib/x.js", join(dir, "alias.js"));
    const snap = inspectPluginTree(sb.pluginsDir, "c1", { keepContents: true });
    const dest = writePluginSnapshot(snap, sb.cacheDir);
    expect(dest).toBe(join(sb.cacheDir, "c1", snap.sha256));
    expect(hashDirectory(dest).sha256).toBe(snap.sha256);
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    expect(statSync(join(dest, "index.js")).mode & 0o777).toBe(0o600);
  });

  it("replaces a tampered copy, and removes copies of older versions", () => {
    const dir = writePlugin(sb.pluginsDir, "c2");
    const v1 = inspectPluginTree(sb.pluginsDir, "c2", { keepContents: true });
    const d1 = writePluginSnapshot(v1, sb.cacheDir);
    writeFileSync(join(d1, "index.js"), "export default () => { throw new Error('planted'); }");
    const again = writePluginSnapshot(v1, sb.cacheDir);
    expect(hashDirectory(again).sha256).toBe(v1.sha256);

    writeFileSync(join(dir, "index.js"), "// v2\n");
    const v2 = inspectPluginTree(sb.pluginsDir, "c2", { keepContents: true });
    writePluginSnapshot(v2, sb.cacheDir);
    expect(readdirSync(join(sb.cacheDir, "c2"))).toEqual([v2.sha256]);
  });

  it("needs a snapshot taken with keepContents", () => {
    writePlugin(sb.pluginsDir, "c3");
    const snap = inspectPluginTree(sb.pluginsDir, "c3");
    expect(() => writePluginSnapshot(snap, sb.cacheDir)).toThrow(/keepContents/);
  });
});

describe("listPluginDirectories", () => {
  it("lists directory names only, sorted, skipping dot entries; never loads", () => {
    writePlugin(sb.pluginsDir, "b");
    writePlugin(sb.pluginsDir, "a");
    writeFileSync(join(sb.pluginsDir, "file.txt"), "");
    mkdirSync(join(sb.pluginsDir, ".hidden"));
    expect(listPluginDirectories(sb.pluginsDir)).toEqual(["a", "b"]);
    expect(listPluginDirectories(join(sb.dataDir, "nope"))).toEqual([]);
  });
});
