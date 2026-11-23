/**
 * Plugin directory checks and the content hash (PLAN C.15).
 *
 * Before every load: the plugin directory is a real directory directly inside
 * the plugins directory (no symlink), everything in the tree is owned by the
 * current user and is not group- or world-writable, no symlink points outside
 * the tree, there are no special files, and the tree is at most 2000 files and
 * 50 MB. The hash is SHA-256 over every entry in path order.
 *
 * The hash pin is tamper-evident, not tamper-proof: anything running as the
 * same user (including the agent's shell) can change the files, and a change
 * between the check and the import cannot be ruled out. The loader narrows that
 * window by importing a verified private copy (see writePluginSnapshot).
 * Every file is opened without following links and checked with fstat, so a
 * file swapped for a link, a FIFO or a device after the walk is refused.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import { isValidPluginName } from "./types.js";

export const PLUGIN_MAX_FILES = 2000;
export const PLUGIN_MAX_BYTES = 50 * 1024 * 1024;

export interface PluginTreeLimits {
  maxFiles: number;
  maxBytes: number;
}

export type PluginIntegrityCode =
  | "invalid-name"
  | "missing"
  | "not-directory"
  | "symlink"
  | "outside"
  | "owner"
  | "permissions"
  | "special-file"
  | "too-many-files"
  | "too-large"
  | "unreadable";

export class PluginIntegrityError extends Error {
  constructor(readonly code: PluginIntegrityCode, message: string) {
    super(message);
    this.name = "PluginIntegrityError";
  }
}

export interface PluginTreeEntry {
  /** Relative path with "/" separators */
  rel: string;
  kind: "file" | "symlink";
  size: number;
  /** File contents, kept only when requested */
  bytes?: Buffer;
  /** Symlink target as stored in the link */
  target?: string;
}

export interface PluginTreeSnapshot {
  name: string;
  /** Real path of the plugin directory */
  dir: string;
  sha256: string;
  fileCount: number;
  totalBytes: number;
  entries: PluginTreeEntry[];
}

export interface InspectOptions {
  limits?: Partial<PluginTreeLimits>;
  /** Keep file contents in the snapshot (needed to write a private copy) */
  keepContents?: boolean;
  /** Override for tests. Default process.getuid(); undefined skips ownership checks (non-POSIX) */
  uid?: number | null;
}

function currentUid(opt: number | null | undefined): number | null {
  if (opt !== undefined) return opt;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function checkOwnerAndMode(st: Stats, where: string, uid: number | null): void {
  if (uid !== null && st.uid !== uid) {
    throw new PluginIntegrityError("owner", `${where} is not owned by the current user`);
  }
  if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) {
    throw new PluginIntegrityError("permissions", `${where} is group- or world-writable`);
  }
}

function lstatOrMissing(path: string, what: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw new PluginIntegrityError("missing", `${what} does not exist`);
  }
}

/** Real path of the plugins directory after its own owner and mode checks. */
export function resolvePluginsRoot(pluginsDir: string, uid?: number | null): string {
  let real: string;
  try {
    real = realpathSync(pluginsDir);
  } catch {
    throw new PluginIntegrityError("missing", "the plugins directory does not exist");
  }
  const st = lstatSync(real);
  if (!st.isDirectory()) throw new PluginIntegrityError("not-directory", "the plugins path is not a directory");
  checkOwnerAndMode(st, "the plugins directory", currentUid(uid));
  return real;
}

/**
 * Walk and hash `<pluginsDir>/<name>`. Throws PluginIntegrityError on any
 * failed check. Never follows a symlink out of the tree and never executes anything.
 */
