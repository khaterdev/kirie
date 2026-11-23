/**
 * Owner allow and deny patterns (PLAN C.9, R2 section 4 "Owner pattern syntax").
 *
 * - bare string: a glob over one normalized shell command (`git push --force*`,
 *   `kubectl delete *`, `pnpm *`). `*` is any run of characters, `?` one.
 * - `Tool(glob)`: a non-shell tool with a glob over its main argument; file
 *   tools compare normalized paths (`Write(~/.ssh/**)`, `Read(~/dev/**)`).
 *   `Edit(...)` covers every file-writing tool. `Bash(glob)` is the same as a
 *   bare string.
 * - `mcp__server__tool`: a glob over the tool name (`mcp__github__delete_*`).
 *
 * Limits: 200 characters per pattern, 200 patterns per list.
 */

import { basename } from "node:path";
import { matchApprovalGlob, matchApprovalPathGlob } from "./glob.js";
import { expandApprovalPattern, type ApprovalPathEnv, type NormalizedApprovalPath } from "./paths.js";
import { countHiddenShellChars, type ShellSegment } from "./shell-parse.js";

export const APPROVAL_PATTERN_MAX_LENGTH = 200;
export const APPROVAL_PATTERN_MAX_COUNT = 200;

export type ApprovalPattern =
  | { kind: "shell"; glob: string; source: string }
  | { kind: "tool"; tool: string; glob: string; source: string }
  | { kind: "mcp"; glob: string; source: string };

/** Tools whose main argument is a path. */
export const APPROVAL_PATH_TOOLS: Readonly<Record<string, string>> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Glob: "path",
  Grep: "path",
  LS: "path",
};

/** The main argument of other tools. */
const TOOL_PRIMARY_ARG: Readonly<Record<string, string>> = {
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
  Agent: "subagent_type",
  Task: "subagent_type",
};

export const APPROVAL_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export function parseApprovalPattern(input: string): ApprovalPattern | { error: string } {
  const source = input.trim();
  if (!source) return { error: "empty pattern" };
  if (source.length > APPROVAL_PATTERN_MAX_LENGTH) return { error: `longer than ${APPROVAL_PATTERN_MAX_LENGTH} characters` };
  if (countHiddenShellChars(source) > 0) return { error: "contains control or invisible characters" };
  if (source.startsWith("mcp__")) return { kind: "mcp", glob: source, source };
  const open = source.indexOf("(");
  if (open > 0 && /^[A-Z][A-Za-z]*$/.test(source.slice(0, open))) {
    if (!source.endsWith(")")) return { error: "a Tool( pattern must end with )" };
    const tool = source.slice(0, open);
    const glob = source.slice(open + 1, -1).trim();
    if (!glob) return { error: "empty glob inside Tool()" };
    if (tool === "Bash") return { kind: "shell", glob, source };
    return { kind: "tool", tool, glob, source };
  }
  return { kind: "shell", glob: source, source };
}

export function compileApprovalPatterns(list: readonly string[]): ApprovalPattern[] {
  const out: ApprovalPattern[] = [];
  for (const raw of list.slice(0, APPROVAL_PATTERN_MAX_COUNT)) {
    const p = parseApprovalPattern(raw);
    if (!("error" in p)) out.push(p);
  }
  return out;
}

const SHELLISH_PREFIXES = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish", "sudo", "doas", "su", "env", "eval", "exec", "xargs", "command", "builtin",
  "nohup", "timeout", "time", "nice", "watch", "python", "python3", "python2", "node", "perl", "ruby", "php", "deno",
  "bun", "osascript", "ssh", "source", ".", "busybox", "npx", "pnpx", "bunx",
]);

/**
 * True for allow patterns that match far too much (`*`, `bash *`, `sh -c *`,
 * `sudo *`, `python* -c *`, `Write(**)`, `mcp__*`). They are refused unless
 * the owner adds them with `--force` and confirms.
 */
