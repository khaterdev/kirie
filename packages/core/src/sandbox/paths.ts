/**
 * Path handling for the sandbox (PLAN C.10): resolving a path the way the
 * kernel will (symlinks first, then `..`), containment checks, the mounts that
 * are never allowed, and turning the approval gate's protected-path patterns
 * into the plain absolute paths the SDK's native sandbox takes (EXPERIMENTS E6).
 */

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  APPROVALS_PROTECTED_READ_PATHS,
  APPROVALS_PROTECTED_WRITE_PATHS,
  approvalPathIsAncestorOf,
  approvalPathMatches,
  compileApprovalPathList,
  expandApprovalHome,
  expandApprovalPattern,
  isApprovalRootTarget,
  type ApprovalPathEnv,
  type ApprovalPathList,
  type NormalizedApprovalPath,
} from "../approvals/paths.js";
import { hasGlobChars, matchApprovalGlob } from "../approvals/glob.js";

export interface SandboxPathEnv {
  home: string;
  /** Kirie's data directory (`{kirie}` in patterns). */
  dataDir: string;
  /** Resolve symlinks of an existing path; must throw for a missing one. Default `fs.realpathSync.native`. */
  realpath?: (p: string) => string;
  /** Directory listing (names only). Default `fs.readdirSync`. */
  readdir?: (dir: string) => string[];
  /** The agent's working directory (where the SDK loads project settings from). Default: the data directory. */
  agentCwd?: string;
}

/**
 * Additions to the approval gate's protected lists that only the sandbox
 * enforces (W3-SBX review): code Kirie or launchd runs later must not be
 * plantable, and folders whose names or contents carry secrets must not be
 * listable from a sandboxed shell.
 */
export const SANDBOX_EXTRA_PROTECTED_WRITE_PATHS: readonly string[] = [
  "{kirie}/scripts/**",
  "{kirie}/node_modules/**",
  "{kirie}/kokoro-daemon/**",
  "{kirie}/telegram-bot-api/**",
  "{kirie}/backups/**",
  "{kirie}/*.py",
  "{kirie}/*.js",
  "{kirie}/*.mjs",
  "{kirie}/*.cjs",
  "{kirie}/config.yaml*",
  "{kirie}/.claude/**",
];
export const SANDBOX_EXTRA_PROTECTED_READ_PATHS: readonly string[] = [
  "{kirie}/config.yaml*",
  "{kirie}/backups/**",
  "{kirie}/state/**",
  "{kirie}/telegram-bot-api/**",
];

/** What the sandbox treats as protected for writes and reads. */
export const SANDBOX_PROTECTED_WRITE_PATHS: readonly string[] = [...APPROVALS_PROTECTED_WRITE_PATHS, ...SANDBOX_EXTRA_PROTECTED_WRITE_PATHS];
export const SANDBOX_PROTECTED_READ_PATHS: readonly string[] = [...APPROVALS_PROTECTED_READ_PATHS, ...SANDBOX_EXTRA_PROTECTED_READ_PATHS];

const MAX_SEGMENTS = 256;
/** Mount points where a stalled network volume could block a realpath call (as in approvals/paths.ts). */
const NO_REALPATH_PREFIXES = ["/Volumes/", "/net/", "/Network/", "/System/Volumes/Data/Volumes/"];
const MAX_PATH_LENGTH = 4096;

function defaultRealpath(p: string): string {
  return realpathSync.native(p);
}

function defaultReaddir(dir: string): string[] {
  return readdirSync(dir);
}

function approvalEnv(env: SandboxPathEnv): ApprovalPathEnv {
  return { home: env.home, dataDir: env.dataDir, realpath: env.realpath ?? defaultRealpath };
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** True for text that has no business in a path: NUL, other C0 controls, DEL. */
export function sandboxPathHasControlChars(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Resolve a path the way the kernel opens it: `~` expanded, relative paths
 * against `cwd`, and each component in order, so a symlink is followed before
 * a later `..` is applied (`link/../x` lands next to the link's target, not
 * next to the link). Components that do not exist are appended as written.
 * Returns both forms; `real` is where a write would actually land.
 */
export function resolveSandboxPath(p: string, cwd: string, env: SandboxPathEnv): NormalizedApprovalPath {
  const realpath = env.realpath ?? defaultRealpath;
  const expanded = expandApprovalHome(p, env.home);
  // String concatenation on purpose: path.join would apply `..` before the symlinks are seen.
  const absolute = isAbsolute(expanded) ? expanded : `${cwd || "/"}/${expanded}`;
  const lexical = stripTrailingSep(resolve(absolute));
  const segments = absolute.split("/").filter((s) => s.length > 0).slice(0, MAX_SEGMENTS);
  let current = "/";
  let exists = true;
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      current = dirname(current);
      continue;
    }
    const next = current === "/" ? `/${seg}` : `${current}/${seg}`;
    // Never stat into network mounts: a stalled volume must not block the gate.
    if (exists && NO_REALPATH_PREFIXES.some((p) => `${next}/`.startsWith(p))) exists = false;
    if (exists) {
      try {
        current = realpath(next);
        continue;
      } catch {
        exists = false;
      }
    }
    current = next;
  }
  return { lexical, real: stripTrailingSep(current) };
}

