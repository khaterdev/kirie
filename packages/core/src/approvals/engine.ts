/**
 * ApprovalEngine: the classifier behind the `approvals` gate (PLAN C.9).
 *
 * `evaluate(call)` is synchronous and never throws. For every tool call it
 * decides, in this order (DECISIONS 1, 2; R2 section 4):
 *
 *   1. hardline match            -> deny in every mode (unless `hardline` is off)
 *   2. owner denylist match      -> deny in every mode
 *   3. dangerous or sensitive    -> ask in `ask`, allow (and audit) in `yolo`
 *   4. allowlist match           -> allow
 *   5. uncertain parse           -> ask in `ask`, allow in `yolo`
 *   6. mode default              -> yolo: allow; ask/dangerous: allow; ask/all: ask
 *
 * A compound command gets the most severe verdict of its parts. Deny and
 * dangerous fire when any segment at any depth matches; allow needs every
 * segment to match and no whole-command uncertainty.
 *
 * Work from a webhook is always judged as mode `ask` (C.9).
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v3";
import type { ApprovalsConfig } from "../config/sections/approvals.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { SdkCallContext } from "../engine/sdk-options.js";
import type { TurnOrigin } from "../engine/turn-context.js";
import { createModuleLogger } from "../logging/logger.js";
import { matchApprovalGlob } from "./glob.js";
import {
  APPROVALS_PROTECTED_READ_PATHS,
  APPROVALS_PROTECTED_WRITE_PATHS,
  APPROVALS_SHELL_HISTORY_PATHS,
  approvalPathIsAncestorOf,
  approvalPathMatches,
  compileApprovalPathList,
  normalizeApprovalPath,
  type ApprovalPathEnv,
  type ApprovalPathList,
} from "./paths.js";
import {
  APPROVAL_PATH_TOOLS,
  APPROVAL_WRITE_TOOLS,
  compileApprovalPatterns,
  shellPatternMatchesSegment,
  toolPatternMatches,
  type ApprovalPattern,
} from "./patterns.js";
import {
  APPROVAL_COMMAND_RULES,
  APPROVAL_RULES,
  indexApprovalRules,
  type ApprovalRuleEnv,
} from "./rules.js";
import { parseShell, type ParsedShell, type ShellSegment, type ShellUncertainty } from "./shell-parse.js";
import type {
  ApprovalAskScope,
  ApprovalDecision,
  ApprovalEvaluation,
  ApprovalFinding,
  ApprovalMode,
  ApprovalPolicy,
  ApprovalSandboxInfo,
  ApprovalToolCall,
} from "./types.js";

const log = createModuleLogger("approvals");

/** Runtime override keys (PLAN B.11). */
export const APPROVAL_SETTING_KEYS = {
  mode: "approvals.mode",
  askScope: "approvals.askScope",
  hardline: "approvals.hardline",
  allow: "approvals.allow",
  deny: "approvals.deny",
} as const;

export const APPROVAL_MODE_SCHEMA = z.enum(["yolo", "ask"]);
export const APPROVAL_SCOPE_SCHEMA = z.enum(["dangerous", "all"]);
export const APPROVAL_LIST_SCHEMA = z.array(z.string().max(200)).max(200);

/** The kirie-tools MCP server prefix. */
export const KIRIE_TOOLS_PREFIX = "mcp__kirie-tools__";
/** The docker-mode shell tool (W3-SBX). Its commands run inside the container. */
export const APPROVAL_SANDBOX_SHELL_TOOL = `${KIRIE_TOOLS_PREFIX}sandbox_bash`;
/**
 * Tools whose `command` input is run by a shell (GATES-B1): Bash, the docker
 * shell, and the SDK built-ins Monitor (a watched shell command) and
 * PowerShell. All get the same classification, deny globs, hash and card.
 */
export const APPROVAL_SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", APPROVAL_SANDBOX_SHELL_TOOL, "Monitor", "PowerShell"]);

/** True when this call runs `input.command` through a shell. Monitor without a command (a WebSocket watch) is not one. */
export function isApprovalShellCall(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (!APPROVAL_SHELL_TOOLS.has(tool)) return false;
  if (tool === "Bash" || tool === APPROVAL_SANDBOX_SHELL_TOOL) return true;
  return typeof input?.command === "string";
}

/** Read-only RemoteTrigger actions; every other action creates, changes or runs a remote agent. */
const REMOTE_TRIGGER_READ_ACTIONS = new Set(["list", "get", "list_runs", "get_run_log"]);

/**
 * SDK built-ins that start or schedule work outside the tools this gate reads
 * (GATES-B1, docs/approvals.md "Built-in tools"). Their effect cannot be
 * classified from the input, so they are uncertain: they ask in ask mode and
 * run in yolo, as before.
 */
