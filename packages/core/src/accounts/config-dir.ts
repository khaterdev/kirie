/**
 * Claude config dirs on disk (PLAN C.1): discovery, path validation, the
 * identity file, the login check and carrying a transcript between dirs.
 *
 * Nothing here reads, copies or logs a token. The login check runs
 * `security find-generic-password -s <service>` and looks at the exit code
 * only (never `-w` or `-g`), or tests that `.credentials.json` exists without
 * opening it. The identity read takes three fields from `.claude.json`.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { ClaudeAccountKind } from "./account-env.js";

/** Keychain service name used by the Claude CLI when CLAUDE_CONFIG_DIR is unset. */
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Session ids are uuids; anything else is refused before it becomes a path. */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/** Discovery pattern under the home directory: `.claude`, `.claude2`, `.claude10`, ... */
const DISCOVER_RE = /^\.claude(\d*)$/;

export class AccountPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountPathError";
  }
}

/** Expand a leading `~`. */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

/**
 * The canonical form of a config dir path: `~` expanded, resolved, NFC, no
 * trailing slash. The Keychain item is keyed by this exact string, so
 * `/Users/x/.claude2/` and `/Users/x/.claude2` would be two different logins.
 */
export function normalizeConfigDirPath(input: string, home: string = homedir()): string {
  const trimmed = input.trim();
  if (!trimmed) throw new AccountPathError("empty path");
  const expanded = expandHome(trimmed, home).normalize("NFC");
  if (!isAbsolute(expanded)) throw new AccountPathError("the path must be absolute (or start with ~/)");
  let out = resolve(expanded);
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return out;
}