/**
 * True when a path has a `..` component. The sandbox refuses those for file
 * tools: a tool may normalise `..` before opening (lexical order) while the
 * kernel applies it after symlinks, so the two can land in different places.
 */
export function sandboxPathHasDotDot(p: string): boolean {
  return p.split(/[\\/]+/).includes("..");
}

/**
 * The first existing component strictly below `root` on the way to `path`
 * that is a symlink, or null. Used in docker mode, where the container can
 * plant or swap links inside the workspace at any time.
 */
export function sandboxSymlinkBelow(path: string, root: string, lstatIsLink: (p: string) => boolean | null = defaultIsLink): string | null {
  const r = stripTrailingSep(root);
  if (!sandboxPathInside(path, r)) return null;
  const rest = stripTrailingSep(path).slice(r.length).split("/").filter(Boolean);
  let current = r;
  for (const seg of rest.slice(0, MAX_SEGMENTS)) {
    current = `${current}/${seg}`;
    const link = lstatIsLink(current);
    if (link === null) return null; // does not exist: nothing below it can exist either
    if (link) return current;
  }
  return null;
}

function defaultIsLink(p: string): boolean | null {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return null;
  }
}

/** Case-insensitive (APFS default) "is `path` equal to or inside `root`". */
export function sandboxPathInside(path: string, root: string): boolean {
  const p = stripTrailingSep(path).toLowerCase();
  const r = stripTrailingSep(root).toLowerCase();
  if (r === "/") return true;
  return p === r || p.startsWith(`${r}/`);
}

/** A root directory in both forms (as configured, and with symlinks resolved). */
export function sandboxRootForms(root: string, env: SandboxPathEnv): string[] {
  const lexical = stripTrailingSep(resolve(expandApprovalHome(root, env.home)));
  const real = resolveSandboxPath(lexical, "/", env).real;
  return real === lexical ? [lexical] : [lexical, real];
}

/**
 * True when the resolved target of `path` lies inside one of `roots`.
 * Only the real form counts: that is where the write or read happens.
 */
export function sandboxPathWithinRoots(path: NormalizedApprovalPath, roots: readonly string[][]): boolean {
  return roots.some((forms) => forms.some((r) => sandboxPathInside(path.real, r)));
}

// ── Mounts that are never allowed ──────────────────────────────────────────

/** Directories a docker mount may never equal, contain or sit inside. */
export function sandboxForbiddenMountRoots(env: SandboxPathEnv): string[] {
  const h = env.home;
  const k = env.dataDir;
  return [
    join(k, "secrets"), join(k, "credentials"), join(k, "state"), join(k, "config.yaml"), join(k, "plugins"),
    join(h, ".ssh"), join(h, ".gnupg"), join(h, ".aws"), join(h, ".kube"), join(h, ".docker"),
    join(h, ".config"), join(h, "Library"), join(h, ".netrc"), join(h, ".npmrc"), join(h, ".git-credentials"),
    "/var/run/docker.sock", "/var/run", "/private/var/run", "/etc", "/private/etc",
  ];
}

/** Temporary directories under otherwise refused system prefixes. */
const TEMP_PREFIXES = ["/private/tmp/", "/private/var/folders/", "/var/folders/"];

/** `~/.claude`, `~/.claude2`,`~/.claude-work`, ...: any home entry whose name starts with `.claude`. */
function isClaudeConfigPath(p: string, home: string): boolean {
  const h = stripTrailingSep(home).toLowerCase();
  const lower = p.toLowerCase();
  if (!lower.startsWith(`${h}/`)) return false;
  return lower.slice(h.length + 1).split("/")[0]!.startsWith(".claude");
}