function builtinToolUncertainty(tool: string, input: Record<string, unknown>): ShellUncertainty[] {
  const u = (detail: string): ShellUncertainty[] => [{ code: "builtin-tool", detail: `${tool} ${detail}` }];
  switch (tool) {
    case "Workflow": return u("runs a workflow script that starts subagents");
    case "CronCreate": return u(input.durable === true ? "schedules a prompt that runs later, also after a restart" : "schedules a prompt that runs later");
    case "ScheduleWakeup": return input.stop === true ? [] : u("schedules a prompt that runs later");
    case "RemoteTrigger": return REMOTE_TRIGGER_READ_ACTIONS.has(str(input.action)) ? [] : u(`${str(input.action) || "?"} creates, changes or runs a remote agent`);
    case "EnterWorktree": return u("creates or enters a git worktree and moves the session's working directory");
    case "ExitWorktree": return input.action === "remove" ? u("removes a git worktree and its branch") : [];
    default: return [];
  }
}

const SENSITIVE_KIRIE_TOOLS: Readonly<Record<string, string>> = {
  mcp_servers_add: "registers a new MCP server, which runs an arbitrary command",
  mcp_servers_remove: "removes an MCP server",
  gateway_restart: "restarts the Kirie daemon",
  voice_call_initiate: "places a phone call",
};

/** Tools that never ask, even with `askScope: "all"`: pure bookkeeping with no effect outside the session. */
const INERT_TOOLS = new Set(["TodoWrite", "ExitPlanMode", "ToolSearch", "StructuredOutput", "BashOutput", "TaskOutput", "KillShell", "KillBash"]);

/** APIs that make inline code able to touch the system (`approvals.inlineCode: "heuristic"`). */
const INLINE_CODE_IO_MARKERS = [
  "subprocess", "os.system", "os.popen", "os.remove", "os.unlink", "os.rmdir", "os.exec", "os.spawn", "os.kill", "shutil",
  "socket", "urllib", "requests", "http", "ftplib", "smtplib", "pty", "ctypes", "__import__", "importlib", "eval(", "exec(",
  "child_process", "execsync", "spawn", "fork(", "fs.rm", "fs.unlink", "fs.write", "writefile", "appendfile", "fetch(",
  "require(", "import(", "process.kill", "system(", "qx", "`", "file.write", "file.delete", "io.popen", "net.", "deno.",
  "bun.", "rmtree", "unlink", "kill(",
];

function inlineCodeLooksInert(code: string): boolean {
  const lower = code.toLowerCase();
  if (INLINE_CODE_IO_MARKERS.some((m) => lower.includes(m))) return false;
  // open() in a write mode
  const openAt = lower.indexOf("open(");
  if (openAt !== -1) {
    const window = lower.slice(openAt, openAt + 120);
    if (/["'][rb+]*[wax]/.test(window)) return false;
  }
  return true;
}

/** Stable JSON: sorted keys, so the same input always hashes the same. */
function stableJson(value: unknown, depth = 0): string {
  if (depth > 20) return "\"…\"";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v, depth + 1)).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
}

export function approvalCallHash(tool: string, input: Record<string, unknown>): string {
  try {
    // For a shell call only the command matters (a new description or timeout is the same request).
    const body = isApprovalShellCall(tool, input) && typeof input.command === "string" ? input.command : stableJson(input);
    return createHash("sha256").update(`${tool}\n${body}`).digest("hex");
  } catch {
    return createHash("sha256").update(tool).digest("hex");
  }
}

export interface ApprovalEnvironment {
  home: string;
  /** Kirie's data directory (`{kirie}`). Default `<home>/.kirie`. */
  dataDir?: string;
  /** Control-plane port (`gateway.port`). Default 18789. */
  gatewayPort?: number;
  /** True when (channel, chatId) is a configured owner identity. Default: nobody is. */
  isOwnerChat?: (channel: string, chatId: string) => boolean;
  /** Origin of the turn behind a call (for webhook detection). */
  originOf?: (ctx: SdkCallContext) => TurnOrigin;
  sandbox?: ApprovalSandboxInfo;
  realpath?: (p: string) => string;
}

interface CompiledLists {
  key: string;
  allow: ApprovalPattern[];
  deny: ApprovalPattern[];
  write: ApprovalPathList;
  read: ApprovalPathList;
  history: ApprovalPathList;
  kirieControl: ApprovalPathList;
  kirieDb: ApprovalPathList;
  mcpAsk: string[];
}

const INDEXED_RULES = indexApprovalRules(APPROVAL_RULES);
const HARDLINE_RULE_IDS = new Set([...APPROVAL_RULES, ...APPROVAL_COMMAND_RULES].filter((r) => r.severity === "hardline").map((r) => r.id));

function compileLists(policy: ApprovalPolicy, pathEnv: ApprovalPathEnv): CompiledLists {
  return {
    key: "",
    allow: compileApprovalPatterns(policy.allow),
    deny: compileApprovalPatterns(policy.deny),
    write: compileApprovalPathList([...APPROVALS_PROTECTED_WRITE_PATHS, ...policy.protectedWritePaths], pathEnv),
    read: compileApprovalPathList([...APPROVALS_PROTECTED_READ_PATHS, ...policy.protectedReadPaths], pathEnv),
    history: compileApprovalPathList(APPROVALS_SHELL_HISTORY_PATHS, pathEnv),
    kirieControl: compileApprovalPathList(["{kirie}/config.yaml", "{kirie}/state/**", "{kirie}/*.sh"], pathEnv),
    kirieDb: compileApprovalPathList(["{kirie}/*.db*"], pathEnv),
    mcpAsk: [...policy.mcpAsk],
  };
}

