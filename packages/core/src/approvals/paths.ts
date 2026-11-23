/**
 * Protected paths for the approval gate (PLAN C.9, R2 section 4 "Protected
 * paths"). Also used by the sandbox (W3-SBX) and computer use (W3-CU).
 *
 * Patterns use `~` for the home directory and `{kirie}` for Kirie's data
 * directory (default `~/.kirie`). A leading `!` excludes matches of an
 * earlier entry. Matching is case-insensitive and is done on both the lexical
 * path and the path with symlinks resolved.
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { hasGlobChars, matchApprovalPathGlob } from "./glob.js";

/** Writes (file tools, redirects, tee, cp, mv, ln, sed -i, rm, ...) to these ask in `ask` mode. */
export const APPROVALS_PROTECTED_WRITE_PATHS: readonly string[] = [
  "~/.ssh/**",
  "~/.gnupg/**",
  "~/.aws/**",
  "~/.kube/**",
  "~/.config/gh/**",
  "~/.config/gcloud/**",
  "~/.config/fish/**",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.npmrc",
  "~/.pgpass",
  "~/.git-credentials",
  "~/.gitconfig",
  "~/.zshrc",
  "~/.zprofile",
  "~/.zshenv",
  "~/.zlogin",
  "~/.bashrc",
  "~/.bash_profile",
  "~/.bash_login",
  "~/.profile",
  "~/Library/LaunchAgents/**",
  "/Library/LaunchAgents/**",
  "/Library/LaunchDaemons/**",
  "/etc/**",
  "/private/etc/**",
  "~/.claude*/settings*.json",
  "~/.claude*/.credentials.json",
  "**/.claude/settings*.json",
  "**/.git/hooks/**",
  "**/.env",
  "**/.env.*",
  "{kirie}/secrets/**",
  "{kirie}/credentials/**",
  "{kirie}/config.yaml",
  "{kirie}/state/**",
  "{kirie}/*.sh",
  "{kirie}/*.db*",
  "{kirie}/plugins/**",
  "{kirie}/skills-archive/**",
  "{kirie}/USER.md",
  "{kirie}/.claude/skills/**",
  "{kirie}/.mcp.json",
  "{kirie}/logs/audit.jsonl*",
];

/** Reads (Read, Grep, and shell commands that reference them) ask in `ask` mode. */
export const APPROVALS_PROTECTED_READ_PATHS: readonly string[] = [
  "{kirie}/secrets/**",
  "{kirie}/credentials/**",
  "{kirie}/config.yaml",
  "~/.ssh/id_*",
  "~/.ssh/*.pem",
  "~/.ssh/*.key",
  "!~/.ssh/*.pub",
  "~/.aws/credentials",
  "~/.kube/config",
  "~/.netrc",
  "~/.npmrc",
  "~/.pgpass",
  "~/.git-credentials",
  "~/.docker/config.json",
  "~/.config/gh/hosts.yml",
  "~/.claude*/.credentials.json",
  "~/Library/Keychains/**",
  "**/.env",
  "**/.env.*",
  "**/*.kubeconfig",
];

/** Shell history files: a secret source for the exfiltration rule (not a protected read by themselves). */
export const APPROVALS_SHELL_HISTORY_PATHS: readonly string[] = [
  "~/.zsh_history",
  "~/.bash_history",
  "~/.zsh_sessions/**",
  "~/.local/share/fish/fish_history",
];

/** Recursive deletes, chmod and chown of these are hardline (R2 "Hardline"). */
const ROOT_TARGETS: readonly string[] = [
  "/", "~", "/Users", "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/var", "/private",
  "/private/etc", "/private/var", "/opt", "/Applications", "/Volumes", "/dev", "/cores",
  "/home", "/root", "/boot", "/lib", "/lib64", "/srv",
];

/** System directories for `fs.system-write`. `/usr/local` is excluded. */
const SYSTEM_WRITE_DIRS: readonly string[] = [
  "/etc", "/private/etc", "/System", "/Library", "/usr", "/bin", "/sbin",
];

export interface ApprovalPathEnv {
  home: string;
  /** Kirie's data directory, `{kirie}` in patterns. Default `<home>/.kirie`. */
  dataDir?: string;
  /** Resolve symlinks of an existing path. Default `fs.realpathSync.native`. Must throw for a missing path. */
  realpath?: (p: string) => string;
}

/** A path in both forms: as written (expanded, absolute, normalized) and with symlinks resolved. */
export interface NormalizedApprovalPath {
  lexical: string;
  real: string;
}

function defaultRealpath(p: string): string {
  return realpathSync.native(p);
}

function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}

/** Expand `~`, `~/x`, `~user`, `$HOME` and `${HOME}` at the start of a path. Other text is unchanged. */
export function expandApprovalHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p.startsWith("$HOME")) {
    const rest = p.slice(5);
    if (rest === "" || rest.startsWith("/")) return home + rest;
  }
  if (p.startsWith("${HOME}")) return home + p.slice(7);
  if (p.startsWith("~") && !p.startsWith("~+") && !p.startsWith("~-")) {
    const slash = p.indexOf("/");
    const user = slash === -1 ? p.slice(1) : p.slice(1, slash);
    if (/^[A-Za-z0-9._-]+$/.test(user)) {
      const userHome = user === basenameOf(home) ? home : join(dirname(home), user);
      return slash === -1 ? userHome : join(userHome, p.slice(slash + 1));
    }
  }
  return p;
}

