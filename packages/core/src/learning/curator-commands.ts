/**
 * `/curator` (PLAN B.12, C.4). Owner-only, DM-only: the command registry checks
 * the owner before a handler runs.
 *
 * /curator status | run [merge] | on | off | reset | list [stale|archived|broken|dupes]
 *          | restore <name> | pin <name> | unpin <name> | usage [name]
 *
 * A run only reports and files proposals; they are approved with /proposals
 * like every other proposal. `restore` moves an archived skill back (an owner
 * command, not a proposal). Nothing here deletes anything.
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { CuratorConfig } from "../config/sections/curator.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { ArchivedSkillEntry, RestoreOutcome } from "./curator-apply.js";
import { CURATOR_ENABLED_SETTING, type CuratorFinding, type CuratorReport, type CuratorRunStore } from "./curator-scheduler.js";
import { USAGE_TRACKING_STARTED_KEY } from "./learning-db.js";
import { SKILL_NAME_RE } from "./proposal-types.js";
import type { SkillStateRecord, SkillStateStore } from "./skill-state-store.js";

export type CuratorCommandRunResult = { status: "ok"; runId: number; report: CuratorReport } | { status: "busy" };

export interface CuratorCommandDeps {
  skillState: SkillStateStore;
  runs: CuratorRunStore;
  kv: { get(key: string): string | undefined };
  settings: Pick<RuntimeSettings, "set" | "delete">;
  audit: Pick<AuditTrail, "record">;
  /** Effective curator.enabled */
  enabled: () => boolean;
  /** Configured (YAML) curator.enabled */
  configEnabled: () => boolean;
  config: () => CuratorConfig;
  run: (opts: { trigger: "command"; merge: boolean }) => Promise<CuratorCommandRunResult>;
  restore: (name: string, actor: string) => RestoreOutcome;
  archived: () => ArchivedSkillEntry[];
  /** A directory `<skillsRoot>/<name>` exists */
  skillExists: (name: string) => boolean;
  nextRunAt: () => Date | null;
  /** Pending proposals filed by the curator */
  pendingCount: () => number;
  /** The LLM merge pass can run (a model call is wired) */
  llmAvailable: () => boolean;
  /** Forget the weekly clock, so turning the run back on starts with a seeding check (no immediate run). */
  resetSchedule?: () => void;
  now?: () => number;
}

const LIST_FILTERS = ["stale", "archived", "broken", "dupes"] as const;
const MAX_LINES = 30;

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "never";
}

function minute(iso: string | null | undefined): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function capped(lines: string[], more: string): string[] {
  return lines.length <= MAX_LINES ? lines : [...lines.slice(0, MAX_LINES), `${lines.length - MAX_LINES} more ${more}`];
}

function findingLine(f: CuratorFinding): string {
  return `${f.skill}${f.root === "user" ? " (~/.claude/skills)" : ""} · ${f.detector} · ${f.message}`.slice(0, 220);
}