function listsKey(policy: ApprovalPolicy, env: ApprovalEnvironment): string {
  return JSON.stringify([policy.allow, policy.deny, policy.protectedWritePaths, policy.protectedReadPaths, policy.mcpAsk, env.home, env.dataDir ?? ""]);
}

const listCache = new Map<string, CompiledLists>();

function compiledFor(policy: ApprovalPolicy, env: ApprovalEnvironment, pathEnv: ApprovalPathEnv): CompiledLists {
  const key = listsKey(policy, env);
  const hit = listCache.get(key);
  if (hit) return hit;
  const compiled = { ...compileLists(policy, pathEnv), key };
  if (listCache.size > 32) listCache.clear();
  listCache.set(key, compiled);
  return compiled;
}

function segmentLabel(seg: ShellSegment): string {
  const text = seg.raw || seg.argv.join(" ");
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface ShellAnalysis {
  parsed: ParsedShell;
  hardline: ApprovalFinding[];
  dangerous: ApprovalFinding[];
}

/** Run the built-in rules over a parsed command. */
function runShellRules(parsed: ParsedShell, ruleEnv: ApprovalRuleEnv, opts: { disabled: ReadonlySet<string>; skipDangerous: boolean }): { hardline: ApprovalFinding[]; dangerous: ApprovalFinding[] } {
  const hardline: ApprovalFinding[] = [];
  const dangerous: ApprovalFinding[] = [];
  const add = (id: string, severity: "hardline" | "dangerous", reason: string, segment?: string): void => {
    if (severity === "dangerous" && (opts.skipDangerous || opts.disabled.has(id))) return;
    const list = severity === "hardline" ? hardline : dangerous;
    if (list.some((f) => f.ruleId === id && f.segment === segment)) return;
    list.push({ ruleId: id, severity, reason, ...(segment !== undefined ? { segment } : {}) });
  };
  const flaggedSegments = new Set<number>();
  parsed.segments.forEach((seg, i) => {
    const rules = [...(INDEXED_RULES.byCommand.get(seg.cmd) ?? []), ...INDEXED_RULES.generic];
    for (const rule of rules) {
      if (rule.severity === "dangerous" && (opts.skipDangerous || opts.disabled.has(rule.id))) continue;
      const reason = rule.check(seg, ruleEnv);
      if (reason) {
        add(rule.id, rule.severity, reason, segmentLabel(seg));
        if (rule.severity === "dangerous") flaggedSegments.add(i);
      }
    }
  });
  for (const rule of APPROVAL_COMMAND_RULES) {
    if (rule.severity === "dangerous" && (opts.skipDangerous || opts.disabled.has(rule.id))) continue;
    for (const hit of rule.check(parsed, ruleEnv)) {
      const seg = hit.segment !== undefined ? parsed.segments[hit.segment] : undefined;
      add(rule.id, rule.severity, hit.reason, seg ? segmentLabel(seg) : undefined);
    }
  }
  // net.remote-exec: a remote command that is itself dangerous or unreadable.
  if (!opts.skipDangerous && !opts.disabled.has("net.remote-exec")) {
    const uncertainSegs = new Set(parsed.uncertain.map((u) => u.segment).filter((s): s is number => s !== undefined));
    parsed.segments.forEach((seg, i) => {
      if (!seg.remote) return;
      if (flaggedSegments.has(i) || uncertainSegs.has(i) || hardline.some((f) => f.segment === segmentLabel(seg))) {
        add("net.remote-exec", "dangerous", `remote command via ${seg.via ?? "ssh"} is dangerous or unreadable`, segmentLabel(seg));
      }
    });
  }
  return { hardline, dangerous };
}

/**
 * Cross-check against a naive reading of the command with every quote, escape
 * and substitution marker removed. When that reading finds a rule the real
 * parse did not, the parser and the shell may disagree about where commands
 * start (a desync), so the call is marked uncertain: it asks in ask mode. Not
 * used for hardline (quoted text such as commit messages would block in yolo).
 */
function addParseMismatch(parsed: ParsedShell, command: string, real: { hardline: ApprovalFinding[]; dangerous: ApprovalFinding[] }, ruleEnv: ApprovalRuleEnv, disabled: ReadonlySet<string>): void {
  if (command.length > 8000 || parsed.uncertain.length > 0) return;
  const naiveText = command.replace(/[\\'"`]/g, " ").replace(/\$[({[]/g, " ").replace(/[)}\]]/g, " ; ");
  if (naiveText === command) return;
  const naive = parseShell(naiveText, { cwd: ruleEnv.cwd, home: ruleEnv.path.home });
  const r = runShellRules(naive, ruleEnv, { disabled, skipDangerous: false });
  const seen = new Set([...real.hardline, ...real.dangerous].map((f) => f.ruleId));
  const extra = [...r.hardline, ...r.dangerous].find((f) => !seen.has(f.ruleId));
  if (extra) parsed.uncertain.push({ code: "parse-mismatch", detail: `read without quoting, the command looks like ${extra.ruleId} (${extra.reason})` });
}

function makeRuleEnv(lists: CompiledLists, pathEnv: ApprovalPathEnv, cwd: string, gatewayPort: number): ApprovalRuleEnv {
  return {
    path: pathEnv,
    cwd,
    gatewayPort,
    write: lists.write,
    read: lists.read,
    history: lists.history,
    kirieControl: lists.kirieControl,
    kirieDb: lists.kirieDb,
    cache: new Map(),
  };
}

function isWebhookCall(ctx: SdkCallContext, env: ApprovalEnvironment): boolean {
  if (ctx.kind === "webhook") return true;
  try {
    return env.originOf?.(ctx) === "webhook";
  } catch {
    return false;
  }
}

function agentMessage(kind: "hardline" | "deny", finding: ApprovalFinding): string {
  if (kind === "hardline") {
    return `Blocked by Kirie's hardline safety list (${finding.ruleId}: ${finding.reason}). This action is never allowed. Do not retry it and do not try an equivalent command. Continue with other work, or explain what you needed and why.`;
  }
  return `Blocked by the owner's deny list (${finding.reason}). Do not retry it and do not try an equivalent command. Continue with other work, or explain what you needed and why.`;
}

function summarize(findings: ApprovalFinding[], uncertain: ShellUncertainty[], scopeAll: boolean): string {
  const parts = findings.slice(0, 3).map((f) => `${f.ruleId}: ${f.reason}`);
  if (findings.length > 3) parts.push(`and ${findings.length - 3} more`);
  if (parts.length === 0 && uncertain.length > 0) {
    parts.push(...uncertain.slice(0, 2).map((u) => `uncertain (${u.code}): ${u.detail}`));
  }
  if (parts.length === 0 && scopeAll) parts.push("ask scope is \"all\": every action not on the allow list needs approval");
  return parts.length > 0 ? `approval needed: ${parts.join("; ")}` : "allowed";
}

/**
 * The pure classifier: one tool call, an effective policy and the environment
 * in; a decision out. Never throws (an internal error follows the failure
 * policy: ask in `ask` mode, allow in `yolo`).
 */
export function evaluateApprovalCall(call: ApprovalToolCall, policy: ApprovalPolicy, env: ApprovalEnvironment, onError?: (err: unknown) => void): ApprovalEvaluation {
  const hash = approvalCallHash(call.tool, call.input ?? {});
  const webhook = call.ctx ? isWebhookCall(call.ctx, env) : false;
  const mode: ApprovalMode = webhook ? "ask" : policy.mode;
  const scope: ApprovalAskScope = policy.askScope;
  const base = { mode, scope, hash };
  const allowResult = (findings: ApprovalFinding[] = [], uncertain: ShellUncertainty[] = [], allowlisted = false): ApprovalEvaluation => ({
    ...base, decision: "allow", findings, uncertain, allowlisted, summary: "allowed", messageForAgent: "",
  });

  const pathEnv: ApprovalPathEnv = {
    home: env.home,
    ...(env.dataDir !== undefined ? { dataDir: env.dataDir } : {}),
    ...(env.realpath ? { realpath: env.realpath } : {}),
  };
  const cwd = call.cwd || call.ctx?.cwd || "";
  const isShell = isApprovalShellCall(call.tool, call.input);
  let command = "";
  let lists: CompiledLists | undefined;
  let parsed: ParsedShell | undefined;
  let hardline: ApprovalFinding[] = [];
  let dangerous: ApprovalFinding[] = [];
  let ruleEnv: ApprovalRuleEnv | undefined;

  // ── Floors: hardline and denylist, in their own guarded block ─────────
  try {
    lists = compiledFor(policy, env, pathEnv);
    ruleEnv = makeRuleEnv(lists, pathEnv, cwd, env.gatewayPort ?? 18789);
    const disabled = new Set(policy.disabledRules);
    const sandboxed = call.tool === APPROVAL_SANDBOX_SHELL_TOOL && env.sandbox?.mode === "docker" && env.sandbox.network === "none";
    if (isShell) {
      command = str(call.input?.command);
      parsed = parseShell(command, { cwd, home: env.home });
      const r = runShellRules(parsed, ruleEnv, { disabled, skipDangerous: sandboxed });
      hardline = policy.hardline ? r.hardline : [];
      // With the hardline list off these still ask in ask mode (they run in yolo, as before the gate).
      dangerous = policy.hardline ? r.dangerous : [...r.hardline.map((f) => ({ ...f, severity: "dangerous" as const })), ...r.dangerous];
      if (!sandboxed) addParseMismatch(parsed, command, r, ruleEnv, disabled);
      if (call.tool === "PowerShell") parsed.uncertain.push({ code: "powershell", detail: "PowerShell is not a POSIX shell; the command was read as one only approximately" });
    }
    if (hardline.length > 0) {
      return { ...base, decision: "deny", findings: hardline, uncertain: parsed?.uncertain ?? [], allowlisted: false, summary: `hardline: ${hardline[0]!.ruleId}`, messageForAgent: agentMessage("hardline", hardline[0]!) };
    }
    const denyHit = matchDeny(call, lists, parsed, command, ruleEnv, pathEnv, cwd);
    if (denyHit) {
      const finding: ApprovalFinding = { ruleId: "owner.deny", severity: "deny", reason: `pattern "${denyHit.pattern}"`, ...(denyHit.segment ? { segment: denyHit.segment } : {}) };
      return { ...base, decision: "deny", findings: [finding], uncertain: parsed?.uncertain ?? [], allowlisted: false, summary: `deny list: ${denyHit.pattern}`, messageForAgent: agentMessage("deny", finding) };
    }
  } catch (err) {
    onError?.(err);
    log.error({ err, tool: call.tool }, "approval engine failed in the hardline/deny pass");
    // Fall back to a raw-string deny check before applying the failure policy.
    try {
      const raw = isShell ? command : stableJson(call.input ?? {});
      const hit = compileApprovalPatterns(policy.deny).find((p) => p.kind === "shell" && raw.length <= 65_536 && matchApprovalGlob(p.glob, raw));
      if (hit) {
        const finding: ApprovalFinding = { ruleId: "owner.deny", severity: "deny", reason: `pattern "${hit.source}"` };
        return { ...base, decision: "deny", findings: [finding], uncertain: [], allowlisted: false, summary: `deny list: ${hit.source}`, messageForAgent: agentMessage("deny", finding) };
      }
    } catch {
      // nothing more to try
    }
    return engineFailure(base, mode);
  }

  // ── Everything else ────────────────────────────────────────────────────
  try {
    const findings: ApprovalFinding[] = [...dangerous];
    if (!isShell) findings.push(...toolFindings(call, lists!, ruleEnv!, pathEnv, cwd, env, new Set(policy.disabledRules)));
    const toolUncertain = isShell ? [] : builtinToolUncertainty(call.tool, call.input ?? {});
    const uncertain = [...(parsed?.uncertain ?? []), ...toolUncertain].filter((u) => {
      if (u.code !== "inline-code") return true;
      if (policy.inlineCode === "allow") return false;
      if (policy.inlineCode === "heuristic") return !inlineCodeLooksInert(u.code_text ?? "");
      return true;
    });

    if (findings.length > 0) {
      if (mode === "ask") {
        return { ...base, decision: "ask", findings, uncertain, allowlisted: false, summary: summarize(findings, uncertain, false), messageForAgent: "" };
      }
      return allowResult(findings, uncertain);
    }

    const allowlisted = matchAllow(call, lists!, parsed, uncertain, ruleEnv!, pathEnv, cwd);
    if (allowlisted) return allowResult([], uncertain, true);

    if (uncertain.length > 0) {
      if (mode === "ask") {
        return { ...base, decision: "ask", findings, uncertain, allowlisted: false, summary: summarize(findings, uncertain, false), messageForAgent: "" };
      }
      return allowResult([], uncertain);
    }

    if (mode === "ask" && scope === "all" && !INERT_TOOLS.has(call.tool)) {
      return { ...base, decision: "ask", findings, uncertain, allowlisted: false, summary: summarize(findings, uncertain, true), messageForAgent: "" };
    }
    return allowResult();
  } catch (err) {
    onError?.(err);
    log.error({ err, tool: call.tool }, "approval engine failed");
    return engineFailure(base, mode);
  }
}

function engineFailure(base: { mode: ApprovalMode; scope: ApprovalAskScope; hash: string }, mode: ApprovalMode): ApprovalEvaluation {
  const finding: ApprovalFinding = { ruleId: "engine.error", severity: "dangerous", reason: "approval engine error" };
  if (mode === "ask") {
    return { ...base, decision: "ask", findings: [finding], uncertain: [], allowlisted: false, summary: "approval needed: approval engine error", messageForAgent: "", engineError: true };
  }
  return { ...base, decision: "allow", findings: [finding], uncertain: [], allowlisted: false, summary: "allowed (approval engine error)", messageForAgent: "", engineError: true };
}

function matchDeny(
  call: ApprovalToolCall,
  lists: CompiledLists,
  parsed: ParsedShell | undefined,
  command: string,
  ruleEnv: ApprovalRuleEnv,
  pathEnv: ApprovalPathEnv,
  cwd: string,
): { pattern: string; segment?: string } | null {
  if (lists.deny.length === 0) return null;
  if (parsed) {
    for (const p of lists.deny) {
      if (p.kind !== "shell") continue;
      if (command.length <= 65_536 && matchApprovalGlob(p.glob, command)) return { pattern: p.source };
      const seg = parsed.segments.find((s) => shellPatternMatchesSegment(p, s, "deny"));
      if (seg) return { pattern: p.source, segment: segmentLabel(seg) };
    }
    return null;
  }
  const normalize = (p: string) => normalizeApprovalPath(p, cwd, pathEnv, ruleEnv.cache);
  for (const p of lists.deny) {
    if (p.kind === "shell") continue;
    if (toolPatternMatches(p, call.tool, call.input ?? {}, normalize, pathEnv)) return { pattern: p.source };
  }
  return null;
}

function matchAllow(
  call: ApprovalToolCall,
  lists: CompiledLists,
  parsed: ParsedShell | undefined,
  uncertain: ShellUncertainty[],
  ruleEnv: ApprovalRuleEnv,
  pathEnv: ApprovalPathEnv,
  cwd: string,
): boolean {
  if (lists.allow.length === 0) return false;
  if (parsed) {
    // Whole-command uncertainty (unbalanced quotes, hidden characters, too long) is never allowlisted.
    if (uncertain.some((u) => u.segment === undefined)) return false;
    const segments = parsed.segments.filter((s) => s.argv.length > 0 || s.redirects.length > 0);
    if (segments.length === 0) return false;
    for (const seg of segments) {
      if (!lists.allow.some((p) => shellPatternMatchesSegment(p, seg, "allow"))) return false;
      // A redirect into a protected path is never covered by an allow pattern.
      for (const r of seg.redirects) {
        if (!r.target || r.op === "<<" || r.op === "<<-" || r.op === "<<<") continue;
        const n = normalizeApprovalPath(r.target, seg.cwd ?? cwd, pathEnv, ruleEnv.cache);
        if (approvalPathMatches(n, lists.write) || approvalPathMatches(n, lists.read)) return false;
      }
    }
    return true;
  }
  const normalize = (p: string) => normalizeApprovalPath(p, cwd, pathEnv, ruleEnv.cache);
  return lists.allow.some((p) => p.kind !== "shell" && toolPatternMatches(p, call.tool, call.input ?? {}, normalize, pathEnv));
}

/** Findings for a non-shell tool: protected paths for file tools, sensitive MCP tools. */
function toolFindings(
  call: ApprovalToolCall,
  lists: CompiledLists,
  ruleEnv: ApprovalRuleEnv,
  pathEnv: ApprovalPathEnv,
  cwd: string,
  env: ApprovalEnvironment,
  disabled: ReadonlySet<string>,
): ApprovalFinding[] {
  const out: ApprovalFinding[] = [];
  const input = call.input ?? {};
  const tool = call.tool;
  const pathKey = APPROVAL_PATH_TOOLS[tool];
  if (pathKey) {
    const value = str(input[pathKey]);
    if (value) {
      const n = normalizeApprovalPath(value, cwd, pathEnv, ruleEnv.cache);
      if (APPROVAL_WRITE_TOOLS.has(tool)) {
        if (!disabled.has("fs.protected-write") && approvalPathMatches(n, lists.write)) {
          out.push({ ruleId: "fs.protected-write", severity: "dangerous", reason: `${tool} to the protected path ${value}`, segment: value });
        }
        if (!disabled.has("kirie.control") && approvalPathMatches(n, lists.kirieControl)) {
          out.push({ ruleId: "kirie.control", severity: "dangerous", reason: `${tool} to Kirie's control file ${value}`, segment: value });
        }
      } else if (tool === "Read" || tool === "Grep") {
        const hit = approvalPathMatches(n, lists.read) || (tool === "Grep" && approvalPathIsAncestorOf(n, lists.read));
        if (!disabled.has("secret.read") && hit) {
          out.push({ ruleId: "secret.read", severity: "dangerous", reason: `${tool} of the protected path ${value}`, segment: value });
        }
      }
    }
  }
  if (tool.startsWith(KIRIE_TOOLS_PREFIX) && !disabled.has("mcp.sensitive")) {
    const name = tool.slice(KIRIE_TOOLS_PREFIX.length);
    const why = SENSITIVE_KIRIE_TOOLS[name];
    if (why) out.push({ ruleId: "mcp.sensitive", severity: "sensitive", reason: `${name} ${why}`, segment: name });
    if (name === "send_message" || (name === "channel_action" && str(input.action) !== "send_typing")) {
      const channel = str(input.channel);
      const chatId = typeof input.chatId === "number" ? String(input.chatId) : str(input.chatId);
      let owner = false;
      try {
        owner = !!channel && !!chatId && (env.isOwnerChat?.(channel, chatId) ?? false);
      } catch {
        owner = false;
      }
      if (!owner) out.push({ ruleId: "mcp.sensitive", severity: "sensitive", reason: `${name} to ${channel || "?"}:${chatId || "?"}, which is not the owner`, segment: name });
    }
  }
  if (!disabled.has("mcp.sensitive") && lists.mcpAsk.some((g) => matchApprovalGlob(g, tool))) {
    if (!out.some((f) => f.ruleId === "mcp.sensitive")) out.push({ ruleId: "mcp.sensitive", severity: "sensitive", reason: `${tool} is on approvals.mcpAsk`, segment: tool });
  }
  return out;
}

// ── Text analysis for other workstreams ───────────────────────────────────

export interface ApprovalTextAnalysis {
  findings: ApprovalFinding[];
  uncertain: ShellUncertainty[];
}

/**
 * Run the built-in hardline and dangerous rules over a piece of text read as a
 * shell command (also line by line, so prose around a command does not hide
 * it). Used by computer use (typed text) and voice. Pure apart from resolving
 * symlinks of the paths it sees; never throws.
 */
export function analyzeApprovalShellText(text: string, opts: { home?: string; dataDir?: string; cwd?: string; realpath?: (p: string) => string } = {}): ApprovalTextAnalysis {
  try {
    const home = opts.home ?? homedir();
    const pathEnv: ApprovalPathEnv = { home, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), ...(opts.realpath ? { realpath: opts.realpath } : {}) };
    const policy = defaultApprovalPolicy();
    const lists = compiledFor(policy, { home, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}) }, pathEnv);
    const cwd = opts.cwd ?? opts.dataDir ?? join(home, ".kirie");
    const findings: ApprovalFinding[] = [];
    const uncertain: ShellUncertainty[] = [];
    const inputs = [text, ...text.split("\n").filter((l) => l.trim().length > 0 && l !== text)].slice(0, 200);
    for (const chunk of inputs) {
      const parsed = parseShell(chunk, { cwd, home });
      const r = runShellRules(parsed, makeRuleEnv(lists, pathEnv, cwd, 18789), { disabled: new Set(), skipDangerous: false });
      for (const f of [...r.hardline, ...r.dangerous]) {
        if (!findings.some((x) => x.ruleId === f.ruleId && x.segment === f.segment)) findings.push(f);
      }
      if (chunk === text) uncertain.push(...parsed.uncertain);
    }
    return { findings, uncertain };
  } catch {
    return { findings: [{ ruleId: "engine.error", severity: "dangerous", reason: "approval engine error" }], uncertain: [] };
  }
}