function basenameOf(p: string): string {
  const parts = p.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Expand `~` and `{kirie}` in a pattern. */
export function expandApprovalPattern(pattern: string, env: ApprovalPathEnv): string {
  const dataDir = env.dataDir ?? join(env.home, ".kirie");
  if (pattern.startsWith("{kirie}")) return stripTrailingSep(dataDir) + pattern.slice(7);
  if (pattern === "~" || pattern.startsWith("~/")) return expandApprovalHome(pattern, env.home);
  return pattern;
}

/**
 * Expand the home directory, resolve against `cwd`, normalize `.` and `..`,
 * and resolve symlinks of the deepest existing ancestor (so a link into
 * `~/.ssh` is caught). Never throws.
 */
export function normalizeApprovalPath(p: string, cwd: string, env: ApprovalPathEnv, cache?: Map<string, string>): NormalizedApprovalPath {
  const expanded = expandApprovalHome(p, env.home);
  const lexical = stripTrailingSep(isAbsolute(expanded) ? normalize(expanded) : resolve(cwd || "/", expanded));
  return { lexical, real: realpathDeepest(lexical, env.realpath ?? defaultRealpath, cache) };
}

/** Mount points where a stalled network volume could block a realpath call. Never resolved. */
const NO_REALPATH_PREFIXES = ["/Volumes/", "/net/", "/Network/", "/System/Volumes/Data/Volumes/"];

function realpathDeepest(p: string, realpath: (p: string) => string, cache?: Map<string, string>): string {
  const cached = cache?.get(p);
  if (cached !== undefined) return cached;
  if (NO_REALPATH_PREFIXES.some((prefix) => p.startsWith(prefix))) return p;
  let current = p;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpath(current);
      const result = tail.length > 0 ? join(real, ...tail.reverse()) : real;
      cache?.set(p, result);
      return result;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      tail.push(current.slice(parent.length).replace(/^\/+/, ""));
      current = parent;
    }
  }
  cache?.set(p, p);
  return p;
}

/** Compiled list of path patterns (`~` and `{kirie}` expanded, exclusions split out). */
export interface ApprovalPathList {
  include: string[];
  exclude: string[];
  /** Literal directory prefixes of the rooted include patterns (for "is an ancestor of" checks). */
  roots: string[];
}

export function compileApprovalPathList(patterns: readonly string[], env: ApprovalPathEnv): ApprovalPathList {
  const include: string[] = [];
  const exclude: string[] = [];
  const roots: string[] = [];
  for (const raw of patterns) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const negated = trimmed.startsWith("!");
    const expanded = expandApprovalPattern(negated ? trimmed.slice(1) : trimmed, env);
    if (!expanded.startsWith("/") && !expanded.startsWith("**")) continue;
    (negated ? exclude : include).push(expanded);
    if (!negated && expanded.startsWith("/")) {
      const segs = expanded.split("/");
      const literal: string[] = [];
      for (const s of segs) {
        if (hasGlobChars(s)) break;
        literal.push(s);
      }
      // A pattern whose last literal segment is the file itself: its parent directory is the root.
      const prefix = literal.length === segs.length ? literal.slice(0, -1) : literal;
      roots.push(prefix.join("/") || "/");
    }
  }
  return { include, exclude, roots };
}

function matchesList(path: string, list: ApprovalPathList): boolean {
  if (!list.include.some((pat) => matchApprovalPathGlob(pat, path))) return false;
  return !list.exclude.some((pat) => matchApprovalPathGlob(pat, path));
}

/** True when either form of the path matches the list. */
export function approvalPathMatches(path: NormalizedApprovalPath, list: ApprovalPathList): boolean {
  return matchesList(path.lexical, list) || (path.real !== path.lexical && matchesList(path.real, list));
}

/** True when the path is, or is an ancestor directory of, one of the list's rooted patterns. */
export function approvalPathIsAncestorOf(path: NormalizedApprovalPath, list: ApprovalPathList): boolean {
  for (const form of path.real === path.lexical ? [path.lexical] : [path.lexical, path.real]) {
    const dir = form === "/" ? "/" : `${form.toLowerCase()}/`;
    for (const root of list.roots) {
      const r = root === "/" ? "/" : `${root.toLowerCase()}/`;
      if (dir === "/" || r.startsWith(dir)) return true;
    }
  }
  return false;
}

/** True when the path is a hardline root target (`/`, home, `/Users`, `/System`, ...). */
export function isApprovalRootTarget(path: NormalizedApprovalPath, env: ApprovalPathEnv): boolean {
  const targets = ROOT_TARGETS.map((t) => (t === "~" ? stripTrailingSep(env.home) : t).toLowerCase());
  return [path.lexical, path.real].some((form) => targets.includes(form.toLowerCase()));
}

/** True when the path is inside a system directory (`/etc`, `/System`, `/Library`, `/usr` except `/usr/local`, ...). */
export function isApprovalSystemPath(path: NormalizedApprovalPath): boolean {
  return [path.lexical, path.real].some((form) => {
    const f = form.toLowerCase();
    if (f === "/usr/local" || f.startsWith("/usr/local/")) return false;
    return SYSTEM_WRITE_DIRS.some((d) => {
      const dl = d.toLowerCase();
      return f === dl || f.startsWith(`${dl}/`);
    });
  });
}

const RAW_DEVICE_PREFIXES = ["/dev/disk", "/dev/rdisk", "/dev/sd", "/dev/nvme", "/dev/hd", "/dev/mmcblk", "/dev/xvd", "/dev/vd"];

/** True for raw block devices (`/dev/disk2`, `/dev/rdisk0s1`, `/dev/sda`, ...). */
export function isApprovalRawDevice(p: string): boolean {
  const lower = p.toLowerCase();
  return RAW_DEVICE_PREFIXES.some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length);
}
