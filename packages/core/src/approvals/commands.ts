/**
 * `/approvals` (PLAN B.12, C.9). Owner-only, DM-only, category `security`.
 * The registry enforces the owner check; this file never does its own.
 *
 * Every change is a `RuntimeSettings` override; config.yaml is never
 * rewritten. Loosening changes ask for a confirmation first (B.4 rule 10):
 * `mode yolo`, `scope dangerous`, `hardline off`, a forced broad allow pattern,
 * `undeny`, `reset`.
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AuditRecord, AuditTrail } from "../security/audit-trail.js";
import {
  APPROVAL_LIST_SCHEMA,
  APPROVAL_SETTING_KEYS,
  type ApprovalEngine,
} from "./engine.js";
import type { ApprovalStats } from "./gate.js";
import { APPROVAL_PATTERN_MAX_COUNT, isOverBroadAllowPattern, parseApprovalPattern } from "./patterns.js";
import { renderApprovalDisplay, truncateApprovalDisplay, type ApprovalPrompter } from "./prompter.js";
import { approvalRuleCatalog } from "./rules.js";

export interface ApprovalsCommandDeps {
  engine: ApprovalEngine;
  settings: Pick<RuntimeSettings, "get" | "set" | "delete">;
  audit?: Pick<AuditTrail, "recent">;
  prompter?: Pick<ApprovalPrompter, "pendingCount">;
  stats?: Pick<ApprovalStats, "snapshot">;
  /** `approvals.enabled` at boot: false means the gate is not registered. */
  enabled: boolean;
  now?: () => number;
}

const USAGE = [
  "/approvals: what I may run without asking.",
  "/approvals                     status",
  "/approvals mode yolo|ask       yolo: I never ask. ask: risky actions wait for you",
  "/approvals scope dangerous|all in ask mode: only risky actions, or everything not allowed",
  "/approvals allow <pattern> [--force]   add an allow pattern",
  "/approvals deny <pattern>      add a deny pattern (applies in every mode)",
  "/approvals unallow <n|pattern>, /approvals undeny <n|pattern>",
  "/approvals list                numbered allow and deny lists",
  "/approvals rules               built-in rule ids",
  "/approvals test <command>      dry run; never executes anything",
  "/approvals log [n]             last decisions",
  "/approvals hardline on|off     the always-deny list for catastrophic commands",
  "/approvals reset               drop every override made here",
].join("\n");

const HELP_TEXT =
  "Control what I may run without asking. yolo: I never ask. ask: risky actions (rm -rf, force push, kubectl delete, helm uninstall, reading secrets, sudo) wait for your Approve or Deny, and no answer in 5 minutes means deny. Example: /approvals mode ask, /approvals deny \"terraform destroy*\", /approvals test \"git push -f origin main\"";

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

/** Text after the subcommand word, with one pair of surrounding quotes removed. */
function restAfterSubcommand(ctx: CommandContext): string {
  const args = ctx.args.trimStart();
  const sub = ctx.argv[0] ?? "";
  let rest = args.startsWith(sub) ? args.slice(sub.length) : args.replace(/^\S+/, "");
  rest = rest.trim();
  if (rest.length >= 2 && ((rest.startsWith("\"") && rest.endsWith("\"")) || (rest.startsWith("'") && rest.endsWith("'")))) {
    rest = rest.slice(1, -1);
  }
  return rest;
}

function countsSince(records: AuditRecord[]): Record<string, number> {
  const out: Record<string, number> = { asked: 0, approved: 0, denied: 0, timeout: 0, autoDenied: 0, blocked: 0, flagged: 0 };
  for (const r of records) {
    const a = r.action;
    if (a === "asked") out.asked!++;
    else if (a === "approved") out.approved!++;
    else if (a === "denied" || a === "denied.stop") out.denied!++;
    else if (a === "timeout") out.timeout!++;
    else if (a.startsWith("auto-denied")) out.autoDenied!++;
    else if (a === "denied.hardline" || a === "denied.denylist") out.blocked!++;
    else if (a === "allowed.flagged") out.flagged!++;
  }
  return out;
}