/** True when the text, read as shell, matches a hardline or dangerous rule. */
export function isDangerousText(text: string, opts?: Parameters<typeof analyzeApprovalShellText>[1]): boolean {
  return analyzeApprovalShellText(text, opts).findings.length > 0;
}

/** True when the text, read as shell, matches a hardline rule. */
export function isHardlineText(text: string, opts?: Parameters<typeof analyzeApprovalShellText>[1]): boolean {
  return analyzeApprovalShellText(text, opts).findings.some((f) => HARDLINE_RULE_IDS.has(f.ruleId));
}

// ── The engine ────────────────────────────────────────────────────────────

const SANDBOX_MODE_SCHEMA = z.enum(["off", "native", "docker"]);

/**
 * Sandbox info from config plus the `sandbox.mode` runtime override. The
 * default provider until W3-SBX calls `setSandboxInfo` with its own (which can
 * also report whether the container is actually up).
 */
export function approvalSandboxInfoFrom(
  settings: Pick<RuntimeSettings, "effective"> | undefined,
  sandbox: { mode: "off" | "native" | "docker"; docker: { network: "none" | "bridge" } },
): ApprovalSandboxInfo {
  let mode = sandbox.mode;
  try {
    mode = settings ? settings.effective("sandbox.mode", SANDBOX_MODE_SCHEMA, sandbox.mode) : sandbox.mode;
  } catch {
    mode = sandbox.mode;
  }
  return mode === "docker" ? { mode, network: sandbox.docker.network } : { mode };
}

