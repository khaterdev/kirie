/**
 * /goal (PLAN B.12, C.7). Owner-only, DM-only (the registry enforces both).
 *
 *   /goal <text> [--check "<cmd>"]... [--rounds N] [--time 90m] [--budget 5] [--cwd <path>]
 *   /goal start <text> ...        same, for a goal text that starts with a subcommand word
 *   /goal | /goal list
 *   /goal status [id]
 *   /goal pause [id] | /goal stop [id]
 *   /goal resume [id] [--budget N] [instructions]
 *   /goal on | /goal off
 *
 * Check commands are taken verbatim from the owner's message, run through the
 * tool-gate chain before the goal is created (deny rejects it, ask needs a
 * Confirm tap), and never change afterwards.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { CommandContext, CommandDefinition, CommandResult } from "../commands/types.js";
import { parseDuration, parseIntInRange } from "../commands/parse.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { GoalsConfig } from "../config/sections/goals.js";
import type { GoalController } from "./goal-controller.js";
import {
  GOAL_ID_RE,
  GOAL_OPEN_STATUSES,
  GOAL_RESUMABLE_STATUSES,
  type GoalCheck,
  type GoalRecord,
  type GoalStatus,
} from "./goal-store.js";
import { formatGoalCaps, formatGoalCost, formatGoalElapsed, formatGoalLine, goalElapsedMs } from "./goal-format.js";

/** Bounds an owner may ask for (the schema bounds of goals.*). */
export const GOAL_OWNER_BOUNDS = {
  rounds: { min: 1, max: 100 },
  minutes: { min: 1, max: 1440 },
  budgetUsd: { min: 0.1, max: 1000 },
} as const;
export const GOAL_TEXT_MAX_CHARS = 4000;
export const GOAL_CHECK_MAX_CHARS = 1000;
export const GOAL_SETTING_KEY = "goals.enabled";

export const GOAL_OFF_TEXT = "Goals are off. Turn them on with /goal on, then send your /goal again.";

const SUBCOMMANDS = new Set(["list", "status", "pause", "resume", "stop", "on", "off", "start", "help"]);

export const GOAL_USAGE = [
  "/goal <text> [--check \"<cmd>\"]... [--rounds N] [--time 90m] [--budget 5] [--cwd <path>]",
  "  Work on a goal in the background until a judge confirms it is done.",
  "  Every --check command must exit 0 before the judge is asked; the judge can never override a failing check.",
  "  Stops at the round, time or estimated-cost cap.",
  "  Example: /goal fix the failing auth tests --check \"pnpm vitest run packages/core\" --rounds 8 --time 1h",
  "/goal start <text> ...   same, when the text starts with a word like stop or list",
  "/goal list | /goal status [id]",
  "/goal pause [id] | /goal resume [id] [--budget N] [instructions] | /goal stop [id]",
  "/goal on | /goal off   (off by default)",
].join("\n");

export interface GoalCommandDeps {
  controller: Pick<GoalController, "reviewChecks" | "createGoal" | "get" | "list" | "openGoals" | "stop" | "pause" | "resume">;
  settings: Pick<RuntimeSettings, "set">;
  isEnabled: () => boolean;
  config: () => GoalsConfig;
  /** Where checks run without --cwd */
  defaultCwd: string;
  now?: () => number;
}

export interface ParsedGoalStart {
  text: string;
  checks: string[];
  rounds?: number;
  minutes?: number;
  budgetUsd?: number;
  cwd?: string;
}

