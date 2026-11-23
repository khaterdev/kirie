/**
 * Built-in approval rules (PLAN C.9, R2 section 4 "Default rule sets").
 *
 * Every rule is a predicate over one parsed simple command (`ShellSegment`),
 * anchored to the command position: a rule for `mkfs` looks at segments whose
 * command is `mkfs`, never at the word "mkfs" inside an echo or a commit
 * message (R6 9 "Avoid" 9). A few rules look at the whole parsed command
 * (fork bombs, exfiltration, remote code piped into a shell).
 *
 * No rule builds a regular expression from input, and no pattern here has a
 * nested quantifier.
 */

import { basename } from "node:path";
import {
  approvalPathIsAncestorOf,
  approvalPathMatches,
  isApprovalRawDevice,
  isApprovalRootTarget,
  isApprovalSystemPath,
  normalizeApprovalPath,
  type ApprovalPathEnv,
  type ApprovalPathList,
  type NormalizedApprovalPath,
} from "./paths.js";
import { hasGlobChars } from "./glob.js";
import type { ParsedShell, ShellSegment } from "./shell-parse.js";

export interface ApprovalRuleEnv {
  path: ApprovalPathEnv;
  /** The tool call's working directory (used when a segment's own cwd is unknown or unset). */
  cwd: string;
  gatewayPort: number;
  write: ApprovalPathList;
  read: ApprovalPathList;
  history: ApprovalPathList;
  /** `{kirie}/config.yaml`, `{kirie}/state/**`, `{kirie}/*.sh` */
  kirieControl: ApprovalPathList;
  /** `{kirie}/*.db*` */
  kirieDb: ApprovalPathList;
  /** realpath cache for one evaluation */
  cache: Map<string, string>;
}

export interface ApprovalRule {
  id: string;
  group: string;
  severity: "hardline" | "dangerous";
  description: string;
  /** Segment commands this rule looks at. Absent: every segment. */
  commands?: readonly string[];
  /** Returns the reason when the segment matches, else null. */
  check(seg: ShellSegment, env: ApprovalRuleEnv): string | null;
}

export interface ApprovalCommandRule {
  id: string;
  group: string;
  severity: "hardline" | "dangerous";
  description: string;
  check(parsed: ParsedShell, env: ApprovalRuleEnv): Array<{ reason: string; segment?: number }>;
}

// ── Argument helpers ──────────────────────────────────────────────────────

interface ParsedArgs {
  long: Set<string>;
  short: Set<string>;
  values: Map<string, string[]>;
  positionals: string[];
}

const EMPTY = new Set<string>();

function parseArgs(argv: readonly string[], start = 1, valueOpts: ReadonlySet<string> = EMPTY): ParsedArgs {
  const out: ParsedArgs = { long: new Set(), short: new Set(), values: new Map(), positionals: [] };
  const addValue = (k: string, v: string): void => {
    const list = out.values.get(k) ?? [];
    list.push(v);
    out.values.set(k, list);
  };
  for (let i = start; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      out.long.add(name);
      if (eq !== -1) addValue(name, a.slice(eq + 1));
      else if (valueOpts.has(name) && i + 1 < argv.length) addValue(name, argv[++i]!);
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const flag = `-${a[k]}`;
        out.short.add(a[k]!);
        if (valueOpts.has(flag)) {
          const rest = a.slice(k + 1);
          if (rest) addValue(flag, rest);
          else if (i + 1 < argv.length) addValue(flag, argv[++i]!);
          break;
        }
      }
      continue;
    }
    out.positionals.push(a);
  }
  return out;
}

/** First positional after global options; returns its index in argv (or -1). */
function subcommandIndex(argv: readonly string[], valueOpts: ReadonlySet<string>, start = 1): number {
  for (let i = start; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") return i + 1 < argv.length ? i + 1 : -1;
    if (a.startsWith("-")) {
      if (!a.includes("=") && valueOpts.has(a)) i++;
      continue;
    }
    return i;
  }
  return -1;
}

function lower(s: string): string {
  return s.toLowerCase();
}

function startsWithAny(a: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => a.startsWith(p));
}

/** Normalizes a path argument for the segment. Returns null when the path cannot be placed (relative, cwd unknown). */
function norm(seg: ShellSegment, p: string, env: ApprovalRuleEnv): NormalizedApprovalPath | null {
  if (!p) return null;
  const absoluteish = p.startsWith("/") || p.startsWith("~") || p.startsWith("$HOME") || p.startsWith("${HOME}");
  if (!absoluteish && seg.cwd === null && seg.remote) return null;
  const cwd = seg.cwd ?? env.cwd;
  if (!absoluteish && !cwd) return null;
  return normalizeApprovalPath(p, cwd, env.path, env.cache);
}

function isOutputRedirect(op: string): boolean {
  return op === ">" || op === ">>" || op === ">|" || op === "&>" || op === "&>>" || op === "<>" || op === ">&";
}

function isFdTarget(target: string): boolean {
  return target === "-" || /^[0-9]+$/.test(target);
}

const CP_LIKE = new Set(["cp", "install", "ditto", "rsync"]);
const DELETE_LIKE = new Set(["rm", "unlink", "shred", "srm", "rmdir", "truncate", "touch"]);
const PERM_LIKE = new Set(["chmod", "chown", "chgrp", "chflags", "xattr"]);