/** The policy with every config default (used by text analysis and tests). */
export function defaultApprovalPolicy(over: Partial<ApprovalPolicy> = {}): ApprovalPolicy {
  return {
    enabled: true,
    mode: "yolo",
    askScope: "dangerous",
    hardline: true,
    allow: [],
    deny: [],
    inlineCode: "ask",
    mcpAsk: [],
    protectedWritePaths: [],
    protectedReadPaths: [],
    disabledRules: [],
    timeoutSeconds: 300,
    unattended: "ask",
    maxPending: 5,
    redenyWindowSeconds: 600,
    maxDenialsPerTurn: 3,
    ...over,
  };
}

export interface ApprovalEngineDeps {
  config: ApprovalsConfig;
  settings?: Pick<RuntimeSettings, "get" | "effective">;
  homeDir?: string;
  dataDir?: string;
  gatewayPort?: number;
  isOwnerChat?: (channel: string, chatId: string) => boolean;
  originOf?: (ctx: SdkCallContext) => TurnOrigin;
  /** Default sandbox info (W3-SBX may replace it with `setSandboxInfo`). */
  sandboxInfo?: () => ApprovalSandboxInfo;
  realpath?: (p: string) => string;
  /** Called on an evaluator error (the feature rate-limits an owner notice). */
  onError?: (err: unknown) => void;
}