/** The Keychain service the CLI uses for a config dir (null = the default account). */
export function keychainServiceName(configDir: string | null): string {
  if (!configDir) return CLAUDE_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${suffix}`;
}

/** "mostafa@example.com" -> "mo***@example.com". Never store or show the full address. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Where an account keeps its data: the default account uses `~/.claude`. */
export function accountDataDir(configDir: string | null, home: string = homedir()): string {
  return configDir ?? join(home, ".claude");
}

/** The identity file: `~/.claude.json` for the default account, `<dir>/.claude.json` otherwise. */
export function identityFilePath(configDir: string | null, home: string = homedir()): string {
  return configDir ? join(configDir, ".claude.json") : join(home, ".claude.json");
}

export interface AccountIdentity {
  accountUuid: string;
  /** Masked email */
  label: string;
  organizationType?: string;
}

export type IdentityReadResult =
  | { ok: true; identity: AccountIdentity }
  | { ok: false; reason: "missing" | "unreadable" | "not_logged_in" };

/**
 * Read `oauthAccount.accountUuid`, the masked email and the organization type,
 * and nothing else. "unreadable" covers a file caught mid-write by the CLI.
 */
export function readAccountIdentity(file: string): IdentityReadResult {
  if (!existsSync(file)) return { ok: false, reason: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const oauth = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
  if (!oauth || typeof oauth !== "object") return { ok: false, reason: "not_logged_in" };
  const rec = oauth as Record<string, unknown>;
  const uuid = rec.accountUuid;
  if (typeof uuid !== "string" || !uuid) return { ok: false, reason: "not_logged_in" };
  const email = typeof rec.emailAddress === "string" ? rec.emailAddress : "";
  const orgType = typeof rec.organizationType === "string" ? rec.organizationType : undefined;
  return {
    ok: true,
    identity: {
      accountUuid: uuid,
      label: email ? maskEmail(email) : "(no email)",
      ...(orgType ? { organizationType: orgType } : {}),
    },
  };
}

/** Runs `security` with the given args and returns its exit code. Output is discarded. */
export type SecurityRunner = (args: readonly string[]) => number;

const defaultSecurityRunner: SecurityRunner = (args) => {
  const res = spawnSync("/usr/bin/security", [...args], { stdio: "ignore", timeout: 10_000 });
  return typeof res.status === "number" ? res.status : 1;
};

export type LoginCheck = "logged_in" | "not_found" | "unknown";

/**
 * Cheap existence-only login check. `.credentials.json` present, or (macOS)
 * a Keychain item with the CLI's service name. Only the exit code is used;
 * the arguments never include `-w` or `-g`, so no secret is ever printed.
 */
export function checkLogin(
  configDir: string | null,
  opts: { home?: string; platform?: NodeJS.Platform; runSecurity?: SecurityRunner } = {},
): LoginCheck {
  const home = opts.home ?? homedir();
  if (existsSync(join(accountDataDir(configDir, home), ".credentials.json"))) return "logged_in";
  const platform = opts.platform ?? process.platform;
  if (platform !== "darwin") return "unknown";
  const run = opts.runSecurity ?? defaultSecurityRunner;
  try {
    return run(["find-generic-password", "-s", keychainServiceName(configDir)]) === 0 ? "logged_in" : "not_found";
  } catch {
    return "unknown";
  }
}

export interface ValidatedConfigDir {
  kind: ClaudeAccountKind;
  /** Exact path to put in CLAUDE_CONFIG_DIR, or null for the default account */
  configDir: string | null;
  /** The normalised path the owner gave (also for the default account) */
  path: string;
  identityFile: string;
}

/**
 * Validate a config dir for import (R1 "Import" steps 1 and 2). Importing a dir
 * means trusting its settings.json hooks, so it must be a directory owned by
 * this user, not group- or world-writable, and inside an import root.
 */
export function validateConfigDir(
  input: string,
  opts: { home?: string; importRoots?: readonly string[]; uid?: number } = {},
): ValidatedConfigDir {
  const home = opts.home ?? homedir();
  const path = normalizeConfigDirPath(input, home);

  let st;
  try {
    st = statSync(path);
  } catch {
    throw new AccountPathError("the directory does not exist");
  }
  if (!st.isDirectory()) throw new AccountPathError("not a directory");
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (uid !== undefined && st.uid !== uid) throw new AccountPathError("the directory is not owned by the daemon's user");
  if ((st.mode & 0o022) !== 0) throw new AccountPathError("the directory is group- or world-writable");

  const roots = (opts.importRoots && opts.importRoots.length > 0 ? opts.importRoots : [home])
    .map((r) => realpathOrSelf(normalizeConfigDirPath(r, home)));
  const real = realpathOrSelf(path);
  if (!roots.some((root) => isInside(real, root))) {
    throw new AccountPathError("the directory is outside accounts.importRoots");
  }

  if (real === realpathOrSelf(join(home, ".claude"))) {
    return { kind: "default", configDir: null, path, identityFile: identityFilePath(null, home) };
  }
  return { kind: "config_dir", configDir: path, path, identityFile: identityFilePath(path, home) };
}

export interface DiscoveredConfigDir {
  /** e.g. /Users/x/.claude2 */
  path: string;
  kind: ClaudeAccountKind;
  /** Default import id: "main" for ~/.claude, else the basename without the dot */
  suggestedId: string;
  identity: IdentityReadResult;
  login: LoginCheck;
}

/** The default import id for a path. */
export function suggestedAccountId(path: string, kind: ClaudeAccountKind): string {
  if (kind === "default") return "main";
  const base = basename(path).replace(/^\.+/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
  return base || "account";
}

/** List `~/.claude` and `~/.claude<N>` dirs. Reads identity files and runs the login check; spawns no Claude process. */
export function discoverConfigDirs(
  opts: { home?: string; platform?: NodeJS.Platform; runSecurity?: SecurityRunner } = {},
): DiscoveredConfigDir[] {
  const home = opts.home ?? homedir();
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const out: DiscoveredConfigDir[] = [];
  const matches = names
    .map((name) => ({ name, m: DISCOVER_RE.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1] || "1") - Number(b.m[1] || "1"));
  for (const { name, m } of matches) {
    const path = join(home, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    const kind: ClaudeAccountKind = m[1] === "" ? "default" : "config_dir";
    const configDir = kind === "default" ? null : path;
    out.push({
      path,
      kind,
      suggestedId: suggestedAccountId(path, kind),
      identity: readAccountIdentity(identityFilePath(configDir, home)),
      login: checkLogin(configDir, opts),
    });
  }
  return out;
}

/** True when both dirs share one `projects/` store (the symlinked layout). */
export function sameProjects(fromDir: string, toDir: string): boolean {
  const a = join(fromDir, "projects");
  const b = join(toDir, "projects");
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

export type CarryStatus = "same" | "copied" | "missing" | "diverged" | "failed";

export interface CarryResult {
  status: CarryStatus;
  detail?: string;
}

function findTranscript(dataDir: string, sessionId: string): { slug: string; file: string } | null {
  const projects = join(dataDir, "projects");
  let slugs: string[];
  try {
    slugs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const file = join(projects, slug, `${sessionId}.jsonl`);
    if (existsSync(file)) return { slug, file };
  }
  return null;
}

/**
 * Make a session's transcript visible under another config dir before it is
 * resumed there. A no-op when both share `projects/`. Otherwise copy the
 * `.jsonl` (temp name, then rename, mode 0600) and best-effort its sidecar
 * `<id>/` dir. An older copy (a prefix of the source) is replaced; a copy that
 * grew separately is never overwritten. Call only after the old process exited.
 */
export function carryTranscript(fromDataDir: string, toDataDir: string, sessionId: string): CarryResult {
  if (!SESSION_ID_RE.test(sessionId)) return { status: "failed", detail: "invalid session id" };
  if (realpathOrSelf(fromDataDir) === realpathOrSelf(toDataDir) || sameProjects(fromDataDir, toDataDir)) {
    return { status: "same" };
  }
  const source = findTranscript(fromDataDir, sessionId);
  if (!source) return { status: "missing", detail: "no transcript in the source dir" };

  const targetDir = join(toDataDir, "projects", source.slug);
  const target = join(targetDir, `${sessionId}.jsonl`);
  try {
    const src = readFileSync(source.file);
    if (existsSync(target)) {
      const dst = readFileSync(target);
      if (dst.length > src.length || !src.subarray(0, dst.length).equals(dst)) {
        return { status: "diverged", detail: "the target holds a different copy of this conversation" };
      }
      if (dst.length === src.length) return { status: "copied" };
    }
  } catch {
    return { status: "failed", detail: "could not read the transcripts" };
  }
  const tmp = join(targetDir, `.${sessionId}.jsonl.kirie-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    copyFileSync(source.file, tmp, constants.COPYFILE_EXCL);
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to clean up
    }
    return { status: "failed", detail: (err as NodeJS.ErrnoException).code ?? "copy failed" };
  }
  const sidecar = join(fromDataDir, "projects", source.slug, sessionId);
  if (existsSync(sidecar)) {
    try {
      cpSync(sidecar, join(targetDir, sessionId), { recursive: true, force: false, errorOnExist: false });
    } catch {
      // best effort: tool results and subagent transcripts are optional for resume
    }
  }
  return { status: "copied" };
}