/** Paths this segment writes to (redirects and the write targets of common commands). */
export function segmentWriteTargets(seg: ShellSegment): string[] {
  const out: string[] = [];
  for (const r of seg.redirects) {
    if (isOutputRedirect(r.op) && r.target && !(r.op === ">&" && isFdTarget(r.target))) out.push(r.target);
  }
  const cmd = seg.cmd;
  const argv = seg.argv;
  if (cmd === "tee") out.push(...parseArgs(argv).positionals);
  else if (CP_LIKE.has(cmd)) {
    const p = parseArgs(argv, 1, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "-g", "-S", "--suffix", "-e", "--exclude", "--include", "--filter", "--rsh"]));
    const t = p.values.get("-t") ?? p.values.get("--target-directory");
    if (t) out.push(...t);
    const last = p.positionals[p.positionals.length - 1];
    if (last && p.positionals.length >= 2 && !(cmd === "rsync" && /^[^/]*:/.test(last))) out.push(last);
  } else if (cmd === "mv") {
    out.push(...parseArgs(argv, 1, new Set(["-t", "--target-directory", "-S", "--suffix"])).positionals);
  } else if (cmd === "ln") {
    const p = parseArgs(argv, 1, new Set(["-t", "--target-directory", "-S", "--suffix"]));
    const last = p.positionals[p.positionals.length - 1];
    if (last) out.push(last);
  } else if (cmd === "dd") {
    for (const a of argv.slice(1)) if (a.startsWith("of=")) out.push(a.slice(3));
  } else if (cmd === "sed" || cmd === "perl" || cmd === "ruby") {
    const inPlace = argv.slice(1).some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place=") || (/^-[a-z]+$/i.test(a) && a.includes("i")));
    if (inPlace) {
      const p = parseArgs(argv, 1, new Set(["-e", "-f", "--expression", "--file", "-E"]));
      const scriptGiven = p.values.has("-e") || p.values.has("--expression") || p.values.has("-f") || p.values.has("--file");
      out.push(...(scriptGiven ? p.positionals : p.positionals.slice(1)));
    }
  } else if (DELETE_LIKE.has(cmd)) {
    out.push(...parseArgs(argv, 1, new Set(["-s", "--size", "-r", "--reference", "-d", "-t"])).positionals);
  } else if (PERM_LIKE.has(cmd)) {
    const p = parseArgs(argv, 1, new Set(["--reference"]));
    out.push(...(cmd === "xattr" ? p.positionals : p.positionals.slice(1)));
  } else if (cmd === "curl") {
    const p = parseArgs(argv, 1, CURL_VALUE_OPTS);
    out.push(...(p.values.get("-o") ?? []), ...(p.values.get("--output") ?? []));
  } else if (cmd === "wget") {
    const p = parseArgs(argv, 1, new Set(["-O", "--output-document", "-P", "--directory-prefix"]));
    out.push(...(p.values.get("-O") ?? []), ...(p.values.get("--output-document") ?? []), ...(p.values.get("-P") ?? []), ...(p.values.get("--directory-prefix") ?? []));
  } else if (cmd === "sudoedit" || cmd === "patch" || cmd === "plutil") {
    out.push(...parseArgs(argv).positionals);
  } else if (cmd === "unzip") {
    const d = parseArgs(argv, 1, new Set(["-d"])).values.get("-d");
    if (d) out.push(...d);
  } else if (cmd === "tar") {
    const p = parseArgs(argv, 1, new Set(["-C", "--directory", "-f", "--file"]));
    const extracting = p.short.has("x") || p.long.has("--extract") || /^[a-z]*x[a-z]*$/.test(argv[1] ?? "");
    if (extracting) out.push(...(p.values.get("-C") ?? []), ...(p.values.get("--directory") ?? []));
  }
  return out.filter((t) => t.length > 0);
}

const NON_READING = new Set([
  "ls", "stat", "test", "[", "[[", "touch", "mkdir", "chmod", "chown", "chgrp", "chflags", "du", "file", "realpath",
  "readlink", "dirname", "basename", "which", "type", "rm", "unlink", "rmdir", "cd", "pushd", "echo", "printf", "mv",
  "ln", "true", "false", ":", "lsof", "mdls", "xattr", "open",
]);
const IDENTITY_FILE_COMMANDS = new Set(["ssh", "scp", "sftp", "ssh-add", "ssh-keygen", "rsync", "git", "mosh", "autossh"]);
const RECURSIVE_READERS = new Set(["rg", "ag", "ack", "tar", "zip", "rsync", "7z", "ditto", "find"]);

/** Path-like values this segment reads (positionals, option values, `@file` arguments, input redirects). */
function segmentReadCandidates(seg: ShellSegment): string[] {
  const out: string[] = [];
  for (const r of seg.redirects) {
    if ((r.op === "<" || r.op === "<>") && r.target) out.push(r.target);
  }
  if (NON_READING.has(seg.cmd)) return out;
  const argv = seg.argv;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (IDENTITY_FILE_COMMANDS.has(seg.cmd) && (a === "-i" || a === "-f")) { i++; continue; }
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq !== -1) out.push(a.slice(eq + 1).replace(/^@/, ""));
      continue;
    }
    const at = a.indexOf("@");
    if (at === 0) out.push(a.slice(1));
    else if (at > 0 && a[at - 1] === "=") out.push(a.slice(at + 1).split(";")[0]!);
    out.push(a);
  }
  return out.filter((t) => t.length > 0 && t.length < 4096);
}

function isRecursiveRead(seg: ShellSegment): boolean {
  if (RECURSIVE_READERS.has(seg.cmd)) return true;
  const p = parseArgs(seg.argv);
  if (seg.cmd === "grep" || seg.cmd === "egrep" || seg.cmd === "fgrep") return p.short.has("r") || p.short.has("R") || p.long.has("--recursive") || p.long.has("--dereference-recursive");
  if (seg.cmd === "cp" || seg.cmd === "scp") return p.short.has("r") || p.short.has("R") || p.short.has("a") || p.long.has("--recursive") || p.long.has("--archive");
  return false;
}

// ── Shared predicates ─────────────────────────────────────────────────────

/** Recursive flags of rm. */
function rmInfo(seg: ShellSegment): { recursive: boolean; noPreserveRoot: boolean; targets: Array<{ value: string; expansion: boolean }> } {
  let recursive = false;
  let noPreserveRoot = false;
  let endOpts = false;
  const targets: Array<{ value: string; expansion: boolean }> = [];
  for (let i = 1; i < seg.args.length; i++) {
    const a = seg.args[i]!;
    const v = a.value;
    if (!endOpts && v === "--") { endOpts = true; continue; }
    if (!endOpts && v.startsWith("--")) {
      if (v === "--recursive") recursive = true;
      if (v === "--no-preserve-root") noPreserveRoot = true;
      continue;
    }
    if (!endOpts && v.startsWith("-") && v.length > 1) {
      if (v.includes("r") || v.includes("R")) recursive = true;
      continue;
    }
    targets.push({ value: v, expansion: a.expansion });
  }
  return { recursive, noPreserveRoot, targets };
}

const HOME_VAR = /^(\$HOME|\$\{HOME\}|\$\{HOME:[-?][^}]*\})(\/|$)/;

/**
 * A recursive target that resolves to a root (`/`, home, `/Users`, `/System`, ...),
 * or a glob directly inside one (`/*`, `~/*`, `/U*`).
 */
function isRootishTarget(seg: ShellSegment, t: { value: string; expansion: boolean }, env: ApprovalRuleEnv): boolean {
  let v = t.value;
  if (t.expansion) {
    if (!HOME_VAR.test(v)) return false;
    v = v.replace(/^\$\{HOME:[-?][^}]*\}/, "$HOME").replace(/^\$\{HOME\}/, "$HOME");
  }
  const parts = v.split("/");
  let globbed = false;
  while (parts.length > 1 && hasGlobChars(parts[parts.length - 1]!)) {
    parts.pop();
    globbed = true;
  }
  const last = parts[parts.length - 1] ?? "";
  if (parts.length === 1 && hasGlobChars(last)) {
    // A bare glob (`*`, `.*`) is relative to the working directory.
    parts[0] = ".";
    globbed = true;
  }
  let base = parts.join("/");
  if (base === "" && v.startsWith("/")) base = "/";
  const n = norm(seg, base, env);
  if (!n) return false;
  if (isApprovalRootTarget(n, env.path)) return true;
  return globbed && n.lexical === "/";
}

function anyRootTarget(seg: ShellSegment, targets: Array<{ value: string; expansion: boolean }>, env: ApprovalRuleEnv): boolean {
  return targets.some((t) => isRootishTarget(seg, t, env));
}