export class ApprovalEngine {
  private sandboxInfo: () => ApprovalSandboxInfo;

  constructor(private readonly deps: ApprovalEngineDeps) {
    this.sandboxInfo = deps.sandboxInfo ?? (() => ({ mode: "off" }));
  }

  /** W3-SBX: tell the engine where shell commands run. Inside the network-less docker sandbox the dangerous rules are skipped; hardline and the deny list still apply. */
  setSandboxInfo(fn: () => ApprovalSandboxInfo): void {
    this.sandboxInfo = fn;
  }

  /** Config defaults merged with the runtime overrides. */
  policy(): ApprovalPolicy {
    const c = this.deps.config;
    const s = this.deps.settings;
    const eff = <T>(key: string, schema: z.ZodType<T>, value: T): T => {
      try {
        return s ? s.effective(key, schema, value) : value;
      } catch {
        return value;
      }
    };
    const extra = (key: string): string[] => {
      try {
        return s?.get(key, APPROVAL_LIST_SCHEMA) ?? [];
      } catch {
        return [];
      }
    };
    return {
      enabled: c.enabled,
      mode: eff(APPROVAL_SETTING_KEYS.mode, APPROVAL_MODE_SCHEMA, c.mode),
      askScope: eff(APPROVAL_SETTING_KEYS.askScope, APPROVAL_SCOPE_SCHEMA, c.askScope),
      hardline: eff(APPROVAL_SETTING_KEYS.hardline, z.boolean(), c.hardline),
      allow: [...c.allow, ...extra(APPROVAL_SETTING_KEYS.allow)],
      deny: [...c.deny, ...extra(APPROVAL_SETTING_KEYS.deny)],
      inlineCode: c.inlineCode,
      mcpAsk: c.mcpAsk,
      protectedWritePaths: c.protectedWritePaths,
      protectedReadPaths: c.protectedReadPaths,
      disabledRules: c.disabledRules,
      timeoutSeconds: c.timeoutSeconds,
      unattended: c.unattended,
      maxPending: c.maxPending,
      redenyWindowSeconds: c.redenyWindowSeconds,
      maxDenialsPerTurn: c.maxDenialsPerTurn,
    };
  }