/** Parse the tokens of `/goal [start] <text> [flags]`. Returns an error string on bad input. */
export function parseGoalStartArgs(argv: readonly string[], opts: { maxChecks: number }): ParsedGoalStart | { error: string } {
  const words: string[] = [];
  const out: ParsedGoalStart = { text: "", checks: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) {
      words.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = (eq > 0 ? tok.slice(2, eq) : tok.slice(2)).toLowerCase();
    let value: string | undefined;
    if (eq > 0) value = tok.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined) return { error: `--${flag} needs a value.` };
    switch (flag) {
      case "check": {
        const cmd = value.trim();
        if (!cmd) return { error: "--check needs a command." };
        if (cmd.length > GOAL_CHECK_MAX_CHARS) return { error: `A check command may be at most ${GOAL_CHECK_MAX_CHARS} characters.` };
        if (/[\r\n\0]/.test(cmd)) return { error: "A check command must be one line." };
        out.checks.push(cmd);
        break;
      }
      case "rounds": {
        const n = parseIntInRange(value, GOAL_OWNER_BOUNDS.rounds.min, GOAL_OWNER_BOUNDS.rounds.max);
        if (n === null) return { error: `--rounds must be a whole number from ${GOAL_OWNER_BOUNDS.rounds.min} to ${GOAL_OWNER_BOUNDS.rounds.max}.` };
        out.rounds = n;
        break;
      }
      case "time": {
        const ms = /^\d+$/.test(value.trim())
          ? Number(value.trim()) * 60_000
          : parseDuration(value);
        const minutes = ms === null ? null : Math.ceil(ms / 60_000);
        if (minutes === null || minutes < GOAL_OWNER_BOUNDS.minutes.min || minutes > GOAL_OWNER_BOUNDS.minutes.max) {
          return { error: "--time must be a duration from 1m to 24h, for example 90m or 2h." };
        }
        out.minutes = minutes;
        break;
      }
      case "budget": {
        const v = value.trim().replace(/^\$/, "");
        const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
        if (!(n >= GOAL_OWNER_BOUNDS.budgetUsd.min && n <= GOAL_OWNER_BOUNDS.budgetUsd.max)) {
          return { error: `--budget must be a dollar amount from ${GOAL_OWNER_BOUNDS.budgetUsd.min} to ${GOAL_OWNER_BOUNDS.budgetUsd.max}.` };
        }
        out.budgetUsd = n;
        break;
      }
      case "cwd": {
        if (!value.trim()) return { error: "--cwd needs a path." };
        out.cwd = value.trim();
        break;
      }
      default:
        return { error: `Unknown option --${flag}.` };
    }
  }
  if (out.checks.length > opts.maxChecks) return { error: `At most ${opts.maxChecks} checks per goal.` };
  out.text = words.join(" ").trim();
  if (!out.text) return { error: "Say what the goal is." };
  if (out.text.length > GOAL_TEXT_MAX_CHARS) return { error: `A goal may be at most ${GOAL_TEXT_MAX_CHARS} characters.` };
  return out;
}

/** Expand ~, require an absolute path to an existing directory. */
export function resolveGoalCwd(raw: string): string | { error: string } {
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return { error: "--cwd must be an absolute path (or start with ~/)." };
  const path = resolve(expanded);
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return { error: `--cwd ${path} is not a directory.` };
  } catch {
    return { error: `--cwd ${path} is not readable.` };
  }
  return path;
}

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

/** Pick the goal a subcommand means: the given id, or the only goal in `statuses`. */
function pickGoal(
  deps: GoalCommandDeps,
  idArg: string | undefined,
  statuses: readonly GoalStatus[],
  verb: string,
): GoalRecord | string {
  if (idArg !== undefined) {
    const id = idArg.toLowerCase();
    if (!GOAL_ID_RE.test(id)) {
      return `"${idArg}" is not a goal id (they look like g-ab12cd). To start a goal whose text begins with "${verb}", use /goal start <text>.`;
    }
    return deps.controller.get(id) ?? `No goal ${id}.`;
  }
  const candidates = deps.controller.openGoals().filter((g) => statuses.includes(g.status));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) return `No goal to ${verb}.`;
  return `Several goals could be meant: ${candidates.map((g) => g.id).join(", ")}. Use /goal ${verb} <id>.`;
}

export function formatGoalStatus(goal: GoalRecord, now: number): string {
  const lines = [
    `Goal ${goal.id}: ${goal.status.replace("_", " ")}${goal.roundsUsed > 0 ? ` (round ${goal.roundsUsed}/${goal.roundLimit})` : ""}`,
    goal.goal.length > 500 ? `${goal.goal.slice(0, 499)}…` : goal.goal,
    `Created by the ${goal.createdBy} at ${goal.createdAt}. Chat: ${goal.sessionKey}`,
    `Caps: ${formatGoalCaps(goal)}. Used: ${goal.roundsUsed} round(s), ${formatGoalElapsed(goalElapsedMs(goal, now))}, about ${formatGoalCost(goal.costUsd)}.`,
  ];
  if (goal.cwd) lines.push(`Directory: ${goal.cwd}`);
  lines.push(goal.checks.length > 0 ? `Checks: ${goal.checks.map((c) => c.command).join(" ; ")}` : "Checks: none");
  if (goal.pauseRequested) lines.push("Pause requested: takes effect at the end of this round.");
  if (goal.lastVerdict) {
    lines.push(`Last verdict: ${goal.lastVerdict.verdict} (${goal.lastVerdict.source}): ${goal.lastVerdict.reason}`);
    if (goal.lastVerdict.missing.length > 0) lines.push(`Missing: ${goal.lastVerdict.missing.join("; ")}`);
  }
  const failed = goal.lastChecks?.find((c) => !c.passed);
  if (failed) {
    lines.push(`Last failing check: ${failed.command} (${failed.timedOut ? "timed out" : `exit ${failed.exitCode ?? "none"}`})`);
    if (failed.output) lines.push(failed.output.slice(-500));
  } else if (goal.lastChecks && goal.lastChecks.length > 0) {
    lines.push("Last checks: all passed");
  }
  if (goal.stopReason) lines.push(`Reason: ${goal.stopReason}`);
  return lines.join("\n");
}

