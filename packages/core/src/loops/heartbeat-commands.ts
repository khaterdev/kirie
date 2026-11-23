/**
 * /heartbeat (alias /hb): the owner's control surface for the proactive layer
 * (PLAN C.8, DECISIONS 3). Owner-only, DM-only (checked by the registry).
 *
 * Overrides persist in RuntimeSettings: `proactive.enabled`,
 * `proactive.tier2IntervalMinutes`, `proactive.snoozedUntil`. `/heartbeat off`
 * pauses detectors and triage only; the 10-second tick that delivers
 * schedules, retries and loops keeps running.
 */

import { z } from "zod/v3";
import type { ProactiveConfig } from "../config/schema.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { ProactiveEngine } from "../engine/proactive.js";
import type { HeartbeatLogStore } from "../mcp/tools/heartbeat-logs.js";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { formatDuration, parseDuration, parseIntInRange } from "../commands/parse.js";
import {
  addHeartbeatChecklistItem,
  readHeartbeatChecklist,
  removeHeartbeatChecklistItem,
  renderHeartbeatChecklist,
} from "./heartbeat-checklist.js";

export const HEARTBEAT_SETTING_ENABLED = "proactive.enabled";
export const HEARTBEAT_SETTING_INTERVAL = "proactive.tier2IntervalMinutes";
export const HEARTBEAT_SETTING_SNOOZE = "proactive.snoozedUntil";

export const HEARTBEAT_MIN_INTERVAL_MINUTES = 5;
export const HEARTBEAT_MAX_INTERVAL_MINUTES = 1440;
const SNOOZE_MIN_MS = 60_000;
const SNOOZE_MAX_MS = 7 * 86_400_000;
const LOG_DEFAULT = 10;
/** proactive.maxChecklistBytes default (B.11), for hand-built configs that omit it */
const DEFAULT_CHECKLIST_BYTES = 8192;
const LOG_MAX = 30;

const IntervalSetting = z.number().min(HEARTBEAT_MIN_INTERVAL_MINUTES).max(HEARTBEAT_MAX_INTERVAL_MINUTES);
const SnoozeSetting = z.number().int().nonnegative();
const EnabledSetting = z.boolean();

export type HeartbeatEngineControl = Pick<
  ProactiveEngine,
  "start" | "stop" | "isRunning" | "runTriage" | "setTier2IntervalMinutes" | "snooze" | "status"
>;

export interface HeartbeatCommandDeps {
  /** Null when no owner identity is configured (the engine is not constructed) */
  proactive: HeartbeatEngineControl | null;
  settings: Pick<RuntimeSettings, "get" | "set" | "delete">;
  /** The proactive config section (config values that `reset` returns to) */
  config: Pick<ProactiveConfig, "enabled" | "tier2IntervalMinutes" | "maxChecklistBytes" | "heartbeatFile">;
  /** Absolute path of the checklist file */
  checklistPath: string;
  logs?: Pick<HeartbeatLogStore, "recent"> | null;
  countActiveLoops?: () => number;
  countSchedules?: () => number;
  /**
   * True when the engine was off at boot: the agent's proactive_status and
   * proactive_trigger tools were built without it and see it only after a restart.
   */
  toolsNeedRestart?: () => boolean;
  timezone?: string;
  now?: () => number;
}

/** Apply the persisted interval and snooze overrides to the engine (daemon start). */
export function applyHeartbeatOverrides(
  engine: Pick<ProactiveEngine, "setTier2IntervalMinutes" | "snooze">,
  settings: Pick<RuntimeSettings, "get">,
  now: number = Date.now(),
): void {
  const minutes = settings.get(HEARTBEAT_SETTING_INTERVAL, IntervalSetting);
  if (minutes !== undefined) engine.setTier2IntervalMinutes(minutes);
  const until = settings.get(HEARTBEAT_SETTING_SNOOZE, SnoozeSetting);
  if (until !== undefined && until > now) engine.snooze(until);
}