export function inspectPluginTree(pluginsDir: string, name: string, opts: InspectOptions = {}): PluginTreeSnapshot {
  if (!isValidPluginName(name)) {
    throw new PluginIntegrityError("invalid-name", `"${name}" is not a valid plugin name`);
  }
  const uid = currentUid(opts.uid);
  const root = resolvePluginsRoot(pluginsDir, uid);
  const dir = join(root, name);
  const st = lstatOrMissing(dir, `plugin directory "${name}"`);
  if (st.isSymbolicLink()) throw new PluginIntegrityError("symlink", `plugin directory "${name}" is a symlink`);
  if (!st.isDirectory()) throw new PluginIntegrityError("not-directory", `plugin "${name}" is not a directory`);
  checkOwnerAndMode(st, `plugin directory "${name}"`, uid);
  if (realpathSync(dir) !== dir || dirname(dir) !== root) {
    throw new PluginIntegrityError("outside", `plugin directory "${name}" resolves outside the plugins directory`);
  }
  return walkTree(dir, name, uid, opts);
}

/** Hash an arbitrary directory with the same algorithm (used to verify a private copy). */
export function hashDirectory(dir: string, opts: InspectOptions = {}): PluginTreeSnapshot {
  const real = realpathSync(dir);
  return walkTree(real, "", currentUid(opts.uid), opts);
}