export function createApprovalsCommands(deps: ApprovalsCommandDeps): CommandDefinition[] {
  const now = deps.now ?? Date.now;

  const getAdded = (key: string): string[] => {
    try {
      return deps.settings.get(key, APPROVAL_LIST_SCHEMA) ?? [];
    } catch {
      return [];
    }
  };

  const status = (): string => {
    const p = deps.engine.policy();
    const lists = deps.engine.lists();
    const lines = [
      `Approvals: ${deps.enabled ? "on" : "OFF (approvals.enabled is false; the gate is not installed)"}`,
      `Mode: ${p.mode}${p.mode === "ask" ? ` (scope: ${p.askScope})` : " (nothing is asked)"}`,
      `Hardline list: ${p.hardline ? "on" : "OFF"}`,
      `Allow patterns: ${lists.allow.config.length + lists.allow.added.length}, deny patterns: ${lists.deny.config.length + lists.deny.added.length}`,
      `Waiting for you: ${deps.prompter?.pendingCount() ?? 0}`,
      `Timeout: ${p.timeoutSeconds}s (no answer means deny). Unattended work: ${p.unattended}.`,
    ];
    if (deps.audit) {
      const c = countsSince(deps.audit.recent({ feature: "approvals", sinceMs: now() - 86_400_000, limit: 5000 }));
      lines.push(`Last 24 h: asked ${c.asked}, approved ${c.approved}, denied ${c.denied}, timed out ${c.timeout}, auto-denied ${c.autoDenied}, blocked ${c.blocked}, allowed but flagged ${c.flagged}`);
    }
    if (deps.stats) {
      const s = deps.stats.snapshot();
      lines.push(`Since start: ${s.allowed} plain allows, ${s.allowedFlagged} flagged allows, ${s.asked} asks, ${s.denied} blocks`);
    }
    return lines.join("\n");
  };

  const listText = (): string => {
    const lists = deps.engine.lists();
    const section = (title: string, l: { config: string[]; added: string[] }): string[] => {
      const rows = [`${title}:`];
      let n = 1;
      for (const p of l.config) rows.push(`  ${n++}. ${p}   (config.yaml)`);
      for (const p of l.added) rows.push(`  ${n++}. ${p}`);
      if (n === 1) rows.push("  (empty)");
      return rows;
    };
    return [...section("Allow", lists.allow), ...section("Deny", lists.deny), "Allow patterns never override dangerous rules or the hardline list; they skip asks for uncertain commands and for scope \"all\"."].join("\n");
  };

  const addPattern = async (ctx: CommandContext, which: "allow" | "deny"): Promise<string> => {
    const words = ctx.argv.slice(1);
    const force = words.includes("--force");
    const pattern = words.filter((w) => w !== "--force").join(" ").trim();
    if (!pattern) return `Usage: /approvals ${which} <pattern>${which === "allow" ? " [--force]" : ""}`;
    const parsed = parseApprovalPattern(pattern);
    if ("error" in parsed) return `Not added: ${parsed.error}.`;
    const key = which === "allow" ? APPROVAL_SETTING_KEYS.allow : APPROVAL_SETTING_KEYS.deny;
    const added = getAdded(key);
    const lists = deps.engine.lists();
    const config = which === "allow" ? lists.allow.config : lists.deny.config;
    if (added.includes(pattern) || config.includes(pattern)) return `Already on the ${which} list: ${pattern}`;
    if (added.length + config.length >= APPROVAL_PATTERN_MAX_COUNT) return `The ${which} list is full (${APPROVAL_PATTERN_MAX_COUNT} patterns).`;
    if (which === "allow" && isOverBroadAllowPattern(pattern)) {
      if (!force) return `Refused: "${pattern}" would allow far too much. Add --force to add it anyway (you will be asked to confirm).`;
      const ok = await ctx.confirm("Add a broad allow pattern?", `Pattern: ${pattern}\nCommands matching it will not ask you when they are uncertain or when the scope is "all".`);
      if (!ok) return "Cancelled. Nothing changed.";
    }
    deps.settings.set(key, [...added, pattern], actor(ctx));
    return which === "allow"
      ? `Added to the allow list: ${pattern}\nNote: allow patterns do not override dangerous rules or the hardline list.`
      : `Added to the deny list: ${pattern}\nMatching commands are now blocked in every mode.`;
  };

  const removePattern = async (ctx: CommandContext, which: "allow" | "deny"): Promise<string> => {
    const target = ctx.argv.slice(1).join(" ").trim();
    if (!target) return `Usage: /approvals un${which} <n|pattern>`;
    const key = which === "allow" ? APPROVAL_SETTING_KEYS.allow : APPROVAL_SETTING_KEYS.deny;
    const lists = deps.engine.lists();
    const l = which === "allow" ? lists.allow : lists.deny;
    let pattern: string | undefined;
    if (/^[0-9]+$/.test(target)) {
      const n = Number(target);
      if (n >= 1 && n <= l.config.length) return `Entry ${n} comes from config.yaml; edit the config to remove it.`;
      pattern = l.added[n - l.config.length - 1];
    } else {
      if (l.config.includes(target) && !l.added.includes(target)) return "That pattern comes from config.yaml; edit the config to remove it.";
      pattern = l.added.find((p) => p === target);
    }
    if (pattern === undefined) return `Not on the ${which} list: ${target}`;
    if (which === "deny") {
      const ok = await ctx.confirm("Remove a deny pattern?", `Pattern: ${pattern}\nMatching commands will no longer be blocked.`);
      if (!ok) return "Cancelled. Nothing changed.";
    }
    const next = getAdded(key).filter((p) => p !== pattern);
    if (next.length === 0) deps.settings.delete(key, actor(ctx));
    else deps.settings.set(key, next, actor(ctx));
    return `Removed from the ${which} list: ${pattern}`;
  };

  const rules = (): string => {
    const disabled = new Set(deps.engine.policy().disabledRules);
    const rows = approvalRuleCatalog().map((r) => `${r.id}${r.severity === "hardline" ? " [hardline]" : ""}${disabled.has(r.id) ? " [disabled]" : ""}: ${r.description}`);
    return ["Built-in rules (disable dangerous ones with approvals.disabledRules in config.yaml):", ...rows].join("\n");
  };

  const test = (ctx: CommandContext): string => {
    const command = restAfterSubcommand(ctx);
    if (!command) return "Usage: /approvals test <command>";
    const r = deps.engine.explain(command);
    const shown = truncateApprovalDisplay(renderApprovalDisplay(command).text, 1000);
    const lines = [
      `Command: ${shown}`,
      "Segments:",
      ...(r.segments.length > 0 ? r.segments.slice(0, 30).map((s) => `  ${truncateApprovalDisplay(renderApprovalDisplay(s).text, 200)}`) : ["  (none)"]),
      ...(r.segments.length > 30 ? [`  … ${r.segments.length - 30} more`] : []),
      "Findings:",
      ...(r.findings.length > 0 ? r.findings.slice(0, 20).map((f) => `  ${f.ruleId} [${f.severity}]: ${f.reason}`) : ["  none"]),
      ...(r.uncertain.length > 0 ? ["Uncertain:", ...r.uncertain.slice(0, 10).map((u) => `  ${u.code}: ${u.detail}`)] : []),
      `Decision: yolo ${r.decisions.yolo}, ask ${r.decisions.ask}, ask (scope all) ${r.decisions["ask-all"]}`,
      "Nothing was executed.",
    ];
    return lines.join("\n");
  };

  const logText = (ctx: CommandContext): string => {
    if (!deps.audit) return "The audit log is not available.";
    const nRaw = ctx.argv[1];
    const n = nRaw && /^[0-9]+$/.test(nRaw) ? Math.min(Math.max(Number(nRaw), 1), 50) : 10;
    const records = deps.audit.recent({ feature: "approvals", limit: n });
    if (records.length === 0) return "No approval decisions recorded yet.";
    return records.map((r) => {
      const d = r.detail ?? {};
      const rulesText = Array.isArray(d.rules) && d.rules.length > 0 ? ` ${(d.rules as unknown[]).join(",")}` : "";
      const tool = typeof d.tool === "string" ? ` ${d.tool}` : "";
      const context = typeof d.context === "string" ? ` (${d.context})` : "";
      return `${r.ts.slice(0, 19).replace("T", " ")} ${r.action}${tool}${rulesText}${context}`;
    }).join("\n");
  };

  const mode = async (ctx: CommandContext): Promise<string> => {
    const value = (ctx.argv[1] ?? "").toLowerCase();
    if (value !== "yolo" && value !== "ask") return "Usage: /approvals mode yolo|ask";
    const current = deps.engine.policy().mode;
    if (value === current) return `Mode is already ${value}.`;
    if (value === "yolo") {
      const ok = await ctx.confirm("Switch approvals to yolo?", "I will run everything without asking you. Only the hardline list and your deny list still block.");
      if (!ok) return "Cancelled. Mode stays ask.";
    }
    deps.settings.set(APPROVAL_SETTING_KEYS.mode, value, actor(ctx));
    return value === "ask"
      ? `Mode is now ask (scope: ${deps.engine.policy().askScope}). Risky actions will wait for your Approve or Deny.`
      : "Mode is now yolo. Nothing is asked.";
  };

  const scope = async (ctx: CommandContext): Promise<string> => {
    const value = (ctx.argv[1] ?? "").toLowerCase();
    if (value !== "dangerous" && value !== "all") return "Usage: /approvals scope dangerous|all";
    const current = deps.engine.policy().askScope;
    if (value === current) return `Scope is already ${value}.`;
    if (value === "dangerous") {
      const ok = await ctx.confirm("Narrow the ask scope to dangerous?", "Only risky and unreadable actions will ask; everything else runs.");
      if (!ok) return "Cancelled. Scope stays all.";
    }
    deps.settings.set(APPROVAL_SETTING_KEYS.askScope, value, actor(ctx));
    return `Scope is now ${value}.${deps.engine.policy().mode === "yolo" ? " (It applies once the mode is ask.)" : ""}`;
  };

  const hardline = async (ctx: CommandContext): Promise<string> => {
    const value = (ctx.argv[1] ?? "").toLowerCase();
    if (value !== "on" && value !== "off") return "Usage: /approvals hardline on|off";
    const current = deps.engine.policy().hardline;
    if ((value === "on") === current) return `The hardline list is already ${value}.`;
    if (value === "off") {
      const ok = await ctx.confirm("Turn the hardline list off?", "Catastrophic commands (rm -rf /, rm -rf ~, disk formatting, fork bombs) will no longer be blocked in yolo mode.");
      if (!ok) return "Cancelled. The hardline list stays on.";
    }
    deps.settings.set(APPROVAL_SETTING_KEYS.hardline, value === "on", actor(ctx));
    return `The hardline list is now ${value}.`;
  };

  const reset = async (ctx: CommandContext): Promise<string> => {
    const ok = await ctx.confirm("Reset approvals to config.yaml?", "Drops the mode, scope and hardline overrides and every allow and deny pattern added with /approvals.");
    if (!ok) return "Cancelled. Nothing changed.";
    for (const key of Object.values(APPROVAL_SETTING_KEYS)) deps.settings.delete(key, actor(ctx));
    const p = deps.engine.policy();
    return `Reset. Mode ${p.mode}, scope ${p.askScope}, hardline ${p.hardline ? "on" : "off"}.`;
  };

  return [
    {
      name: "approvals",
      description: "Control what I may run without asking: status, mode, scope, allow, deny, unallow, undeny, list, rules, test, log, hardline, reset",
      category: "security",
      ownerOnly: true,
      scope: "dm",
      args: "[status|mode|scope|allow|deny|unallow|undeny|list|rules|test|log|hardline|reset]",
      usage: `${HELP_TEXT}\n\n${USAGE}`,
      subcommands: {
        status: { description: "Mode, scope, hardline, list sizes, pending prompts, last 24 h" },
        mode: { args: "yolo|ask", description: "Switch mode (yolo asks for confirmation)" },
        scope: { args: "dangerous|all", description: "What asks in ask mode" },
        allow: { args: "<pattern> [--force]", description: "Add an allow pattern" },
        deny: { args: "<pattern>", description: "Add a deny pattern" },
        unallow: { args: "<n|pattern>", description: "Remove an allow pattern" },
        undeny: { args: "<n|pattern>", description: "Remove a deny pattern (asks for confirmation)" },
        list: { description: "Numbered allow and deny lists" },
        rules: { description: "Built-in rule ids" },
        test: { args: "<command>", description: "Dry run, never executes" },
        log: { args: "[n]", description: "Last decisions" },
        hardline: { args: "on|off", description: "The always-deny list (off asks for confirmation)" },
        reset: { description: "Drop all overrides (asks for confirmation)" },
      },
      async handler(ctx) {
        const sub = (ctx.argv[0] ?? "status").toLowerCase();
        switch (sub) {
          case "status": return status();
          case "mode": return mode(ctx);
          case "scope": return scope(ctx);
          case "allow": return addPattern(ctx, "allow");
          case "deny": return addPattern(ctx, "deny");
          case "unallow": return removePattern(ctx, "allow");
          case "undeny": return removePattern(ctx, "deny");
          case "list": return listText();
          case "rules": return rules();
          case "test": return test(ctx);
          case "log": return logText(ctx);
          case "hardline": return hardline(ctx);
          case "reset": return reset(ctx);
          case "help": return `${HELP_TEXT}\n\n${USAGE}`;
          default: return `Unknown subcommand "${sub}".\n\n${USAGE}`;
        }
      },
    },
  ];
}