/** The text a run reports to the owner (command reply, scheduled-run digest line). */
export function renderCuratorRunSummary(report: CuratorReport): string {
  const c = report.counts;
  const lines = [
    `Skill check: ${plural(c.skills, "skill")}, ${c.broken} broken, ${c.duplicates} duplicate, ${c.stale} stale, ${c.drift} changed outside approval.`,
  ];
  if (report.proposals.length > 0) {
    lines.push(`Filed ${plural(report.proposals.length, "proposal")}: ${report.proposals.map((p) => `#${p.id} ${p.kind.replace("skill.", "")} ${p.skill}`).join(", ")}. Review with /proposals. Nothing changes until you approve.`);
  } else {
    lines.push("No new proposals.");
  }
  if (report.possibleDuplicates.length > 0) {
    lines.push(`Possible duplicates (report only): ${report.possibleDuplicates.slice(0, 5).map((g) => g.join(" + ")).join("; ")}. /curator run merge asks the model for a merge.`);
  }
  if (report.staleMarked.length > 0) lines.push(`Marked stale: ${report.staleMarked.slice(0, 10).join(", ")}.`);
  const dropped = report.dropped.filter((d) => d.reason !== "previously_rejected");
  if (dropped.length > 0) lines.push(`Not filed: ${dropped.slice(0, 5).map((d) => `${d.skill} (${d.reason})`).join(", ")}.`);
  if (report.llm.calls > 0) lines.push(`Merge pass: ${plural(report.llm.calls, "model call")}, $${report.llm.costUsd.toFixed(3)}.`);
  if (report.errors.length > 0) lines.push(`Problems: ${report.errors.slice(0, 3).join("; ")}.`);
  return lines.join("\n");
}

function usageLine(r: SkillStateRecord): string {
  const flags = [r.pinned ? "pinned" : null, r.override ? "override" : null].filter(Boolean).join(", ");
  return `${r.name} · ${r.source} · ${r.state}${flags ? ` (${flags})` : ""} · ${r.useCount} uses · last ${day(r.lastUsedAt)}`;
}

export function createCuratorCommands(deps: CuratorCommandDeps): CommandDefinition[] {
  const lastReport = (): CuratorReport | null => deps.runs.last()?.report ?? null;

  const status = (): string => {
    const enabled = deps.enabled();
    const cfg = deps.config();
    const source = enabled === deps.configEnabled() ? "config" : "runtime override";
    const last = deps.runs.last();
    const rows = deps.skillState.list({ root: "project" });
    const bySource = new Map<string, number>();
    const byState = new Map<string, number>();
    for (const r of rows) {
      bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
      byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
    }
    const fmt = (m: Map<string, number>): string => [...m].map(([k, n]) => `${n} ${k}`).join(", ") || "none";
    const next = deps.nextRunAt();
    const lines = [
      `Skill curator, weekly run: ${enabled ? "on" : "off"} (${source}). It only reports and proposes; nothing changes until you approve with /proposals.`,
      `Last run: ${last ? `${minute(last.finishedAt ?? last.startedAt)} (${last.trigger})` : "never"}`,
    ];
    if (last?.report) {
      const c = last.report.counts;
      lines.push(`Last findings: ${c.broken} broken, ${c.duplicates} duplicate, ${c.stale} stale, ${c.drift} drift; ${plural(c.proposals, "proposal")} filed`);
    }
    lines.push(
      `Next scheduled run: ${!enabled ? "off" : next ? `after ${minute(next.toISOString())} at ${String(cfg.preferredHour).padStart(2, "0")}:00 local, when idle` : "not scheduled yet (the first hourly check only sets the clock)"}`,
      `Usage tracked since: ${day(deps.kv.get(USAGE_TRACKING_STARTED_KEY))}. Stale after ${cfg.staleAfterDays} days, archive proposed after ${cfg.archiveAfterDays} days${cfg.pruneBundled ? "" : " (bundled skills excluded)"}.`,
      `Skills: ${fmt(bySource)}. States: ${fmt(byState)}.`,
      `Pending curator proposals: ${deps.pendingCount()}`,
    );
    return lines.join("\n");
  };

  const list = (filter: string | undefined): string => {
    if (filter === "archived") {
      const dirs = deps.archived();
      const rows = deps.skillState.list({ root: "project", state: "archived" });
      if (dirs.length === 0 && rows.length === 0) return "No archived skills.";
      const lines = dirs.map((a) => `${a.name} · archived ${day(a.manifest?.archivedAt)}${a.manifest?.reason ? ` · ${a.manifest.reason}` : ""}`.slice(0, 220));
      const withoutDir = rows.filter((r) => !dirs.some((d) => d.name === r.name));
      for (const r of withoutDir) lines.push(`${r.name} · ${r.archivePath ? "archived" : "gone (removed outside the curator, no archive copy)"} ${day(r.archivedAt)}`);
      return ["Archived skills (restore with /curator restore <name>):", ...capped(lines, "archived")].join("\n");
    }
    if (filter === "stale") {
      const rows = deps.skillState.list({ root: "project", state: "stale" });
      if (rows.length === 0) return "No stale skills.";
      return ["Stale skills (no recorded use; pin one to keep it with /curator pin <name>):", ...capped(rows.map(usageLine), "stale")].join("\n");
    }
    const report = lastReport();
    if (!report) return "No curator run yet. Start one with /curator run.";
    if (filter === "broken") {
      const f = report.findings.filter((x) => x.category === "broken");
      return f.length === 0 ? "No broken skills in the last run." : ["Broken skills (last run):", ...capped(f.map(findingLine), "findings")].join("\n");
    }
    if (filter === "dupes") {
      const f = report.findings.filter((x) => x.category === "duplicate");
      const lines = f.map(findingLine);
      for (const g of report.possibleDuplicates) lines.push(`possible group: ${g.join(" + ")}`);
      return lines.length === 0 ? "No duplicates in the last run." : ["Duplicates (last run):", ...capped(lines, "findings")].join("\n");
    }
    const lines = report.findings.filter((x) => x.severity !== "info").map(findingLine);
    return [
      `Last run ${minute(report.finishedAt)}: ${plural(report.findings.length, "finding")}.`,
      ...(lines.length > 0 ? capped(lines, "findings") : ["Nothing above info level."]),
      "Filters: /curator list stale | archived | broken | dupes",
    ].join("\n");
  };

  const usage = (name: string | undefined): string => {
    if (name) {
      if (!SKILL_NAME_RE.test(name)) return `"${name}" is not a valid skill name.`;
      const row = deps.skillState.findByName(name);
      if (!row) return `No usage recorded for "${name}".`;
      const events = deps.skillState.usage({ skill: name, limit: 10 });
      return [
        usageLine(row),
        `First seen ${day(row.firstSeenAt)}.`,
        ...(events.length > 0 ? ["Recent uses:", ...events.map((e) => `${minute(e.ts)} · ${e.source} · ${e.via}`)] : ["No use events recorded."]),
      ].join("\n");
    }
    const rows = deps.skillState.list({ root: "project" }).filter((r) => r.state !== "archived");
    if (rows.length === 0) return "No skills recorded yet.";
    const top = [...rows].sort((a, b) => b.useCount - a.useCount || a.name.localeCompare(b.name)).slice(0, 15);
    return [`Most used skills (tracked since ${day(deps.kv.get(USAGE_TRACKING_STARTED_KEY))}):`, ...top.map(usageLine)].join("\n");
  };

  const pin = (ctx: CommandContext, name: string | undefined, pinned: boolean): string => {
    const verb = pinned ? "pin" : "unpin";
    if (!name || !SKILL_NAME_RE.test(name)) return `Usage: /curator ${verb} <name>`;
    let row = deps.skillState.get("project", name);
    if (!row && deps.skillExists(name)) {
      deps.skillState.insert({ name, root: "project", source: "local" });
      row = deps.skillState.get("project", name);
    }
    if (!row) return `No skill named "${name}".`;
    deps.skillState.setPinned("project", name, pinned);
    deps.audit.record({ feature: "curator", action: pinned ? "skill.pinned" : "skill.unpinned", actor: actorOf(ctx), detail: { skill: name } });
    return pinned
      ? `Pinned ${name}. The curator will never mark it stale or propose archiving it.`
      : `Unpinned ${name}.`;
  };

  const curator: CommandDefinition = {
    name: "curator",
    description: "Skill cleanup: status, run, on, off, list, restore, pin, unpin, usage",
    category: "learning",
    ownerOnly: true,
    scope: "dm",
    args: "status | run [merge] | on | off | reset | list [stale|archived|broken|dupes] | restore <name> | pin <name> | unpin <name> | usage [name]",
    usage:
      "/curator status: weekly run flag, last run, next run, totals\n" +
      "/curator run [merge]: check the skills now (merge: also ask the model about possible duplicates)\n" +
      "/curator on | off: the weekly automatic run; reset uses the config value\n" +
      "/curator list [stale|archived|broken|dupes]: findings of the last run, or skills by state\n" +
      "/curator restore <name>: move an archived skill back\n" +
      "/curator pin <name> | unpin <name>: keep a skill from ever being marked stale or archived\n" +
      "/curator usage [name]: most used skills, or one skill's history\n" +
      "The curator only proposes. Approve or reject its proposals with /proposals.",
    subcommands: {
      status: { description: "Show curator status" },
      run: { args: "[merge]", description: "Check the skills now" },
      on: { description: "Turn the weekly run on" },
      off: { description: "Turn the weekly run off" },
      reset: { description: "Use the config value again" },
      list: { args: "[stale|archived|broken|dupes]", description: "List findings or skills" },
      restore: { args: "<name>", description: "Move an archived skill back" },
      pin: { args: "<name>", description: "Never mark this skill stale" },
      unpin: { args: "<name>", description: "Remove a pin" },
      usage: { args: "[name]", description: "Skill usage" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "status").toLowerCase();
      const arg = ctx.argv[1]?.trim();
      switch (sub) {
        case "status":
          return status();
        case "run": {
          if (arg !== undefined && arg.toLowerCase() !== "merge") return "Usage: /curator run [merge]";
          const merge = arg?.toLowerCase() === "merge";
          if (merge && !deps.llmAvailable()) return "The merge pass needs a model call, which is not available here.";
          const res = await deps.run({ trigger: "command", merge });
          if (res.status === "busy") return "A curator run is already in progress.";
          return renderCuratorRunSummary(res.report);
        }
        case "on":
        case "off": {
          const on = sub === "on";
          if (on && !deps.enabled()) deps.resetSchedule?.();
          deps.settings.set(CURATOR_ENABLED_SETTING, on, actorOf(ctx));
          deps.audit.record({ feature: "curator", action: on ? "curator.enabled" : "curator.disabled", actor: actorOf(ctx) });
          return on
            ? `Weekly skill check is on. The first hourly check only sets the clock; the first run comes about ${deps.config().intervalHours} hours later. It only files proposals.`
            : "Weekly skill check is off. /curator run still works on demand.";
        }
        case "reset":
          deps.settings.delete(CURATOR_ENABLED_SETTING, actorOf(ctx));
          return `Override removed. The weekly skill check is ${deps.configEnabled() ? "on" : "off"} (config).`;
        case "list": {
          const filter = arg?.toLowerCase();
          if (filter !== undefined && !(LIST_FILTERS as readonly string[]).includes(filter)) return `Usage: /curator list [${LIST_FILTERS.join("|")}]`;
          return list(filter);
        }
        case "restore": {
          if (!arg) return "Usage: /curator restore <name>";
          const out = deps.restore(arg, actorOf(ctx));
          return out.ok ? `Restored ${out.name}. It is active from the next session.` : out.message;
        }
        case "pin":
        case "unpin":
          return pin(ctx, arg, sub === "pin");
        case "usage":
          return usage(arg);
        default:
          return `Unknown subcommand "${sub}". Try /help curator.`;
      }
    },
  };
  return [curator];
}