/** Effective `proactive.enabled` (override ?? config). */
export function heartbeatEnabledSetting(settings: Pick<RuntimeSettings, "get">, configValue: boolean): boolean {
  return settings.get(HEARTBEAT_SETTING_ENABLED, EnabledSetting) ?? configValue;
}

const USAGE = [
  "/heartbeat - status",
  "/heartbeat on | off - resume or pause my background checks (kept across restarts)",
  "/heartbeat every <interval> - how often I triage, 5m to 24h",
  "/heartbeat now - run one triage cycle now",
  "/heartbeat show - the checklist I read",
  "/heartbeat add <text> - add a checklist item",
  "/heartbeat remove <n> - remove item n (numbers from /heartbeat show)",
  "/heartbeat snooze <duration> | off - hold non-critical notifications",
  "/heartbeat log [n] - the last n heartbeat log entries (default 10, max 30)",
  "/heartbeat reset - drop my overrides and use the config values",
].join("\n");

const NO_ENGINE = "The heartbeat is not available: no owner identity is configured (security.owner.identities).";
const TOOLS_RESTART_NOTE = "Note: my proactive_status and proactive_trigger tools see the heartbeat only after a restart (/restart).";
const TICK_NOTE = "The 10-second tick that delivers schedules, retries and loops keeps running.";