const CURL_VALUE_OPTS = new Set([
  "-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string",
  "-T", "--upload-file", "-X", "--request", "-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent",
  "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "--json", "-K", "--config", "--url", "-x", "--proxy",
  "-m", "--max-time", "--connect-timeout", "-w", "--write-out", "--resolve", "--cacert", "--cert", "--key", "-E",
]);
const FETCHERS = new Set(["curl", "wget", "fetch", "http", "https", "xh", "aria2c", "lynx", "links", "w3m", "nc", "ncat", "socat"]);
const STDIN_RUNNERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "python", "python2", "python3", "pypy",
  "node", "nodejs", "perl", "ruby", "php", "lua", "osascript", "bun", "deno", "pwsh", "source", ".", "eval",
]);

function curlUploads(seg: ShellSegment): boolean {
  const p = parseArgs(seg.argv, 1, CURL_VALUE_OPTS);
  const method = [...(p.values.get("-X") ?? []), ...(p.values.get("--request") ?? [])].map((m) => m.toUpperCase());
  if (method.some((m) => m !== "GET" && m !== "HEAD" && m !== "OPTIONS")) return true;
  const uploadOpts = ["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "-T", "--upload-file", "--json"];
  return uploadOpts.some((o) => p.values.has(o) || p.long.has(o));
}

function wgetUploads(seg: ShellSegment): boolean {
  return seg.argv.some((a) => startsWithAny(a, ["--post-data", "--post-file", "--body-data", "--body-file", "--method"]));
}

/** A command that can send data off the machine. */
function isNetworkSink(seg: ShellSegment): boolean {
  const cmd = seg.cmd;
  const dynamic = seg.args.slice(1).some((a) => a.expansion);
  switch (cmd) {
    case "curl":
      return curlUploads(seg) || dynamic;
    case "wget":
      return wgetUploads(seg) || dynamic;
    case "http": case "https": case "xh":
      return seg.argv.slice(1).some((a) => /^(POST|PUT|PATCH)$/i.test(a) || a.includes("=") || a.startsWith("@")) || dynamic;
    case "nc": case "ncat": case "netcat": case "socat": case "telnet": case "scp": case "sftp": case "ftp": case "ssh":
      return true;
    case "rsync":
      return seg.argv.slice(1).some((a) => /^[^/-][^/]*:/.test(a));
    case "aws":
      return (seg.argv.includes("s3") && seg.argv.some((a) => a.startsWith("s3://"))) || dynamic;
    case "gh":
      return seg.argv[1] === "gist" && seg.argv[2] === "create";
    case "dig": case "nslookup": case "host": case "ping": case "open":
      return dynamic;
    default:
      return false;
  }
}

const KEYCHAIN_SECURITY = new Set(["find-generic-password", "find-internet-password", "dump-keychain", "export", "export-identities"]);

function keychainReason(seg: ShellSegment): string | null {
  const a = seg.argv;
  switch (seg.cmd) {
    case "security":
      if (a[1] && KEYCHAIN_SECURITY.has(a[1])) return `security ${a[1]} reads keychain secrets`;
      return null;
    case "op":
      if (a[1] === "read" || a[1] === "inject" || (a[1] === "item" && a[2] === "get") || (a[1] === "document" && a[2] === "get")) return "1Password CLI reads a secret";
      return null;
    case "pass":
    case "gopass": {
      const sub = a[1];
      if (!sub || sub === "show" || sub === "-c" || sub === "--clip" || (!sub.startsWith("-") && !["ls", "list", "find", "search", "init", "insert", "generate", "edit", "rm", "mv", "cp", "git", "help", "version", "grep"].includes(sub))) return "pass shows a stored password";
      return null;
    }
    case "gpg":
      return a.some((x) => x.startsWith("--export-secret")) ? "exports private GPG keys" : null;
    case "git":
      return a.includes("credential") && (a.includes("fill") || a.includes("get")) ? "git credential fill reveals a stored credential" : null;
    case "gh":
      return a[1] === "auth" && a[2] === "token" ? "gh auth token prints the GitHub token" : null;
    case "bw":
      return a[1] === "get" || a[1] === "export" ? "Bitwarden CLI reads a secret" : null;
    case "lpass":
      return a[1] === "show" || a[1] === "export" ? "LastPass CLI reads a secret" : null;
    case "vault":
      return (a[1] === "read" || (a[1] === "kv" && a[2] === "get")) ? "Vault CLI reads a secret" : null;
    case "doppler":
      return a[1] === "secrets" ? "Doppler CLI reads secrets" : null;
    case "kubectl":
    case "oc":
      return null;
    default:
      return null;
  }
}

function isSecretSourceSegment(seg: ShellSegment, env: ApprovalRuleEnv): boolean {
  const cmd = seg.cmd;
  if ((cmd === "env" || cmd === "printenv") && seg.argv.length <= 2) return true;
  if ((cmd === "set" || cmd === "export" || cmd === "declare" || cmd === "typeset") && (seg.argv.length === 1 || seg.argv[1] === "-p" || seg.argv[1] === "-x")) return true;
  if (cmd === "history" || cmd === "fc") return true;
  if (keychainReason(seg)) return true;
  for (const c of segmentReadCandidates(seg)) {
    const n = norm(seg, c, env);
    if (n && (approvalPathMatches(n, env.read) || approvalPathMatches(n, env.history))) return true;
  }
  return false;
}

function isStdinRunner(seg: ShellSegment): boolean {
  if (!STDIN_RUNNERS.has(seg.cmd)) return false;
  if (seg.cmd === "eval" || seg.cmd === "source" || seg.cmd === ".") return false;
  const positional = seg.argv.slice(1).filter((a) => !a.startsWith("-") && !a.startsWith("+"));
  return positional.length === 0 || seg.argv.includes("-") || seg.argv.includes("/dev/stdin");
}

function gitSub(argv: readonly string[]): { sub: string; rest: string[] } {
  const i = subcommandIndex(argv, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]));
  return i === -1 ? { sub: "", rest: [] } : { sub: argv[i]!, rest: argv.slice(i + 1) };
}

const KUBE_GLOBAL_VALUE_OPTS = new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--token", "--as", "--as-group", "--request-timeout", "-v", "--certificate-authority", "--client-certificate", "--client-key"]);

function kubeSub(argv: readonly string[]): { sub: string; rest: string[] } {
  const i = subcommandIndex(argv, KUBE_GLOBAL_VALUE_OPTS);
  return i === -1 ? { sub: "", rest: [] } : { sub: argv[i]!, rest: argv.slice(i + 1) };
}