/**
 * Why a directory may not be bind-mounted into the container, or null when it
 * may. Checks the path as written and with symlinks resolved: the root, home,
 * Kirie's data directory or any of their ancestors; secrets, credentials,
 * state, `~/.ssh`, `~/.claude*`, kubeconfig, the Docker socket, system
 * directories; or a path that contains one of those.
 */
export function sandboxMountRefusal(dir: string, env: SandboxPathEnv): string | null {
  if (!dir || sandboxPathHasControlChars(dir)) return "the path contains control characters";
  if (dir.length > MAX_PATH_LENGTH) return "the path is too long";
  if (/[,"]/.test(dir)) return "the path may not contain a comma or a double quote";
  const expanded = expandApprovalHome(dir, env.home);
  if (!isAbsolute(expanded)) return "the path must be absolute";
  const resolved = resolveSandboxPath(expanded, "/", env);
  const forms = resolved.real === resolved.lexical ? [resolved.lexical] : [resolved.lexical, resolved.real];
  const home = stripTrailingSep(env.home);
  const dataDir = stripTrailingSep(env.dataDir);
  const forbidden = sandboxForbiddenMountRoots(env);
  const agentCwd = stripTrailingSep(env.agentCwd ?? env.dataDir);
  // The SDK loads `.claude/settings*.json`, `.mcp.json` and skills from these at the next spawn: a container must never write them.
  forbidden.push(join(agentCwd, ".claude"), join(agentCwd, ".mcp.json"), join(dataDir, ".claude"), join(dataDir, ".mcp.json"), join(dataDir, "skills"));
  for (const f of forms) {
    if (f === "/") return "the root directory can never be mounted";
    if (sandboxPathInside(agentCwd, f)) return "the agent's working directory (or a folder containing it) can never be mounted";
    if (sandboxPathInside(home, f)) return "the home directory (or a folder containing it) can never be mounted";
    if (sandboxPathInside(dataDir, f)) return "Kirie's data directory itself can never be mounted (use a folder inside it)";
    if (isClaudeConfigPath(f, home)) return "Claude config directories (~/.claude*) can never be mounted";
    for (const bad of forbidden) {
      if (sandboxPathInside(f, bad) || sandboxPathInside(bad, f)) return `it is or contains a protected location (${bad})`;
    }
    if (isApprovalRootTarget({ lexical: f, real: f }, approvalEnv(env))) return "system directories can never be mounted";
    if (/^\/(system|library|usr|bin|sbin|var|private|dev|opt|applications|cores|volumes)(\/|$)/i.test(f) && !TEMP_PREFIXES.some((t) => f.toLowerCase().startsWith(t))) {
      return "system directories can never be mounted";
    }
  }
  return null;
}

// ── Native-mode allow-write entries ────────────────────────────────────────

export type SandboxAllowWriteCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Validate a directory the owner wants writable in native mode. Returns the
 * absolute path to store (`~` expanded; E6: plain absolute paths work, no
 * realpath needed). Refuses the root, system directories, home or any of its
 * ancestors, a protected path, and a folder that contains a protected path.
 */
export function checkSandboxAllowWritePath(raw: string, env: SandboxPathEnv): SandboxAllowWriteCheck {
  const input = raw.trim();
  if (!input) return { ok: false, reason: "no path given" };
  if (sandboxPathHasControlChars(input) || input.length > MAX_PATH_LENGTH) return { ok: false, reason: "that is not a valid path" };
  if (hasGlobChars(input)) return { ok: false, reason: "wildcards are not supported; give one directory" };
  const expanded = expandApprovalHome(input, env.home);
  if (!isAbsolute(expanded)) return { ok: false, reason: "give an absolute path or one starting with ~/" };
  const path = stripTrailingSep(resolve(expanded));
  const normalized = resolveSandboxPath(path, "/", env);
  const aenv = approvalEnv(env);
  if (isApprovalRootTarget(normalized, aenv)) return { ok: false, reason: "that folder is far too broad (a system root or your home directory)" };
  for (const f of [normalized.lexical, normalized.real]) {
    if (sandboxPathInside(env.home, f)) return { ok: false, reason: "that folder contains your home directory" };
    if (/^\/(system|library|usr|bin|sbin|etc|private\/etc|dev)(\/|$)/i.test(f)) return { ok: false, reason: "system folders cannot be made writable" };
  }
  const protectedWrite = compileApprovalPathList(SANDBOX_PROTECTED_WRITE_PATHS, aenv);
  if (approvalPathMatches(normalized, protectedWrite)) return { ok: false, reason: "that path is protected (Kirie's config, state, secrets, credentials, or a credential file)" };
  if (approvalPathIsAncestorOf(normalized, protectedWrite)) return { ok: false, reason: "that folder contains protected files (for example ~/.ssh, ~/Library/LaunchAgents or Kirie's secrets); allow a narrower folder" };
  return { ok: true, path };
}

// ── Protected patterns as SDK sandbox paths ───────────────────────────────

const MAX_EXPANDED = 400;

function listDir(dir: string, readdir: (d: string) => string[]): string[] {
  try {
    return readdir(dir).slice(0, 2000);
  } catch {
    return [];
  }
}

/**
 * Expand a rooted pattern with wildcards segment by segment against the
 * directories that exist now (`~/.claude*\/settings*.json`, `{kirie}/*.db*`,
 * `~/.ssh/id_*`). A `**` segment stops the walk.
 */
function expandRootedGlob(pattern: string, readdir: (d: string) => string[], out: Set<string>): void {
  const segs = pattern.split("/").filter((s) => s.length > 0);
  let current: string[] = ["/"];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (seg === "**") {
      // Everything below the literal prefix: the directory itself covers it.
      for (const c of current) out.add(c);
      return;
    }
    const next: string[] = [];
    for (const dir of current) {
      if (!hasGlobChars(seg)) {
        next.push(dir === "/" ? `/${seg}` : `${dir}/${seg}`);
        continue;
      }
      for (const name of listDir(dir, readdir)) {
        if (matchApprovalGlob(seg, name, { caseInsensitive: true })) next.push(dir === "/" ? `/${name}` : `${dir}/${name}`);
        if (next.length > MAX_EXPANDED) break;
      }
    }
    current = next;
    if (current.length === 0) return;
  }
  for (const c of current) out.add(c);
}

/**
 * Turn approval-style path patterns into absolute paths for the SDK's
 * `sandbox.filesystem` lists. E6 verified plain absolute directories (a
 * directory covers what is below it); glob syntax was not tested, so every
 * wildcard pattern is also expanded against what exists now, and patterns
 * that apply anywhere (`**\/.env`) are instantiated under each of `roots`
 * (the writable directories, the only places a write can land). The
 * wildcard form itself is kept as well (harmless if the SDK reads it
 * literally). Exclusions (`!pattern`) are honoured for expanded entries.
 */
export function expandSandboxPathList(patterns: readonly string[], env: SandboxPathEnv, roots: readonly string[]): string[] {
  const readdir = env.readdir ?? defaultReaddir;
  const aenv = approvalEnv(env);
  const compiled: ApprovalPathList = compileApprovalPathList(patterns, aenv);
  const literal = new Set<string>();
  const expanded = new Set<string>();
  const globs = new Set<string>();

  const addPattern = (pat: string): void => {
    if (pat.endsWith("/**") && !hasGlobChars(pat.slice(0, -3))) {
      literal.add(stripTrailingSep(pat.slice(0, -3)) || "/");
      return;
    }
    if (!hasGlobChars(pat)) {
      literal.add(stripTrailingSep(pat));
      return;
    }
    globs.add(pat);
    expandRootedGlob(pat, readdir, expanded);
  };

  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("!")) continue;
    const pat = expandApprovalPattern(trimmed, aenv);
    if (pat.startsWith("/")) {
      addPattern(pat);
    } else if (pat.startsWith("**/")) {
      for (const root of roots) addPattern(`${stripTrailingSep(root)}/${pat.slice(3)}`);
      for (const root of roots) globs.add(`${stripTrailingSep(root)}/${pat}`);
    }
  }

  const out: string[] = [...literal];
  for (const p of expanded) {
    if (literal.has(p)) continue;
    // Honour exclusions (`!~/.ssh/*.pub`): keep only entries the full list still protects.
    if (approvalPathMatches({ lexical: p, real: p }, compiled)) out.push(p);
  }
  for (const g of globs) out.push(g);
  return [...new Set(out)].slice(0, MAX_EXPANDED * 2);
}

/** Protected-write paths for the native sandbox's `denyWrite`. */
export function sandboxDenyWritePaths(env: SandboxPathEnv, roots: readonly string[]): string[] {
  return expandSandboxPathList(SANDBOX_PROTECTED_WRITE_PATHS, env, roots);
}

/** Protected-read paths for the native sandbox's `denyRead`. */
export function sandboxDenyReadPaths(env: SandboxPathEnv, roots: readonly string[]): string[] {
  return expandSandboxPathList(SANDBOX_PROTECTED_READ_PATHS, env, roots);
}