function actor(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

export function createHeartbeatCommands(deps: HeartbeatCommandDeps): CommandDefinition[] {
  const now = deps.now ?? Date.now;

  const clock = (ms: number): string => {
    try {
      return new Date(ms).toLocaleString("en-GB", {
        timeZone: deps.timezone, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
      });
    } catch {
      return new Date(ms).toISOString();
    }
  };
  const relative = (ms: number): string => {
    const d = ms - now();
    if (Math.abs(d) < 1000) return "now";
    return d > 0 ? `in ${formatDuration(d)}` : `${formatDuration(-d)} ago`;
  };

  function status(): string {
    const engine = deps.proactive;
    if (!engine) return NO_ENGINE;
    const s = engine.status();
    const lines = [
      `Heartbeat: ${s.running ? "running" : "paused"}`,
      `  Triage every ${formatDuration(s.tier2IntervalMinutes * 60_000)}`,
      `  Last triage: ${s.lastTriageAt ? `${clock(s.lastTriageAt)} (${relative(s.lastTriageAt)})` : "not yet"}`,
      `  Next triage: ${s.running ? (s.nextTriageAt <= now() ? "at the next tick" : `${clock(s.nextTriageAt)} (${relative(s.nextTriageAt)})`) : "paused"}`,
      `  Signals waiting: ${s.signalQueueSize}, digest queue: ${s.digestQueueSize}`,
      `  Snooze: ${s.snoozedUntil ? `until ${clock(s.snoozedUntil)} (${relative(s.snoozedUntil)})` : "off"}`,
    ];
    const extras: string[] = [];
    if (deps.countActiveLoops) extras.push(`active loops: ${safeCount(deps.countActiveLoops)}`);
    if (deps.countSchedules) extras.push(`schedules: ${safeCount(deps.countSchedules)}`);
    if (extras.length) lines.push(`  ${extras.join(", ")}`);
    if (!s.running) lines.push(TICK_NOTE);
    return lines.join("\n");
  }

  const maxChecklistBytes = deps.config.maxChecklistBytes ?? DEFAULT_CHECKLIST_BYTES;

  async function handle(ctx: CommandContext): Promise<string> {
    const sub = (ctx.argv[0] ?? "").toLowerCase();
    const rest = ctx.argv.slice(1);
    const engine = deps.proactive;

    switch (sub) {
      case "":
      case "status":
        return status();

      case "help":
        return USAGE;

      case "on": {
        if (!engine) return NO_ENGINE;
        deps.settings.set(HEARTBEAT_SETTING_ENABLED, true, actor(ctx));
        engine.start();
        const s = engine.status();
        const lines = [`Heartbeat on: signal checks every tick, triage every ${formatDuration(s.tier2IntervalMinutes * 60_000)}. This stays on across restarts.`];
        if (deps.toolsNeedRestart?.()) lines.push(TOOLS_RESTART_NOTE);
        return lines.join("\n");
      }

      case "off": {
        if (!engine) return NO_ENGINE;
        deps.settings.set(HEARTBEAT_SETTING_ENABLED, false, actor(ctx));
        engine.stop();
        return `Heartbeat paused: no signal checks and no triage until /heartbeat on. This stays off across restarts. ${TICK_NOTE}`;
      }

      case "every": {
        if (!engine) return NO_ENGINE;
        if (rest.length === 0) return "Usage: /heartbeat every <interval>, from 5m to 24h. Example: /heartbeat every 30m";
        if (rest.length > 1) {
          return "/heartbeat every takes only an interval; the triage reads the checklist (/heartbeat show). To re-run a prompt on a schedule, use /loop <interval> <prompt>.";
        }
        const ms = parseDuration(rest[0]!);
        if (ms === null) return `I could not read "${rest[0]}" as an interval. Examples: 15m, 1h, 2h30m.`;
        const minutes = ms / 60_000;
        if (minutes < HEARTBEAT_MIN_INTERVAL_MINUTES || minutes > HEARTBEAT_MAX_INTERVAL_MINUTES) {
          return "The triage interval must be between 5m and 24h.";
        }
        deps.settings.set(HEARTBEAT_SETTING_INTERVAL, minutes, actor(ctx));
        engine.setTier2IntervalMinutes(minutes);
        const s = engine.status();
        const next = s.running
          ? s.nextTriageAt <= now() ? " Next triage: at the next tick." : ` Next triage: ${clock(s.nextTriageAt)} (${relative(s.nextTriageAt)}).`
          : " The heartbeat is paused; /heartbeat on resumes it.";
        return `Triage now runs every ${formatDuration(ms)}.${next}`;
      }

      case "now": {
        if (!engine) return NO_ENGINE;
        if (!engine.isRunning) return "The heartbeat is paused. Turn it on with /heartbeat on, then try again.";
        if (engine.status().triageInProgress) return "A triage cycle is already running.";
        await ctx.reply("Running a triage cycle now…");
        const result = await engine.runTriage();
        if (result.decisions.length === 0) {
          return `Triage done: ${result.signalsProcessed} signal${result.signalsProcessed === 1 ? "" : "s"} checked, nothing to act on.`;
        }
        const byAction = new Map<string, number>();
        for (const d of result.decisions) byAction.set(d.action, (byAction.get(d.action) ?? 0) + 1);
        const summary = [...byAction.entries()].map(([a, n]) => `${a} ${n}`).join(", ");
        return `Triage done: ${result.signalsProcessed} signal${result.signalsProcessed === 1 ? "" : "s"} checked, ${result.decisions.length} decision${result.decisions.length === 1 ? "" : "s"} (${summary}).`;
      }

      case "show": {
        const list = readHeartbeatChecklist(deps.checklistPath);
        const header = `Checklist (${list.items.length} item${list.items.length === 1 ? "" : "s"}, ${list.bytes} of ${maxChecklistBytes} bytes):`;
        return list.exists && list.content.trim() ? `${header}\n${renderHeartbeatChecklist(list)}` : renderHeartbeatChecklist(list);
      }

      case "add": {
        const text = ctx.args.replace(/^\s*add\b/i, "");
        const res = addHeartbeatChecklistItem(deps.checklistPath, text, maxChecklistBytes);
        if (!res.ok) return res.error;
        return `Added item ${res.n}: ${res.text}\nThe next triage reads it.`;
      }

      case "remove":
      case "rm": {
        const n = rest[0] !== undefined ? parseIntInRange(rest[0], 1, 10_000) : null;
        if (n === null) return "Usage: /heartbeat remove <n>, with n from /heartbeat show.";
        const res = removeHeartbeatChecklistItem(deps.checklistPath, n);
        if (!res.ok) return res.error;
        return `Removed item ${n}: ${res.text}`;
      }

      case "snooze": {
        const arg = (rest[0] ?? "").toLowerCase();
        if (!arg) return "Usage: /heartbeat snooze <duration> (1m to 7d), or /heartbeat snooze off.";
        if (arg === "off") {
          deps.settings.delete(HEARTBEAT_SETTING_SNOOZE, actor(ctx));
          engine?.snooze(null);
          return "Snooze off: notifications go out as usual.";
        }
        const ms = parseDuration(arg, { minMs: SNOOZE_MIN_MS, maxMs: SNOOZE_MAX_MS });
        if (ms === null) return "The snooze must be a duration from 1m to 7d, for example 2h.";
        const until = now() + ms;
        deps.settings.set(HEARTBEAT_SETTING_SNOOZE, until, actor(ctx));
        engine?.snooze(until);
        return `Snoozed until ${clock(until)} (${formatDuration(ms)}): non-critical notifications wait for the digest and escalations are skipped. Critical ones still come through. /heartbeat snooze off ends it.`;
      }

      case "log": {
        if (!deps.logs) return "Heartbeat logging is off (proactive.heartbeatLogging).";
        const n = rest[0] !== undefined ? parseIntInRange(rest[0], 1, LOG_MAX) : LOG_DEFAULT;
        if (n === null) return `Usage: /heartbeat log [n], n from 1 to ${LOG_MAX}.`;
        const entries = deps.logs.recent(n);
        if (entries.length === 0) return "No heartbeat log entries yet.";
        const lines = [`Last ${entries.length} heartbeat log entr${entries.length === 1 ? "y" : "ies"}:`];
        for (const e of entries) {
          const title = e.title.length > 160 ? `${e.title.slice(0, 160)}…` : e.title;
          lines.push(`${e.created_at} ${e.tier} ${e.level} ${e.category}: ${title}`);
        }
        return lines.join("\n");
      }

      case "reset": {
        const by = actor(ctx);
        deps.settings.delete(HEARTBEAT_SETTING_ENABLED, by);
        deps.settings.delete(HEARTBEAT_SETTING_INTERVAL, by);
        deps.settings.delete(HEARTBEAT_SETTING_SNOOZE, by);
        if (!engine) return "Heartbeat overrides cleared.";
        engine.setTier2IntervalMinutes(deps.config.tier2IntervalMinutes);
        engine.snooze(null);
        if (deps.config.enabled) engine.start();
        else engine.stop();
        const lines = [
          `Heartbeat overrides cleared. Back to the config: ${deps.config.enabled ? "on" : "off"}, triage every ${formatDuration(deps.config.tier2IntervalMinutes * 60_000)}, no snooze.`,
        ];
        if (deps.config.enabled && deps.toolsNeedRestart?.()) lines.push(TOOLS_RESTART_NOTE);
        return lines.join("\n");
      }

      default:
        return `Unknown /heartbeat option "${ctx.argv[0]}".\n${USAGE}`;
    }
  }

  return [
    {
      name: "heartbeat",
      aliases: ["hb"],
      description: "Control my background checks: status, on, off, every, now, show, add, remove, snooze, log, reset",
      category: "automation",
      ownerOnly: true,
      scope: "dm",
      args: "[on | off | every <interval> | now | show | add <text> | remove <n> | snooze <duration>|off | log [n] | reset]",
      usage: `Control my background checks: status, on/off, how often I triage, run one now, edit the checklist I read, or snooze notifications. Example: /heartbeat every 30m\n${USAGE}`,
      subcommands: {
        on: { description: "Resume the background checks" },
        off: { description: "Pause the background checks" },
        every: { args: "<interval>", description: "Triage interval, 5m to 24h" },
        now: { description: "Run a triage cycle now" },
        show: { description: "Show the checklist" },
        add: { args: "<text>", description: "Add a checklist item" },
        remove: { args: "<n>", description: "Remove a checklist item" },
        snooze: { args: "<duration> | off", description: "Hold non-critical notifications" },
        log: { args: "[n]", description: "Recent heartbeat log entries" },
        reset: { description: "Drop the overrides" },
      },
      handler: handle,
    },
  ];
}

function safeCount(fn: () => number): string {
  try {
    return String(fn());
  } catch {
    return "?";
  }
}