function walkTree(dir: string, name: string, uid: number | null, opts: InspectOptions): PluginTreeSnapshot {
  const limits: PluginTreeLimits = {
    maxFiles: opts.limits?.maxFiles ?? PLUGIN_MAX_FILES,
    maxBytes: opts.limits?.maxBytes ?? PLUGIN_MAX_BYTES,
  };
  const entries: PluginTreeEntry[] = [];
  let totalBytes = 0;

  const visit = (abs: string): void => {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      throw new PluginIntegrityError("unreadable", `cannot read ${relOf(dir, abs) || "the plugin directory"}`);
    }
    names.sort();
    for (const entryName of names) {
      const full = join(abs, entryName);
      const rel = relOf(dir, full);
      const st = lstatSync(full);
      checkOwnerAndMode(st, rel, uid);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(full);
        let resolved: string;
        try {
          resolved = realpathSync(full);
        } catch {
          throw new PluginIntegrityError("symlink", `${rel} is a dangling symlink`);
        }
        // The final target must be inside, and the link text itself must never
        // climb above the plugin root at any step, so the same link means the
        // same thing in the private copy (whose root has another name).
        if (!isInside(dir, resolved) || isAbsolute(target) || !linkStaysInside(relOf(dir, dirname(full)), target)) {
          throw new PluginIntegrityError("symlink", `${rel} points outside the plugin directory`);
        }
        pushEntry({ rel, kind: "symlink", size: 0, target });
        continue;
      }
      if (st.isDirectory()) {
        visit(full);
        continue;
      }
      if (!st.isFile()) {
        throw new PluginIntegrityError("special-file", `${rel} is not a regular file`);
      }
      if (totalBytes + st.size > limits.maxBytes) {
        throw new PluginIntegrityError("too-large", `the plugin is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
      }
      const bytes = readRegularFile(full, rel, uid, Math.min(st.size, limits.maxBytes - totalBytes));
      totalBytes += bytes.length;
      if (totalBytes > limits.maxBytes) {
        throw new PluginIntegrityError("too-large", `the plugin is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`);
      }
      pushEntry({ rel, kind: "file", size: bytes.length, bytes });
    }
  };

  const pushEntry = (e: PluginTreeEntry): void => {
    if (entries.length >= limits.maxFiles) {
      throw new PluginIntegrityError("too-many-files", `the plugin has more than ${limits.maxFiles} files`);
    }
    entries.push(e);
  };

  visit(dir);
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash("sha256");
  hash.update("kirie-plugin-tree-v1\0");
  for (const e of entries) {
    if (e.kind === "file") {
      hash.update(`F\0${e.rel}\0${e.size}\0`);
      hash.update(e.bytes!);
      hash.update("\0");
    } else {
      hash.update(`L\0${e.rel}\0${e.target}\0`);
    }
  }
  const sha256 = hash.digest("hex");
  if (!opts.keepContents) {
    for (const e of entries) delete e.bytes;
  }
  return { name, dir, sha256, fileCount: entries.length, totalBytes, entries };
}

/**
 * Read a file without following a symlink and without blocking on a FIFO, and
 * check what was actually opened: a regular file, still ours, no bigger than
 * `maxSize`. A file swapped between the directory walk and the read is refused.
 */
function readRegularFile(path: string, rel: string, uid: number | null, maxSize: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    throw new PluginIntegrityError("unreadable", `cannot read ${rel} (it changed or is a link)`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new PluginIntegrityError("special-file", `${rel} is not a regular file`);
    checkOwnerAndMode(st, rel, uid);
    if (st.size > maxSize) {
      throw new PluginIntegrityError("too-large", `${rel} grew while it was being checked, or the plugin is too large`);
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? buf : buf.subarray(0, off);
  } catch (err) {
    if (err instanceof PluginIntegrityError) throw err;
    throw new PluginIntegrityError("unreadable", `cannot read ${rel}`);
  } finally {
    closeSync(fd);
  }
}

/** True when following `target` from directory `relParent` (relative to the root) never goes above the root. */
function linkStaysInside(relParent: string, target: string): boolean {
  const stack = relParent === "" ? [] : relParent.split("/");
  for (const part of target.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return false;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return true;
}

function relOf(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function isInside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * Write the exact bytes that were hashed to `<cacheDir>/<name>/<sha256>/`
 * (directories 0700, files 0600) and return that path. An existing copy is
 * reused only when it hashes to the same value; otherwise it is replaced.
 * Older copies of the same plugin are removed. Importing from this path means
 * the plugin's own files that run are the ones that were hashed, and an edited
 * file always gets a fresh module URL (Node caches modules by URL for the life
 * of the process). A bare import missing from the plugin's own node_modules can
 * still resolve to a parent directory's node_modules, outside the hash.
 */
export function writePluginSnapshot(snapshot: PluginTreeSnapshot, cacheDir: string): string {
  if (!isValidPluginName(snapshot.name)) throw new PluginIntegrityError("invalid-name", "invalid plugin name");
  if (snapshot.entries.some((e) => e.kind === "file" && !e.bytes)) {
    throw new Error("snapshot was taken without keepContents");
  }
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const pluginCache = join(cacheDir, snapshot.name);
  mkdirSync(pluginCache, { recursive: true, mode: 0o700 });
  chmodSync(pluginCache, 0o700);
  const dest = join(pluginCache, snapshot.sha256);

  let reuse = false;
  try {
    const st = lstatSync(dest);
    if (st.isDirectory() && hashDirectory(dest).sha256 === snapshot.sha256) reuse = true;
  } catch {
    reuse = false;
  }

  if (!reuse) {
    rmSync(dest, { recursive: true, force: true });
    const tmp = join(pluginCache, `.tmp-${randomBytes(6).toString("hex")}`);
    mkdirSync(tmp, { mode: 0o700 });
    try {
      for (const e of snapshot.entries) {
        const target = join(tmp, ...e.rel.split("/"));
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        if (e.kind === "file") {
          writeFileSync(target, e.bytes!, { mode: 0o600 });
        } else {
          symlinkSync(e.target!, target);
        }
      }
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    const check = hashDirectory(dest);
    if (check.sha256 !== snapshot.sha256) {
      rmSync(dest, { recursive: true, force: true });
      throw new PluginIntegrityError("unreadable", "the private copy of the plugin does not match its hash");
    }
  }

  for (const other of readdirSync(pluginCache)) {
    if (other !== snapshot.sha256) rmSync(join(pluginCache, other), { recursive: true, force: true });
  }
  return dest;
}

/** List the names of directories under the plugins directory. For listing only; never loads anything. */
export function listPluginDirectories(pluginsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(pluginsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith("."))
    .filter((n) => {
      try {
        const st = lstatSync(join(pluginsDir, n));
        return st.isDirectory() || st.isSymbolicLink();
      } catch {
        return false;
      }
    })
    .sort();
}
