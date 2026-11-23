/**
 * /loop: re-run a prompt in this chat on an interval (PLAN C.8, R2 section 3).
 * Owner-only, DM-only (checked by the registry). Ships off: `/loop on` sets
 * the runtime override `loops.enabled`; `/loop off` clears it to false and
 * pauses every active loop.
 */

import type { LoopsConfig } from "../config/sections/loops.js";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { formatDuration, parseDuration, parseIntInRange } from "../commands/parse.js";
import { LOOP_ENDED_STATUSES, LOOP_ID_RE, type LoopRecord, type LoopStore } from "./loop-store.js";
import {
  LOOP_OWNER_MAX_RUNS,
  LOOP_PROMPT_MAX_CHARS,
  LOOP_RESTART_DELAY_MS,
  checkLoopLimits,
  type LoopService,
} from "./loop-service.js";

export interface LoopCommandDeps {
  store: LoopStore;
  service: Pick<LoopService, "reload" | "runNow">;
  config: () => LoopsConfig;
  isEnabled: () => boolean;
  /** Persist the `loops.enabled` override */
  setEnabled: (on: boolean, by: string) => void;
  audit?: (action: string, actor: string, loop: LoopRecord | null, detail?: Record<string, unknown>) => void;
  now?: () => number;
}

export interface ParsedLoopStart {
  interval: string;
  prompt: string;
  times?: string;
  forText?: string;
  noBackoff: boolean;
}

const FLAG_TIMES_RE = /(^|\s)--times(?:=|\s+)(\S+)(?=\s|$)/i;
const FLAG_FOR_RE = /(^|\s)--for(?:=|\s+)(\S+)(?=\s|$)/i;
const FLAG_NO_BACKOFF_RE = /(^|\s)--no-backoff(?=\s|$)/i;

/** Split "<interval> <prompt> [--times N] [--for 6h] [--no-backoff]" (flags may appear anywhere). */
export function parseLoopStartArgs(args: string): ParsedLoopStart {
  let rest = ` ${args} `;
  const take = (re: RegExp): string | undefined => {
    const m = re.exec(rest);
    if (!m) return undefined;
    rest = rest.slice(0, m.index) + (m[1] ?? "") + rest.slice(m.index + m[0].length);
    return m[2];
  };
  const times = take(FLAG_TIMES_RE);
  const forText = take(FLAG_FOR_RE);
  const noBackoff = FLAG_NO_BACKOFF_RE.test(rest);
  if (noBackoff) rest = rest.replace(FLAG_NO_BACKOFF_RE, "$1");
  const trimmed = rest.trim();
  const space = trimmed.search(/\s/);
  const interval = space === -1 ? trimmed : trimmed.slice(0, space);
  const prompt = space === -1 ? "" : trimmed.slice(space).trim();
  return { interval, prompt, ...(times !== undefined ? { times } : {}), ...(forText !== undefined ? { forText } : {}), noBackoff };
}

const USAGE = [
  "/loop <interval> <prompt> [--times N] [--for 6h] [--no-backoff] - start a loop in this chat",
  "/loop list - the loops",
  "/loop pause <id> | resume <id> | stop <id> | stop all",
  "/loop now <id> - run one check now (the reply is always shown)",
  "/loop on | off - turn loops on or off",
].join("\n");

const OFF_TEXT = "Loops are off. Turn them on with /loop on, then send this again.";

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