export function isOverBroadAllowPattern(input: string): boolean {
  const p = parseApprovalPattern(input);
  if ("error" in p) return false;
  const literalPrefix = (glob: string): string => {
    const star = glob.search(/[*?]/);
    return (star === -1 ? glob : glob.slice(0, star)).trim();
  };
  if (p.kind === "mcp") {
    // Must name a server and the start of a tool: mcp__server__x*
    const parts = p.glob.split("__");
    const server = parts[1] ?? "";
    const tool = parts.slice(2).join("__");
    return parts.length < 3 || server === "" || /[*?]/.test(server) || tool === "" || /^[*?]/.test(tool);
  }
  if (p.kind === "tool") {
    const prefix = literalPrefix(p.glob);
    return prefix === "" || prefix === "/" || prefix === "~" || prefix === "~/" || prefix === "{kirie}" || prefix === "{kirie}/";
  }
  const prefix = literalPrefix(p.glob);
  if (prefix === "") return true;
  const first = prefix.split(/\s+/)[0]!.toLowerCase();
  const firstBase = basename(first);
  if (SHELLISH_PREFIXES.has(firstBase) || /^python[0-9.]*$/.test(firstBase)) return true;
  // A prefix that ends inside the command word ("r*", "git*") matches unrelated commands.
  return !/\s/.test(prefix) && p.glob.length > prefix.length && /^[*?]/.test(p.glob.slice(prefix.length)) && prefix.length < 2;
}

function cmdWord(word: string): string {
  let w = word;
  while (w.startsWith("\\")) w = w.slice(1);
  return basename(w);
}

/** The two forms a shell pattern is matched against: without wrappers, and with them. */
export function approvalSegmentForms(seg: ShellSegment): { normalized: string; full: string } {
  const normalized = seg.argv.length > 0 ? [seg.cmd, ...seg.argv.slice(1)].join(" ") : "";
  const full = seg.fullArgv.length > 0 ? [cmdWord(seg.fullArgv[0]!), ...seg.fullArgv.slice(1)].join(" ") : normalized;
  return { normalized, full };
}

export function shellPatternMatchesSegment(pattern: ApprovalPattern, seg: ShellSegment, mode: "deny" | "allow"): boolean {
  if (pattern.kind !== "shell") return false;
  const { normalized, full } = approvalSegmentForms(seg);
  if (mode === "deny") return matchApprovalGlob(pattern.glob, normalized) || matchApprovalGlob(pattern.glob, full);
  // Allow: the form with wrappers must match, or the normalized form when nothing elevated it.
  return matchApprovalGlob(pattern.glob, full) || (!seg.sudo && matchApprovalGlob(pattern.glob, normalized));
}

function toolNameMatches(patternTool: string, tool: string): boolean {
  if (patternTool === tool) return true;
  if (patternTool === "Edit" && APPROVAL_WRITE_TOOLS.has(tool)) return true;
  if ((patternTool === "Agent" || patternTool === "Task") && (tool === "Agent" || tool === "Task")) return true;
  return false;
}

/** Match a `Tool(glob)` or `mcp__` pattern against a non-shell tool call. */
export function toolPatternMatches(
  pattern: ApprovalPattern,
  tool: string,
  input: Record<string, unknown>,
  normalizePath: (p: string) => NormalizedApprovalPath,
  env: ApprovalPathEnv,
): boolean {
  if (pattern.kind === "mcp") return matchApprovalGlob(pattern.glob, tool);
  if (pattern.kind !== "tool" || !toolNameMatches(pattern.tool, tool)) return false;
  const pathKey = APPROVAL_PATH_TOOLS[tool];
  if (pathKey) {
    const value = input[pathKey];
    if (typeof value !== "string" || !value) return pattern.glob === "*" || pattern.glob === "**";
    const n = normalizePath(value);
    const glob = expandApprovalPattern(pattern.glob, env);
    if (!glob.startsWith("/") && !glob.startsWith("**")) {
      return matchApprovalGlob(pattern.glob, value);
    }
    return matchApprovalPathGlob(glob, n.lexical) || matchApprovalPathGlob(glob, n.real);
  }
  const key = TOOL_PRIMARY_ARG[tool];
  const value = key ? input[key] : undefined;
  return matchApprovalGlob(pattern.glob, typeof value === "string" ? value : JSON.stringify(input));
}