const SQL_DROP = /\b(DROP\s+(TABLE|DATABASE|SCHEMA|COLLECTION|INDEX|VIEW)|TRUNCATE(\s+TABLE)?\s|DROPDATABASE\s*\(|\.DROP\s*\()/i;

function sqlDestroys(text: string): boolean {
  if (SQL_DROP.test(text)) return true;
  if (/dropDatabase\s*\(/.test(text)) return true;
  // DELETE FROM without WHERE before the end of the statement.
  const upper = text.toUpperCase();
  let from = 0;
  for (;;) {
    const at = upper.indexOf("DELETE FROM", from);
    if (at === -1) return false;
    let end = upper.indexOf(";", at);
    if (end === -1) end = upper.length;
    if (!upper.slice(at, end).includes("WHERE")) return true;
    from = at + 11;
  }
}

const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX|TRUNCATE)\b|PRAGMA\s+\w+\s*=|^\s*\.(shell|system|restore|import|read|clone|save|once|output|backup)\b/im;

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlite", "mongosh", "mongo", "cockroach", "clickhouse-client", "duckdb", "pgcli", "mycli"]);

function segmentText(seg: ShellSegment): string {
  return [...seg.argv.slice(1), seg.stdinText ?? ""].join(" ");
}

function writesTo(seg: ShellSegment, env: ApprovalRuleEnv, test: (n: NormalizedApprovalPath, raw: string) => boolean): string | null {
  for (const t of segmentWriteTargets(seg)) {
    const n = norm(seg, t, env);
    if (n && test(n, t)) return t;
  }
  return null;
}

function mentionsGatewayPort(seg: ShellSegment, port: number): boolean {
  const p = String(port);
  return seg.argv.slice(1).some((a) => a === p || a.includes(`:${p}`));
}

const GATEWAY_MUTATING = ["/restart", "/shutdown", "/config/reload", "/channels/", "/api/", "/webhooks"];

// ── Segment rules ─────────────────────────────────────────────────────────

export const APPROVAL_RULES: readonly ApprovalRule[] = [
  // Hardline: deny in every mode.
  {
    id: "hard.rm-root",
    group: "hardline",
    severity: "hardline",
    description: "Recursive delete of /, the home folder, /Users or a system root",
    commands: ["rm"],
    check(seg, env) {
      const info = rmInfo(seg);
      if (info.noPreserveRoot) return "rm --no-preserve-root";
      if (info.recursive && anyRootTarget(seg, info.targets, env)) return "recursive delete of a root folder";
      return null;
    },
  },
  {
    id: "hard.disk",
    group: "hardline",
    severity: "hardline",
    description: "Disk formatting or raw device writes (mkfs, newfs, diskutil erase, dd to /dev/disk)",
    check(seg) {
      const cmd = seg.cmd;
      if (cmd.startsWith("mkfs") || cmd.startsWith("newfs") || cmd === "wipefs") return `${cmd} formats a disk`;
      if (cmd === "diskutil") {
        const sub = lower(seg.argv[1] ?? "");
        if (["erasedisk", "erasevolume", "partitiondisk", "secureerase", "zerodisk", "randomdisk", "reformat"].includes(sub)) return `diskutil ${seg.argv[1]} erases a disk`;
        if (sub === "apfs" && ["deletecontainer", "deletevolume", "erasevolume"].includes(lower(seg.argv[2] ?? ""))) return `diskutil apfs ${seg.argv[2]} erases a disk`;
      }
      if (cmd === "dd" && seg.argv.some((a) => a.startsWith("of=/dev/") && isApprovalRawDevice(a.slice(3)))) return "dd writes to a raw disk";
      if (segmentWriteTargets(seg).some((t) => isApprovalRawDevice(t))) return "writes to a raw disk device";
      return null;
    },
  },
  {
    id: "hard.perm-root",
    group: "hardline",
    severity: "hardline",
    description: "Recursive chmod or chown of a root folder",
    commands: ["chmod", "chown", "chgrp"],
    check(seg, env) {
      const p = parseArgs(seg.argv, 1, new Set(["--reference"]));
      if (!(p.short.has("R") || p.long.has("--recursive"))) return null;
      const targets = p.positionals.slice(1).map((value) => ({ value, expansion: false }));
      return anyRootTarget(seg, targets, env) ? `recursive ${seg.cmd} of a root folder` : null;
    },
  },

  // Files
  {
    id: "fs.rm-recursive",
    group: "files",
    severity: "dangerous",
    description: "Recursive delete (rm -r, rm -rf)",
    commands: ["rm"],
    check(seg) {
      return rmInfo(seg).recursive ? "recursive delete" : null;
    },
  },
  {
    id: "fs.find-delete",
    group: "files",
    severity: "dangerous",
    description: "find with -delete or -exec rm",
    commands: ["find"],
    check(seg) {
      if (seg.argv.includes("-delete")) return "find -delete removes every match";
      for (let i = 0; i < seg.argv.length; i++) {
        if (["-exec", "-execdir", "-ok", "-okdir"].includes(seg.argv[i]!) && ["rm", "unlink", "shred", "srm", "rmdir"].includes(basename(seg.argv[i + 1] ?? ""))) {
          return "find runs rm on every match";
        }
      }
      return null;
    },
  },
  {
    id: "fs.xargs-rm",
    group: "files",
    severity: "dangerous",
    description: "xargs feeding rm (the files are only known at run time)",
    commands: ["rm", "unlink", "shred", "srm", "rmdir"],
    check(seg) {
      return seg.via === "xargs" ? "xargs runs rm on its input" : null;
    },
  },
  {
    id: "fs.shred",
    group: "files",
    severity: "dangerous",
    description: "shred, srm, or truncate to zero",
    commands: ["shred", "srm", "truncate"],
    check(seg) {
      if (seg.cmd !== "truncate") return `${seg.cmd} destroys file contents`;
      const p = parseArgs(seg.argv, 1, new Set(["-s", "--size"]));
      const size = [...(p.values.get("-s") ?? []), ...(p.values.get("--size") ?? [])];
      return size.some((s) => s === "0" || s === "-0" || /^0[KMGTkmgt]?$/.test(s)) ? "truncate empties files" : null;
    },
  },
  {
    id: "fs.system-write",
    group: "files",
    severity: "dangerous",
    description: "Writes into /etc, /System, /Library or /usr (not /usr/local)",
    check(seg, env) {
      const t = writesTo(seg, env, (n) => isApprovalSystemPath(n));
      return t ? `writes to the system path ${t}` : null;
    },
  },
  {
    id: "fs.perm-wide",
    group: "files",
    severity: "dangerous",
    description: "Recursive chmod to world-writable modes, or recursive chown",
    commands: ["chmod", "chown", "chgrp"],
    check(seg) {
      const p = parseArgs(seg.argv, 1, new Set(["--reference"]));
      if (!(p.short.has("R") || p.long.has("--recursive"))) return null;
      if (seg.cmd !== "chmod") return `recursive ${seg.cmd}`;
      const mode = p.positionals[0] ?? "";
      if (/^[0-7]?[0-7][0-7][2367]$/.test(mode) || /(^|,)[ugo]*[ao][ugo]*\+[rwxXst]*w/.test(mode)) return `recursive chmod ${mode}`;
      return null;
    },
  },
  {
    id: "fs.protected-write",
    group: "files",
    severity: "dangerous",
    description: "Writes to a protected path (SSH keys, shell rc files, LaunchAgents, Kirie's own config and state)",
    check(seg, env) {
      const t = writesTo(seg, env, (n) => approvalPathMatches(n, env.write));
      return t ? `writes to the protected path ${t}` : null;
    },
  },

  // Git and GitHub
  {
    id: "git.force-push",
    group: "git",
    severity: "dangerous",
    description: "git push that rewrites or deletes remote history (--force, -f, --force-with-lease, --mirror, --delete, +refspec)",
    commands: ["git"],
    check(seg) {
      const { sub, rest } = gitSub(seg.argv);
      if (sub !== "push") return null;
      for (const a of rest) {
        if (a === "--force" || a.startsWith("--force-with-lease") || a === "--force-if-includes" || a === "--mirror" || a === "--delete" || a === "--prune") return `git push ${a}`;
        if (/^-[a-zA-Z]+$/.test(a) && (a.includes("f") || a.includes("d"))) return `git push ${a}`;
        if (!a.startsWith("-") && (a.startsWith("+") || a.startsWith(":"))) return `git push ${a} rewrites or deletes a remote branch`;
      }
      return null;
    },
  },
  {
    id: "git.destroy",
    group: "git",
    severity: "dangerous",
    description: "git commands that destroy local work or history (reset --hard, clean -f, branch -D, filter-branch, reflog expire, stash clear)",
    commands: ["git"],
    check(seg) {
      const { sub, rest } = gitSub(seg.argv);
      switch (sub) {
        case "reset":
          return rest.includes("--hard") ? "git reset --hard discards changes" : null;
        case "clean":
          return rest.some((a) => a === "--force" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f"))) ? "git clean -f deletes untracked files" : null;
        case "branch":
          return rest.some((a) => a === "-D" || (/^-[a-zA-Z]+$/.test(a) && a.includes("D"))) || (rest.includes("--delete") && rest.includes("--force")) ? "git branch -D deletes unmerged branches" : null;
        case "filter-branch":
        case "filter-repo":
          return `git ${sub} rewrites history`;
        case "reflog":
          return rest[0] === "expire" || rest[0] === "delete" ? `git reflog ${rest[0]} drops recovery points` : null;
        case "stash":
          return rest[0] === "clear" ? "git stash clear drops all stashes" : null;
        case "update-ref":
          return rest.includes("-d") ? "git update-ref -d deletes a ref" : null;
        default:
          return null;
      }
    },
  },
  {
    id: "gh.destroy",
    group: "git",
    severity: "dangerous",
    description: "GitHub CLI deletes and admin actions (repo delete, release delete, secret set, api -X DELETE, pr merge --admin, visibility)",
    commands: ["gh"],
    check(seg) {
      const a = seg.argv;
      if (a[1] === "repo" && (a[2] === "delete" || a[2] === "archive")) return `gh repo ${a[2]}`;
      if (a[1] === "repo" && a[2] === "edit" && a.some((x) => x.startsWith("--visibility"))) return "gh repo edit --visibility";
      if (a[1] === "release" && a[2] === "delete") return "gh release delete";
      if ((a[1] === "secret" || a[1] === "variable") && ["set", "delete", "remove"].includes(a[2] ?? "")) return `gh ${a[1]} ${a[2]}`;
      if (a[1] === "pr" && a[2] === "merge" && a.includes("--admin")) return "gh pr merge --admin bypasses branch protection";
      if (a[1] === "api") {
        const p = parseArgs(a, 2, new Set(["-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "--input", "-q", "--jq", "-t", "--template"]));
        const m = [...(p.values.get("-X") ?? []), ...(p.values.get("--method") ?? [])].map((x) => x.toUpperCase());
        if (m.some((x) => x === "DELETE" || x === "PUT" || x === "PATCH")) return `gh api -X ${m.join(",")}`;
      }
      return null;
    },
  },

  // Kubernetes and Helm
  {
    id: "k8s.delete",
    group: "kubernetes",
    severity: "dangerous",
    description: "kubectl delete",
    commands: ["kubectl", "oc", "kubecolor"],
    check(seg) {
      return kubeSub(seg.argv).sub === "delete" ? "kubectl delete removes cluster resources" : null;
    },
  },
  {
    id: "k8s.disrupt",
    group: "kubernetes",
    severity: "dangerous",
    description: "kubectl drain, cordon, replace --force, scale to zero, rollout undo, apply --prune",
    commands: ["kubectl", "oc", "kubecolor"],
    check(seg) {
      const { sub, rest } = kubeSub(seg.argv);
      if (sub === "drain" || sub === "cordon") return `kubectl ${sub}`;
      if (sub === "replace" && rest.includes("--force")) return "kubectl replace --force";
      if (sub === "scale" && (rest.includes("--replicas=0") || rest.some((a, i) => a === "--replicas" && rest[i + 1] === "0"))) return "kubectl scale to zero replicas";
      if (sub === "rollout" && rest[0] === "undo") return "kubectl rollout undo";
      if (sub === "apply" && rest.some((a) => a === "--prune" || a.startsWith("--prune="))) return "kubectl apply --prune deletes resources";
      return null;
    },
  },
  {
    id: "k8s.secret-read",
    group: "kubernetes",
    severity: "dangerous",
    description: "kubectl get secret with an output format (prints secret values)",
    commands: ["kubectl", "oc", "kubecolor"],
    check(seg) {
      const { sub, rest } = kubeSub(seg.argv);
      if (sub !== "get") return null;
      const target = rest.find((a) => !a.startsWith("-")) ?? "";
      const isSecret = target.split(",").some((t) => /^secrets?(\/|$)/.test(t));
      const output = rest.some((a) => a === "-o" || a.startsWith("-o") || a.startsWith("--output"));
      return isSecret && output ? "prints Kubernetes secret values" : null;
    },
  },
  {
    id: "k8s.context",
    group: "kubernetes",
    severity: "dangerous",
    description: "kubectl config delete-context, delete-cluster, delete-user, unset",
    commands: ["kubectl", "oc", "kubecolor"],
    check(seg) {
      const { sub, rest } = kubeSub(seg.argv);
      if (sub !== "config") return null;
      const op = rest[0] ?? "";
      return op.startsWith("delete-") || op === "unset" ? `kubectl config ${op}` : null;
    },
  },
  {
    id: "helm.destroy",
    group: "kubernetes",
    severity: "dangerous",
    description: "helm uninstall, delete, rollback, upgrade --force",
    commands: ["helm"],
    check(seg) {
      const i = subcommandIndex(seg.argv, new Set(["-n", "--namespace", "--kube-context", "--kubeconfig"]));
      const sub = i === -1 ? "" : seg.argv[i]!;
      if (["uninstall", "delete", "del", "un", "rollback"].includes(sub)) return `helm ${sub}`;
      if (sub === "upgrade" && seg.argv.includes("--force")) return "helm upgrade --force";
      return null;
    },
  },

  // Infra and cloud
  {
    id: "tf.destroy",
    group: "infra",
    severity: "dangerous",
    description: "terraform/tofu destroy, apply -auto-approve, state rm|mv|push",
    commands: ["terraform", "tofu", "terragrunt"],
    check(seg) {
      const i = subcommandIndex(seg.argv, EMPTY);
      const sub = i === -1 ? "" : seg.argv[i]!;
      const rest = i === -1 ? [] : seg.argv.slice(i + 1);
      if (sub === "destroy") return `${seg.cmd} destroy`;
      if (sub === "apply" && rest.some((a) => a === "-auto-approve" || a === "--auto-approve" || a === "-destroy")) return `${seg.cmd} apply ${rest.find((a) => a.includes("auto-approve") || a === "-destroy")}`;
      if (sub === "state" && ["rm", "mv", "push", "replace-provider"].includes(rest[0] ?? "")) return `${seg.cmd} state ${rest[0]}`;
      if (sub === "workspace" && rest[0] === "delete") return `${seg.cmd} workspace delete`;
      if (sub === "force-unlock") return `${seg.cmd} force-unlock`;
      return null;
    },
  },
  {
    id: "pulumi.destroy",
    group: "infra",
    severity: "dangerous",
    description: "pulumi destroy, pulumi stack rm",
    commands: ["pulumi"],
    check(seg) {
      const a = seg.argv;
      if (a[1] === "destroy" || a[1] === "down") return `pulumi ${a[1]}`;
      if (a[1] === "stack" && a[2] === "rm") return "pulumi stack rm";
      return null;
    },
  },
  {
    id: "cloud.delete",
    group: "infra",
    severity: "dangerous",
    description: "Cloud CLI deletes (aws delete-*/terminate-*/s3 rb/s3 rm --recursive, gcloud/az/doctl/hcloud delete, gsutil rm -r)",
    commands: ["aws", "gcloud", "az", "doctl", "hcloud", "gsutil", "flyctl", "fly", "vercel", "heroku"],
    check(seg) {
      const a = seg.argv.slice(1);
      if (seg.cmd === "aws") {
        const verb = a.find((x) => x.startsWith("delete-") || x.startsWith("terminate-"));
        if (verb) return `aws ${verb}`;
        const s3 = a.indexOf("s3");
        if (s3 !== -1 && a[s3 + 1] === "rb") return "aws s3 rb";
        if (s3 !== -1 && a[s3 + 1] === "rm" && a.includes("--recursive")) return "aws s3 rm --recursive";
        return null;
      }
      if (seg.cmd === "gsutil") {
        if (a[0] === "rb") return "gsutil rb";
        if (a[0] === "rm" && a.some((x) => x === "-r" || x === "-R" || x === "-a")) return "gsutil rm -r";
        return null;
      }
      const verbs = ["delete", "destroy", "remove", "rm", "destroy-cluster"];
      const hit = a.find((x) => !x.startsWith("-") && verbs.includes(x));
      return hit ? `${seg.cmd} ${hit}` : null;
    },
  },

  // Containers
  {
    id: "docker.destroy",
    group: "containers",
    severity: "dangerous",
    description: "docker system prune, volume rm|prune, rm -f, compose down -v, image prune -a",
    commands: ["docker", "podman", "nerdctl", "docker-compose", "podman-compose"],
    check(seg) {
      const a = seg.argv.slice(1).filter((x) => !(x === "-H" || x.startsWith("--host") || x.startsWith("--context")));
      const compose = seg.cmd.endsWith("-compose") ? a : a[0] === "compose" ? a.slice(1) : null;
      if (compose) {
        const sub = compose.find((x) => !x.startsWith("-"));
        if (sub === "down" && compose.some((x) => x === "-v" || x === "--volumes" || x.startsWith("--rmi"))) return "compose down removes volumes";
        if (sub === "rm" && compose.some((x) => x === "-f" || x === "--force" || x === "-v")) return "compose rm";
        return null;
      }
      const sub = a[0];
      if (sub === "system" && a[1] === "prune") return "docker system prune";
      if (sub === "volume" && (a[1] === "rm" || a[1] === "prune")) return `docker volume ${a[1]}`;
      if ((sub === "rm" || sub === "rmi") && a.some((x) => x === "-f" || x === "--force" || (/^-[a-z]+$/.test(x) && x.includes("f")))) return `docker ${sub} -f`;
      if ((sub === "image" || sub === "container" || sub === "network" || sub === "builder") && a[1] === "prune") return `docker ${sub} prune`;
      return null;
    },
  },
  {
    id: "docker.escape",
    group: "containers",
    severity: "dangerous",
    description: "docker run with --privileged, the host root mounted, the docker socket mounted, or host namespaces",
    commands: ["docker", "podman", "nerdctl"],
    check(seg) {
      const a = seg.argv.slice(1);
      if (a[0] !== "run" && a[0] !== "create" && !(a[0] === "container" && (a[1] === "run" || a[1] === "create"))) return null;
      for (let i = 0; i < a.length; i++) {
        const x = a[i]!;
        if (x === "--privileged" || x === "--privileged=true") return "docker run --privileged";
        if (x.startsWith("--pid=host") || x.startsWith("--ipc=host") || x.startsWith("--userns=host") || x === "--cap-add=ALL" || x === "--cap-add=SYS_ADMIN") return `docker run ${x}`;
        const vol = x === "-v" || x === "--volume" || x === "--mount" ? (a[i + 1] ?? "") : x.startsWith("--volume=") || x.startsWith("--mount=") ? x.slice(x.indexOf("=") + 1) : x.startsWith("-v") && x.length > 2 ? x.slice(2) : null;
        if (vol !== null) {
          const src = vol.includes("source=") || vol.includes("src=") ? (vol.split(",").find((p) => p.startsWith("source=") || p.startsWith("src="))?.split("=")[1] ?? "") : vol.split(":")[0]!;
          if (src === "/" || src.includes("docker.sock")) return `mounts ${src} into the container`;
        }
      }
      return null;
    },
  },

  // Databases
  {
    id: "db.destroy",
    group: "databases",
    severity: "dangerous",
    description: "SQL DROP, TRUNCATE, DELETE without WHERE; redis FLUSHALL/FLUSHDB; dropdb",
    commands: [...DB_CLIENTS, "redis-cli", "dropdb", "dropuser", "mongorestore"],
    check(seg) {
      if (seg.cmd === "dropdb") return "dropdb";
      if (seg.cmd === "dropuser") return "dropuser";
      if (seg.cmd === "mongorestore") return seg.argv.includes("--drop") ? "mongorestore --drop" : null;
      const text = segmentText(seg);
      if (seg.cmd === "redis-cli") return /\bFLUSH(ALL|DB)\b/i.test(text) ? "redis FLUSHALL/FLUSHDB" : null;
      return sqlDestroys(text) ? "destructive SQL statement" : null;
    },
  },

  // System
  {
    id: "sys.sudo",
    group: "system",
    severity: "dangerous",
    description: "sudo, doas, su -c (runs as another user)",
    check(seg) {
      return seg.sudo && seg.wrappers.some((w) => w === "sudo" || w === "doas" || w === "su" || w === "pkexec" || w === "run0") ? `runs with ${seg.wrappers.find((w) => ["sudo", "doas", "su", "pkexec", "run0"].includes(w))}` : seg.cmd === "sudoedit" ? "sudoedit" : null;
    },
  },
  {
    id: "sys.service",
    group: "system",
    severity: "dangerous",
    description: "Service control and power (launchctl bootout/unload, systemctl stop, shutdown, reboot)",
    commands: ["launchctl", "systemctl", "service", "shutdown", "reboot", "halt", "poweroff", "init", "telinit"],
    check(seg) {
      const a = seg.argv;
      if (seg.cmd === "launchctl") {
        if (["bootout", "unload", "remove", "disable", "kill", "stop"].includes(a[1] ?? "")) return `launchctl ${a[1]}`;
        if (a[1] === "kickstart" && a.includes("-k")) return "launchctl kickstart -k restarts a service";
        return null;
      }
      if (seg.cmd === "systemctl") {
        const sub = a.slice(1).find((x) => !x.startsWith("-")) ?? "";
        return ["stop", "disable", "mask", "kill", "poweroff", "reboot", "halt", "isolate"].includes(sub) ? `systemctl ${sub}` : null;
      }
      if (seg.cmd === "service") return ["stop", "restart"].includes(a[2] ?? "") ? `service ${a[1]} ${a[2]}` : null;
      if (seg.cmd === "init" || seg.cmd === "telinit") return ["0", "6"].includes(a[1] ?? "") ? `${seg.cmd} ${a[1]}` : null;
      return `${seg.cmd} stops the machine`;
    },
  },
  {
    id: "sys.kill-kirie",
    group: "system",
    severity: "dangerous",
    description: "Killing the Kirie daemon (kill/pkill/killall aimed at kirie or node, kill -1)",
    commands: ["kill", "pkill", "killall", "killall5", "launchctl"],
    check(seg) {
      const text = lower(seg.raw + " " + seg.argv.join(" "));
      const aimed = text.includes("kirie") || text.includes("codingjet");
      if (seg.cmd === "launchctl") return aimed && ["kickstart", "bootout", "unload", "kill", "stop", "remove"].includes(seg.argv[1] ?? "") ? "stops or restarts Kirie's launchd job" : null;
      if (seg.cmd === "killall5") return "killall5 kills every process";
      if (aimed) return `${seg.cmd} aimed at Kirie`;
      const targets = seg.argv.slice(1).filter((x) => !x.startsWith("-") || x === "-1");
      if (seg.cmd === "kill" && targets.includes("-1")) return "kill -1 kills every process";
      if ((seg.cmd === "pkill" || seg.cmd === "killall") && targets.some((t) => t === "node" || t === "Node")) return `${seg.cmd} node kills the Kirie daemon`;
      return null;
    },
  },
  {
    id: "sys.persist",
    group: "system",
    severity: "dangerous",
    description: "Persistence (crontab edits, launchctl load/bootstrap, writes under LaunchAgents)",
    check(seg, env) {
      if (seg.cmd === "crontab") return seg.argv.slice(1).every((a) => a === "-l") && seg.argv.length > 1 ? null : "crontab edit";
      if (seg.cmd === "launchctl" && ["load", "bootstrap", "enable", "submit"].includes(seg.argv[1] ?? "")) return `launchctl ${seg.argv[1]}`;
      if (seg.cmd === "at" || seg.cmd === "batch") return `${seg.cmd} schedules a command`;
      const t = writesTo(seg, env, (n) => /\/library\/launch(agents|daemons)(\/|$)/i.test(n.lexical) || /\/library\/launch(agents|daemons)(\/|$)/i.test(n.real));
      return t ? `writes to ${t}` : null;
    },
  },
  {
    id: "sys.macos",
    group: "system",
    severity: "dangerous",
    description: "macOS control (osascript, defaults write, tccutil reset, spctl disable, csrutil, nvram)",
    commands: ["osascript", "defaults", "tccutil", "spctl", "csrutil", "nvram", "dscl", "sysadminctl", "systemsetup", "pmset"],
    check(seg) {
      const a = seg.argv;
      switch (seg.cmd) {
        case "osascript": return "osascript can drive any app";
        case "defaults": return ["write", "delete", "import"].includes(a[1] ?? "") ? `defaults ${a[1]}` : null;
        case "tccutil": return a[1] === "reset" ? "tccutil reset" : null;
        case "spctl": return a.some((x) => x.includes("disable")) ? "spctl disables Gatekeeper" : null;
        case "csrutil": return a[1] && a[1] !== "status" ? `csrutil ${a[1]}` : null;
        case "nvram": return a.length > 1 && !(a.length === 2 && (a[1] === "-p" || a[1] === "-x")) ? "nvram changes firmware variables" : null;
        case "dscl": return a.some((x) => ["-create", "-delete", "-passwd", "-append", "-merge", "-change"].includes(x)) ? "dscl changes users or groups" : null;
        case "sysadminctl": return a.some((x) => ["-addUser", "-deleteUser", "-resetPasswordFor", "-adminUser"].includes(x)) ? "sysadminctl changes users" : null;
        case "systemsetup": return a.some((x) => x.startsWith("-set")) ? "systemsetup changes system settings" : null;
        default: return null;
      }
    },
  },
  {
    id: "sys.desktop",
    group: "system",
    severity: "dangerous",
    description: "Desktop control and screen capture (cua-driver, cliclick, screencapture)",
    commands: ["cua-driver", "cliclick", "screencapture"],
    check(seg) {
      return `${seg.cmd} controls or captures the desktop`;
    },
  },

  // Publishing
  {
    id: "pub.release",
    group: "publishing",
    severity: "dangerous",
    description: "Publishing packages or images (npm publish, cargo publish, docker push, gem push, twine upload)",
    commands: ["npm", "pnpm", "yarn", "bun", "cargo", "docker", "podman", "gem", "twine", "poetry", "flit", "uv", "vsce", "ovsx"],
    check(seg) {
      const a = seg.argv.slice(1).filter((x) => !x.startsWith("-"));
      const sub = a[0] ?? "";
      if (["npm", "pnpm", "yarn", "bun"].includes(seg.cmd)) {
        if (sub === "publish" || sub === "unpublish" || (sub === "npm" && a[1] === "publish")) return `${seg.cmd} ${sub}`;
        return null;
      }
      if (seg.cmd === "cargo" || seg.cmd === "poetry" || seg.cmd === "flit" || seg.cmd === "uv" || seg.cmd === "vsce" || seg.cmd === "ovsx") return sub === "publish" ? `${seg.cmd} publish` : null;
      if (seg.cmd === "docker" || seg.cmd === "podman") return sub === "push" || (sub === "image" && a[1] === "push") ? `${seg.cmd} push` : null;
      if (seg.cmd === "gem") return sub === "push" ? "gem push" : null;
      if (seg.cmd === "twine") return sub === "upload" ? "twine upload" : null;
      return null;
    },
  },

  // Secrets
  {
    id: "secret.read",
    group: "secrets",
    severity: "dangerous",
    description: "Reads a protected secret path (SSH keys, cloud credentials, .env, Kirie's secrets and credentials)",
    check(seg, env) {
      const candidates = segmentReadCandidates(seg);
      const recursive = isRecursiveRead(seg);
      for (const c of candidates.slice(0, 2000)) {
        const n = norm(seg, c, env);
        if (!n) continue;
        if (approvalPathMatches(n, env.read)) return `reads the protected path ${c}`;
        if (recursive && approvalPathIsAncestorOf(n, env.read)) return `${seg.cmd} reads recursively through ${c}, which holds protected files`;
      }
      return null;
    },
  },
  {
    id: "secret.keychain",
    group: "secrets",
    severity: "dangerous",
    description: "Keychain and password-manager reads (security find-*-password, op read, pass show, gpg --export-secret-keys, git credential fill)",
    commands: ["security", "op", "pass", "gopass", "gpg", "git", "gh", "bw", "lpass", "vault", "doppler"],
    check(seg) {
      return keychainReason(seg);
    },
  },

  // Kirie itself
  {
    id: "kirie.control",
    group: "kirie",
    severity: "dangerous",
    description: "Changes Kirie's own control files or calls its control plane (config.yaml, state/, *.sh, sqlite3 writes on its databases, mutating gateway routes)",
    check(seg, env) {
      const t = writesTo(seg, env, (n) => approvalPathMatches(n, env.kirieControl));
      if (t) return `writes to Kirie's control file ${t}`;
      if (seg.cmd === "sqlite3" || seg.cmd === "sqlite") {
        const p = parseArgs(seg.argv, 1, new Set(["-cmd", "-separator", "-newline", "-nullvalue", "-init", "-vfs"]));
        const dbIdx = p.positionals.findIndex((x) => {
          const n = norm(seg, x, env);
          return n !== null && approvalPathMatches(n, env.kirieDb);
        });
        if (dbIdx !== -1) {
          const sql = [...p.positionals.slice(dbIdx + 1), ...(p.values.get("-cmd") ?? []), seg.stdinText ?? ""].join("\n");
          const readonly = seg.argv.includes("-readonly");
          if (/^\s*\.(shell|system)\b/m.test(sql)) return "sqlite3 .shell on a Kirie database";
          if (!readonly && (sql.trim() === "" || SQL_WRITE.test(sql))) return "sqlite3 may write to a Kirie database";
        }
      }
      if (FETCHERS.has(seg.cmd) || seg.cmd === "telnet" || seg.cmd === "netcat") {
        if (!mentionsGatewayPort(seg, env.gatewayPort)) return null;
        if (seg.cmd === "nc" || seg.cmd === "ncat" || seg.cmd === "netcat" || seg.cmd === "socat" || seg.cmd === "telnet") return "raw connection to Kirie's control plane";
        const text = seg.argv.slice(1).join(" ");
        if (GATEWAY_MUTATING.some((r) => text.includes(r))) return "calls a mutating route on Kirie's control plane";
        if ((seg.cmd === "curl" && curlUploads(seg)) || (seg.cmd === "wget" && wgetUploads(seg))) return "sends a write request to Kirie's control plane";
      }
      return null;
    },
  },
];

// ── Whole-command rules ───────────────────────────────────────────────────

export const APPROVAL_COMMAND_RULES: readonly ApprovalCommandRule[] = [
  {
    id: "hard.forkbomb",
    group: "hardline",
    severity: "hardline",
    description: "Fork bomb (:(){ :|:& };: and named variants)",
    check(parsed) {
      return parsed.forkBomb ? [{ reason: "fork bomb" }] : [];
    },
  },
  {
    id: "net.pipe-shell",
    group: "remote-code",
    severity: "dangerous",
    description: "Downloaded content run as code (curl | sh, bash <(curl ..), eval \"$(curl ..)\")",
    check(parsed) {
      const out: Array<{ reason: string; segment?: number }> = [];
      const segs = parsed.segments;
      segs.forEach((seg, i) => {
        if (seg.stage > 0 && isStdinRunner(seg)) {
          const upstream = segs.find((s) => s.group === seg.group && s.stage < seg.stage && FETCHERS.has(s.cmd));
          if (upstream) out.push({ reason: `${upstream.cmd} output is piped into ${seg.cmd}`, segment: i });
        }
        if (seg.parent !== undefined && FETCHERS.has(seg.cmd) && (seg.via === "$()" || seg.via === "`" || seg.via === "<()")) {
          const parent = segs[seg.parent];
          if (parent && (STDIN_RUNNERS.has(parent.cmd) || parent.wrappers.includes("eval") || parent.wrappers.some((w) => STDIN_RUNNERS.has(w)))) {
            out.push({ reason: `${parent.cmd || parent.wrappers[parent.wrappers.length - 1]} runs content downloaded by ${seg.cmd}`, segment: seg.parent });
          }
        }
      });
      return out;
    },
  },
  {
    id: "secret.exfil",
    group: "secrets",
    severity: "dangerous",
    description: "A secret source and a network sink in one command (env | curl -d @-, cat ~/.ssh/id_* | nc ...)",
    check(parsed, env) {
      const sinkIndex = parsed.segments.findIndex((s) => isNetworkSink(s));
      if (sinkIndex === -1) return [];
      const source = parsed.segments.find((s) => isSecretSourceSegment(s, env));
      return source ? [{ reason: `${source.cmd || "a secret source"} feeds ${parsed.segments[sinkIndex]!.cmd}, which sends data off the machine`, segment: sinkIndex }] : [];
    },
  },
];

/** Every built-in rule id with its group and description (for `/approvals rules`). */
export function approvalRuleCatalog(): Array<{ id: string; group: string; severity: "hardline" | "dangerous"; description: string }> {
  const all = [...APPROVAL_RULES, ...APPROVAL_COMMAND_RULES].map((r) => ({ id: r.id, group: r.group, severity: r.severity, description: r.description }));
  all.push(
    { id: "net.remote-exec", group: "remote-code", severity: "dangerous", description: "A remote command (ssh, kubectl exec, docker exec) that is itself dangerous or unreadable" },
    { id: "fs.protected-write", group: "files", severity: "dangerous", description: "File tools (Write, Edit, MultiEdit, NotebookEdit) writing to a protected path" },
    { id: "mcp.sensitive", group: "tools", severity: "dangerous", description: "Sensitive tools: mcp_servers_add/remove, gateway_restart, voice_call_initiate, send_message or channel_action to a chat that is not the owner, approvals.mcpAsk" },
  );
  const seen = new Set<string>();
  return all.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Rules indexed by command, plus the rules that look at every segment. */
export function indexApprovalRules(rules: readonly ApprovalRule[]): { byCommand: Map<string, ApprovalRule[]>; generic: ApprovalRule[] } {
  const byCommand = new Map<string, ApprovalRule[]>();
  const generic: ApprovalRule[] = [];
  for (const r of rules) {
    if (!r.commands) { generic.push(r); continue; }
    for (const c of r.commands) {
      const list = byCommand.get(c) ?? [];
      list.push(r);
      byCommand.set(c, list);
    }
  }
  return { byCommand, generic };
}