export function createLoopCommands(deps: LoopCommandDeps): CommandDefinition[] {
  const now = deps.now ?? Date.now;
  const relative = (ms: number): string => {
    const d = ms - now();
    if (d <= 1000) return "now";
    return `in ${formatDuration(d)}`;
  };
  const short = (text: string, n = 80): string => (text.length > n ? `${text.slice(0, n)}…` : text);

  function describe(loop: LoopRecord): string {
    const every = formatDuration(loop.baseIntervalSec * 1000);
    const current = loop.currentIntervalSec !== loop.baseIntervalSec ? ` (now ${formatDuration(loop.currentIntervalSec * 1000)})` : "";
    const parts = [`${loop.id} ${loop.status === "paused" && loop.pauseReason ? `paused (${loop.pauseReason})` : loop.status.replace("_", " ")}`,
      `every ${every}${current}`, `run ${loop.runs}/${loop.maxRuns}`];
    if (loop.status === "active") parts.push(`next ${relative(loop.nextRunAt)}`);
    if (!LOOP_ENDED_STATUSES.has(loop.status)) parts.push(`ends ${relative(loop.expiresAt)}`);
    if (loop.createdBy === "agent") parts.push("by the agent");
    return `${parts.join(" · ")}\n  "${short(loop.prompt)}"`;
  }

  function list(): string {
    const loops = deps.store.list({ statuses: ["active", "paused", "pending_approval"] });
    const head = deps.isEnabled() ? "Loops are on." : "Loops are off (/loop on turns them on).";
    if (loops.length === 0) return `${head}\nNo loops. Start one with /loop 5m <what to check>.`;
    return [`${head} ${loops.length} loop${loops.length === 1 ? "" : "s"}:`, ...loops.map(describe)].join("\n");
  }

  function idArg(ctx: CommandContext): string | null {
    const id = (ctx.argv[1] ?? "").toLowerCase();
    return LOOP_ID_RE.test(id) ? id : null;
  }

  function start(ctx: CommandContext, cfg: LoopsConfig): string {
    if (!deps.isEnabled()) return OFF_TEXT;
    const parsed = parseLoopStartArgs(ctx.args);
    const intervalMs = parseDuration(parsed.interval);
    if (intervalMs === null) return `I could not read "${parsed.interval}" as an interval.\n${USAGE}`;
    if (!parsed.prompt) return "Say what to check after the interval, for example: /loop 5m check whether the deploy of api finished";
    if (parsed.prompt.length > LOOP_PROMPT_MAX_CHARS) return `The prompt can be at most ${LOOP_PROMPT_MAX_CHARS} characters.`;
    let maxRuns = cfg.defaultMaxRuns;
    if (parsed.times !== undefined) {
      const n = parseIntInRange(parsed.times, 1, LOOP_OWNER_MAX_RUNS);
      if (n === null) return `--times must be a whole number from 1 to ${LOOP_OWNER_MAX_RUNS}.`;
      maxRuns = n;
    }
    let expiryMs = cfg.defaultExpiryHours * 3_600_000;
    if (parsed.forText !== undefined) {
      const ms = parseDuration(parsed.forText);
      if (ms === null) return `I could not read "${parsed.forText}" as a duration for --for. Examples: 2h, 1d.`;
      expiryMs = ms;
    }
    const intervalSec = Math.round(intervalMs / 1000);
    const problem = checkLoopLimits(cfg, { intervalSec, maxRuns, expiryMs, createdBy: "owner" });
    if (problem) return problem;
    if (deps.store.count("active") >= cfg.maxActive) {
      return `${cfg.maxActive} loops are already active, the most allowed. Stop one first (/loop list).`;
    }
    const t = now();
    const loop = deps.store.create({
      sessionKey: ctx.sessionKey,
      channel: ctx.message.channel,
      chatId: ctx.message.chatId,
      chatType: ctx.message.chatType,
      prompt: parsed.prompt,
      intervalSec,
      backoff: !parsed.noBackoff,
      maxRuns,
      expiresAt: t + expiryMs,
      createdBy: "owner",
      status: "active",
      nextRunAt: t,
      now: t,
    });
    deps.audit?.("loop.created", actor(ctx), loop, { intervalSec, maxRuns, expiryMs, backoff: loop.backoff });
    deps.service.reload();
    const backoffText = loop.backoff
      ? `While nothing changes I check less often, up to every ${formatDuration(Math.min(intervalSec * cfg.backoffMaxMultiplier, cfg.maxIntervalSeconds) * 1000)}.`
      : "Fixed interval (no backoff).";
    return [
      `Started loop ${loop.id}: every ${formatDuration(intervalMs)}, up to ${maxRuns} run${maxRuns === 1 ? "" : "s"}, for ${formatDuration(expiryMs)}. The first check runs in a few seconds.`,
      `I stay quiet unless something changes. ${backoffText}`,
      `Stop it with /loop stop ${loop.id}.`,
    ].join("\n");
  }

  async function handle(ctx: CommandContext): Promise<string> {
    const cfg = deps.config();
    const sub = (ctx.argv[0] ?? "").toLowerCase();
    const t = now();

    switch (sub) {
      case "":
      case "list":
        return list();

      case "help":
        return USAGE;

      case "on": {
        deps.setEnabled(true, actor(ctx));
        const resumed: string[] = [];
        for (const loop of deps.store.list({ statuses: ["paused"] })) {
          if (loop.pauseReason !== "disabled") continue;
          if (deps.store.transition(loop.id, ["paused"], { status: "active", pauseReason: null, nextRunAt: t + LOOP_RESTART_DELAY_MS }, t)) {
            resumed.push(loop.id);
          }
        }
        deps.audit?.("loops.on", actor(ctx), null, { resumed: resumed.length });
        deps.service.reload();
        const tail = resumed.length ? ` Resumed ${resumed.length} loop${resumed.length === 1 ? "" : "s"} paused by /loop off: ${resumed.join(", ")}.` : "";
        return `Loops are on. Start one with /loop <interval> <prompt>; loops the agent proposes still wait for your tap.${tail}`;
      }

      case "off": {
        deps.setEnabled(false, actor(ctx));
        const paused: string[] = [];
        for (const loop of deps.store.list({ statuses: ["active"] })) {
          if (deps.store.transition(loop.id, ["active"], { status: "paused", pauseReason: "disabled" }, t)) paused.push(loop.id);
        }
        deps.audit?.("loops.off", actor(ctx), null, { paused: paused.length });
        deps.service.reload();
        const tail = paused.length ? ` Paused ${paused.length} loop${paused.length === 1 ? "" : "s"}; /loop on resumes them.` : "";
        return `Loops are off.${tail}`;
      }

      case "pause": {
        const id = idArg(ctx);
        if (!id) return "Usage: /loop pause <id>. /loop list shows the ids.";
        const loop = deps.store.get(id);
        if (!loop) return `No loop ${id}.`;
        if (loop.status !== "active") return `Loop ${id} is ${loop.status.replace("_", " ")}, not active.`;
        const updated = deps.store.transition(id, ["active"], { status: "paused", pauseReason: "owner" }, t);
        if (!updated) return `Loop ${id} changed meanwhile; see /loop list.`;
        deps.audit?.("loop.paused", actor(ctx), updated, { reason: "owner" });
        deps.service.reload();
        return `Paused loop ${id}. /loop resume ${id} continues it.`;
      }

      case "resume": {
        const id = idArg(ctx);
        if (!id) return "Usage: /loop resume <id>. /loop list shows the ids.";
        if (!deps.isEnabled()) return OFF_TEXT;
        const loop = deps.store.get(id);
        if (!loop) return `No loop ${id}.`;
        if (loop.status !== "paused") return `Loop ${id} is ${loop.status.replace("_", " ")}, not paused.`;
        if (deps.store.count("active") >= cfg.maxActive) {
          return `${cfg.maxActive} loops are already active, the most allowed. Stop one first.`;
        }
        const updated = deps.store.transition(id, ["paused"], { status: "active", pauseReason: null, errorStreak: 0, nextRunAt: t }, t);
        if (!updated) return `Loop ${id} changed meanwhile; see /loop list.`;
        deps.audit?.("loop.resumed", actor(ctx), updated);
        deps.service.reload();
        return `Resumed loop ${id}. The next check runs in a few seconds.`;
      }

      case "stop":
      case "cancel": {
        if ((ctx.argv[1] ?? "").toLowerCase() === "all") {
          const live = deps.store.list({ statuses: ["active", "paused", "pending_approval"] });
          const stopped = live.filter((l) => deps.store.end(l.id, "cancelled", "owner", t) !== null).map((l) => l.id);
          deps.audit?.("loops.stop_all", actor(ctx), null, { stopped: stopped.length });
          deps.service.reload();
          return stopped.length ? `Stopped ${stopped.length} loop${stopped.length === 1 ? "" : "s"}: ${stopped.join(", ")}.` : "No loops to stop.";
        }
        const id = idArg(ctx);
        if (!id) return "Usage: /loop stop <id>, or /loop stop all.";
        const loop = deps.store.get(id);
        if (!loop) return `No loop ${id}.`;
        const ended = deps.store.end(id, "cancelled", "owner", t);
        if (!ended) return `Loop ${id} has already ended (${loop.status}).`;
        deps.audit?.("loop.ended", actor(ctx), ended, { reason: "owner" });
        deps.service.reload();
        return `Stopped loop ${id} after ${loop.runs} run${loop.runs === 1 ? "" : "s"}.`;
      }

      case "now": {
        const id = idArg(ctx);
        if (!id) return "Usage: /loop now <id>. /loop list shows the ids.";
        const res = deps.service.runNow(id);
        if (res.ok) return `Running loop ${id} now.`;
        switch (res.reason) {
          case "not-found": return `No loop ${id}.`;
          case "ended": return `Loop ${id} has ended.`;
          case "pending": return `Loop ${id} is waiting for your approval.`;
          case "disabled": return OFF_TEXT;
          case "running": return `Loop ${id} is already running.`;
          case "busy": return "This chat is busy. Try again when the current reply is done.";
        }
        return `Loop ${id} did not run.`;
      }

      default:
        return start(ctx, cfg);
    }
  }

  return [
    {
      name: "loop",
      description: "Re-run a prompt in this chat on an interval, quiet unless something changed: start, list, pause, resume, stop, now, on, off",
      category: "automation",
      ownerOnly: true,
      scope: "dm",
      args: "<interval> <prompt> [--times N] [--for 6h] [--no-backoff] | list | pause|resume|stop|now <id> | stop all | on | off",
      usage: `Re-run a prompt in this chat on an interval. I stay quiet unless something changed and check less often while nothing changes. Example: /loop 5m check the deploy of api-gateway and tell me when it is healthy --for 2h\n${USAGE}`,
      subcommands: {
        list: { description: "List the loops" },
        pause: { args: "<id>", description: "Pause a loop" },
        resume: { args: "<id>", description: "Resume a paused loop" },
        stop: { args: "<id> | all", description: "Stop a loop, or all of them" },
        now: { args: "<id>", description: "Run one check now" },
        on: { description: "Turn loops on" },
        off: { description: "Turn loops off and pause the active ones" },
      },
      handler: handle,
    },
  ];
}