export function createGoalCommands(deps: GoalCommandDeps): CommandDefinition[] {
  const now = deps.now ?? Date.now;

  const list = (): string => {
    const open = deps.controller.openGoals();
    const recent = deps.controller.list({ limit: 10 }).filter((g) => !open.some((o) => o.id === g.id));
    if (open.length === 0 && recent.length === 0) {
      return deps.isEnabled() ? "No goals yet. Start one with /goal <text>." : `No goals yet. ${GOAL_OFF_TEXT}`;
    }
    const lines: string[] = [];
    if (open.length > 0) lines.push("Open:", ...open.map((g) => formatGoalLine(g, now())));
    if (recent.length > 0) lines.push(...(lines.length ? [""] : []), "Recent:", ...recent.slice(0, 5).map((g) => formatGoalLine(g, now())));
    if (!deps.isEnabled()) lines.push("", GOAL_OFF_TEXT);
    return lines.join("\n");
  };

  const start = async (ctx: CommandContext, argv: readonly string[]): Promise<CommandResult> => {
    if (!deps.isEnabled()) return GOAL_OFF_TEXT;
    const cfg = deps.config();
    const parsed = parseGoalStartArgs(argv, { maxChecks: cfg.maxChecks });
    if ("error" in parsed) return `${parsed.error}\n\n${GOAL_USAGE}`;
    let cwd: string | null = null;
    if (parsed.cwd !== undefined) {
      const r = resolveGoalCwd(parsed.cwd);
      if (typeof r !== "string") return r.error;
      cwd = r;
    }
    const checks: GoalCheck[] = parsed.checks.map((command) => ({ command, timeoutSec: cfg.checkTimeoutSeconds }));
    const review = await deps.controller.reviewChecks(parsed.checks, ctx.sessionKey, cwd ?? deps.defaultCwd);
    if (review.denied.length > 0) {
      const d = review.denied[0]!;
      return `Goal not started: the check "${d.command}" is denied by the tool gates (${d.reasons.join("; ") || "no reason given"}).`;
    }
    const asks = review.reviews.filter((r) => r.decision === "ask");
    const maxRounds = parsed.rounds ?? cfg.maxRounds;
    const maxMinutes = parsed.minutes ?? cfg.maxMinutes;
    const maxCostUsd = parsed.budgetUsd ?? cfg.maxCostUsd;
    if (asks.length > 0) {
      const body = [
        parsed.text.slice(0, 1000),
        "",
        "These check commands need your approval. The daemon will run them after every round without asking again:",
        ...asks.map((a) => `- ${a.command}${a.reasons.length ? ` (${a.reasons.join("; ")})` : ""}`),
        "",
        `Caps: ${maxRounds} rounds, ${formatGoalElapsed(maxMinutes * 60_000)}, ${formatGoalCost(maxCostUsd)}.`,
      ].join("\n");
      const ok = await ctx.confirm("Start this goal?", body);
      if (!ok) return "Goal not started.";
    }
    const goal = deps.controller.createGoal({
      sessionKey: ctx.sessionKey,
      goal: parsed.text,
      checks,
      checkReview: review.reviews,
      cwd,
      maxRounds,
      maxMinutes,
      maxCostUsd,
      actor: actorOf(ctx),
    });
    if (goal.status === "pending") {
      return `Goal ${goal.id} is queued (at most ${cfg.maxConcurrent} goal(s) run at a time). Caps: ${formatGoalCaps(goal)}.`;
    }
    // The controller has announced the start in this chat.
    return undefined;
  };

  return [
    {
      name: "goal",
      description: "Work on a goal in the background until a judge confirms it is done: start, list, status, pause, resume, stop, on, off",
      category: "automation",
      ownerOnly: true,
      scope: "dm",
      args: "<text> [--check \"<cmd>\"] | list | status | pause | resume | stop | on | off",
      usage: GOAL_USAGE,
      subcommands: {
        start: { args: "<text> [flags]", description: "Start a goal (same as /goal <text>)" },
        list: { description: "Open and recent goals" },
        status: { args: "[id]", description: "Round, time, cost, last verdict and check output" },
        pause: { args: "[id]", description: "Pause at the end of the current round" },
        resume: { args: "[id] [--budget N] [instructions]", description: "Resume with a fresh allowance of rounds and time" },
        stop: { args: "[id]", description: "Stop the goal and its worker" },
        on: { description: "Allow goals (off by default)" },
        off: { description: "Stop new goals from starting" },
      },
      async handler(ctx): Promise<CommandResult> {
        const argv = ctx.argv;
        const sub = argv[0]?.toLowerCase();
        if (argv.length === 0 || sub === "list") return list();
        if (sub === undefined || !SUBCOMMANDS.has(sub)) return start(ctx, argv);
        const rest = argv.slice(1);
        switch (sub) {
          case "help":
            return GOAL_USAGE;
          case "start":
            return start(ctx, rest);
          case "on":
          case "off": {
            const enable = sub === "on";
            deps.settings.set(GOAL_SETTING_KEY, enable, actorOf(ctx));
            if (enable) return "Goals are on. Start one with /goal <text>. Goals the agent asks for still need your tap on Start.";
            const running = deps.controller.openGoals().filter((g) => ["running", "checking", "judging"].includes(g.status));
            return running.length > 0
              ? `Goals are off: nothing new starts. ${running.length} goal(s) still running (${running.map((g) => g.id).join(", ")}); /goal stop <id> ends one.`
              : "Goals are off: nothing new starts.";
          }
          case "status": {
            if (rest.length === 0) {
              const open = deps.controller.openGoals();
              if (open.length > 1) return `Several goals are open: ${open.map((g) => g.id).join(", ")}. Use /goal status <id>.`;
              const goal = open[0] ?? deps.controller.list({ limit: 1 })[0];
              return goal ? formatGoalStatus(goal, now()) : "No goals yet.";
            }
            const picked = pickGoal(deps, rest[0], GOAL_OPEN_STATUSES, "status");
            return typeof picked === "string" ? picked : formatGoalStatus(picked, now());
          }
          case "pause": {
            const picked = pickGoal(deps, rest[0], ["pending", "running", "checking", "judging"], "pause");
            return typeof picked === "string" ? picked : deps.controller.pause(picked.id, actorOf(ctx)).text;
          }
          case "stop": {
            const picked = pickGoal(deps, rest[0], GOAL_OPEN_STATUSES, "stop");
            return typeof picked === "string" ? picked : deps.controller.stop(picked.id, actorOf(ctx)).text;
          }
          case "resume": {
            let idArg: string | undefined;
            let i = 0;
            if (rest[0] !== undefined && GOAL_ID_RE.test(rest[0].toLowerCase())) {
              idArg = rest[0];
              i = 1;
            }
            let addBudgetUsd: number | undefined;
            const noteWords: string[] = [];
            for (; i < rest.length; i++) {
              const tok = rest[i]!;
              if (tok === "--budget" || tok.startsWith("--budget=")) {
                const raw = tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : rest[++i];
                const v = (raw ?? "").trim().replace(/^\$/, "");
                const n = /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
                if (!(n >= GOAL_OWNER_BOUNDS.budgetUsd.min && n <= GOAL_OWNER_BOUNDS.budgetUsd.max)) {
                  return `--budget must be a dollar amount from ${GOAL_OWNER_BOUNDS.budgetUsd.min} to ${GOAL_OWNER_BOUNDS.budgetUsd.max}.`;
                }
                addBudgetUsd = n;
              } else {
                noteWords.push(tok);
              }
            }
            const picked = pickGoal(deps, idArg, GOAL_RESUMABLE_STATUSES, "resume");
            if (typeof picked === "string") return picked;
            const note = noteWords.join(" ").trim();
            return deps.controller.resume(picked.id, actorOf(ctx), {
              ...(note ? { note } : {}),
              ...(addBudgetUsd !== undefined ? { addBudgetUsd } : {}),
            }).text;
          }
          default:
            return GOAL_USAGE;
        }
      },
    },
  ];
}