  mode(): ApprovalMode {
    return this.policy().mode;
  }

  /** Allow and deny lists split into config entries and runtime additions. */
  lists(): { allow: { config: string[]; added: string[] }; deny: { config: string[]; added: string[] } } {
    const s = this.deps.settings;
    const get = (key: string): string[] => {
      try {
        return s?.get(key, APPROVAL_LIST_SCHEMA) ?? [];
      } catch {
        return [];
      }
    };
    return {
      allow: { config: [...this.deps.config.allow], added: get(APPROVAL_SETTING_KEYS.allow) },
      deny: { config: [...this.deps.config.deny], added: get(APPROVAL_SETTING_KEYS.deny) },
    };
  }

  private environment(): ApprovalEnvironment {
    let sandbox: ApprovalSandboxInfo = { mode: "off" };
    try {
      sandbox = this.sandboxInfo();
    } catch {
      sandbox = { mode: "off" };
    }
    return {
      home: this.deps.homeDir ?? homedir(),
      ...(this.deps.dataDir !== undefined ? { dataDir: this.deps.dataDir } : {}),
      ...(this.deps.gatewayPort !== undefined ? { gatewayPort: this.deps.gatewayPort } : {}),
      ...(this.deps.isOwnerChat ? { isOwnerChat: this.deps.isOwnerChat } : {}),
      ...(this.deps.originOf ? { originOf: this.deps.originOf } : {}),
      ...(this.deps.realpath ? { realpath: this.deps.realpath } : {}),
      sandbox,
    };
  }

  /** Pure, synchronous, never throws. */
  evaluate(call: ApprovalToolCall): ApprovalEvaluation {
    let policy: ApprovalPolicy;
    try {
      policy = this.policy();
    } catch (err) {
      this.deps.onError?.(err);
      policy = defaultApprovalPolicy({ mode: this.deps.config.mode, hardline: this.deps.config.hardline });
    }
    return evaluateApprovalCall(call, policy, this.environment(), this.deps.onError);
  }

  /** Dry run for `/approvals test`: never executes anything. */
  explain(command: string, cwd?: string): {
    segments: string[];
    uncertain: ShellUncertainty[];
    findings: ApprovalFinding[];
    decisions: Record<"yolo" | "ask" | "ask-all", ApprovalDecision>;
  } {
    const env = this.environment();
    const dir = cwd ?? this.deps.dataDir ?? join(env.home, ".kirie");
    const ctx: SdkCallContext = { kind: "chat", ownerDm: true, interactive: true, label: "approvals test", cwd: dir };
    const call: ApprovalToolCall = { tool: "Bash", input: { command }, cwd: dir, ctx };
    const policy = this.policy();
    const parsed = parseShell(command, { cwd: dir, home: env.home });
    const run = (over: Partial<ApprovalPolicy>): ApprovalEvaluation => evaluateApprovalCall(call, { ...policy, ...over }, env);
    const asked = run({ mode: "ask", askScope: "dangerous" });
    return {
      segments: parsed.segments.map((s) => `${"  ".repeat(Math.min(s.depth, 6))}${s.via ? `[${s.via}] ` : ""}${s.wrappers.length ? `(${s.wrappers.join(" ")}) ` : ""}${s.argv.join(" ") || s.raw}`),
      uncertain: asked.uncertain,
      findings: asked.findings,
      decisions: {
        yolo: run({ mode: "yolo" }).decision,
        ask: asked.decision,
        "ask-all": run({ mode: "ask", askScope: "all" }).decision,
      },
    };
  }
}
