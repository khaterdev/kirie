/**
 * `/computer` owner command (PLAN B.12, C.13): status, on [minutes] [apps], off.
 *
 * Owner only, DM only (the registry checks both). This command is the only
 * way to arm computer use. `/computer off` works even when
 * `computerUse.enabled` is false: it is the kill switch.
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { ComputerUseDriverStatus } from "./driver.js";
import { COMPUTER_USE_SETUP_DOC } from "./driver.js";
import type { ComputerUseService } from "./service.js";

export interface ComputerUseCommandDeps {
  service: ComputerUseService;
  /** Restart the owner's idle chat session so its next turn is spawned with (or without) the driver. */
  refreshSession?: (sessionKey: string) => void;
}

/** The honest limits, shown in /help computer, in the arming confirmation and in the setup doc. */
export const COMPUTER_USE_LIMITS_TEXT = [
  "Limits:",
  "- Screenshots cannot be scrubbed: secrets visible in a window go to the model provider and into the session transcript. Captures are window-only by default and the agent is told to read the accessibility tree first.",
  "- In yolo mode the agent has unrestricted Bash. Once CuaDriver.app has its macOS grants, /computer off is a kill switch and a tripwire (it stops the driver and denies cua-driver in Bash), not a sandbox. The hard off switch is revoking the grants or uninstalling the driver.",
  "- Undo does not cover anything done on the desktop.",
].join("\n");

const USAGE = [
  "/computer status - show desktop control status and the driver's permissions",
  "/computer on [minutes] [app ...] - let Kirie control this Mac for a limited time, optionally only the named apps (names or bundle ids)",
  "/computer off - stop desktop control now (works even when the feature is off in config)",
  "",
  "Kirie never installs the driver or grants it permissions. Setup: " + COMPUTER_USE_SETUP_DOC,
  "",
  COMPUTER_USE_LIMITS_TEXT,
].join("\n");

function yesNo(v: boolean | undefined): string {
  return v === undefined ? "unknown" : v ? "yes" : "no";
}

function notInstalledText(status: ComputerUseDriverStatus | undefined): string {
  return [
    "Computer use: the cua-driver is not installed" + (status ? ` (looked for ${status.driverPath})` : "") + ".",
    "Kirie never installs it. To set it up yourself:",
    "1. Download the installer (curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh), read it, then run it without its side effects: bash /tmp/cua-install.sh --no-connect --no-test --no-modify-path",
    "2. cua-driver telemetry disable",
    "3. From Terminal (not from Kirie): cua-driver permissions grant, then enable CuaDriver under Accessibility and Screen & System Audio Recording. Never grant them to node or bash.",
    "4. Make sure `claude mcp list` does not show cua-driver, and turn on agent.strictMcpConfig.",
    `Full steps: ${COMPUTER_USE_SETUP_DOC}`,
  ].join("\n");
}

function problemsText(status: ComputerUseDriverStatus): string {
  return ["Computer use cannot be armed:", ...status.problems.map((p) => `- ${p}`), `See ${COMPUTER_USE_SETUP_DOC}.`].join("\n");
}

function renderStatus(service: ComputerUseService, status: ComputerUseDriverStatus | null): string {
  const cfg = service.config;
  const snap = service.snapshot();
  const lines = [
    `Computer use: ${cfg.enabled ? "enabled in config" : "off in config (computerUse.enabled: false)"}`,
    snap.armed ? `Armed: yes, ${snap.minutesLeft} min left${snap.apps.length ? `, apps: ${snap.apps.join(", ")}` : ", any app not denied"}` : "Armed: no",
    `Approval: ${cfg.approval}. Screenshots: ${cfg.screenshots}.`,
  ];
  if (status) {
    lines.push(
      `Driver: ${status.installed ? `installed${status.version ? ` (${status.version})` : ""}` : `not installed (${status.driverPath})`}`,
    );
    if (status.installed) {
      lines.push(
        `App signature: ${status.appBundleOk === undefined ? "not checked" : status.appBundleOk ? "ok" : "FAILED"}; daemon running: ${yesNo(status.daemonRunning)}`,
        `Accessibility: ${yesNo(status.accessibility)}; Screen Recording: ${yesNo(status.screenRecording)}; attribution: ${status.attribution ?? "unknown"}`,
      );
    }
    for (const p of status.problems) lines.push(`Problem: ${p}`);
    for (const w of status.warnings) lines.push(`Note: ${w}`);
  } else if (!cfg.enabled) {
    lines.push(`To turn it on: install the driver yourself (${COMPUTER_USE_SETUP_DOC}), set computerUse.enabled: true in config.yaml and restart.`);
  }
  const recent = service.recentAudit(5);
  if (recent.length > 0) {
    lines.push("Recent:");
    for (const r of recent) {
      const d = r.detail ?? {};
      const tool = typeof d.tool === "string" ? ` ${d.tool}` : "";
      const app = typeof d.app === "string" ? ` ${d.app}` : "";
      lines.push(`- ${r.ts.slice(11, 19)} ${r.action}${tool}${app}`);
    }
  }
  return lines.join("\n");
}

function parseOnArgs(argv: readonly string[]): { minutes?: number; apps: string[] } {
  const args = argv.slice(1);
  let minutes: number | undefined;
  if (args.length > 0 && /^\d{1,6}$/.test(args[0]!)) {
    minutes = Number(args[0]);
    args.shift();
  } else if (args.length > 0 && /^\d{1,6}m(in)?$/i.test(args[0]!)) {
    minutes = Number.parseInt(args[0]!, 10);
    args.shift();
  }
  const apps = args.flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean).slice(0, 20);
  return { ...(minutes !== undefined ? { minutes } : {}), apps };
}

async function handleOn(ctx: CommandContext, deps: ComputerUseCommandDeps): Promise<string> {
  const { service } = deps;
  if (!service.config.enabled) {
    return [
      "Computer use is off in config. To use it: install the driver yourself and grant it the macOS permissions (" + COMPUTER_USE_SETUP_DOC + "), set computerUse.enabled: true in config.yaml, restart Kirie, then /computer on.",
      "/computer off still works as a kill switch.",
    ].join("\n");
  }
  if (ctx.message.channel === "voice") return "Computer use cannot be armed from a phone call. Send /computer on in your Telegram DM.";
  const { minutes, apps } = parseOnArgs(ctx.argv);
  const epoch = service.arming.epoch();
  const requested = minutes ?? service.config.armMinutes;
  const clamped = service.clampMinutes(requested);
  const scope = apps.length > 0 ? apps.join(", ") : "any app not on the denied list";
  const confirmed = await ctx.confirm(
    `Let Kirie control this Mac for ${clamped} min?`,
    [`Apps: ${scope}. Approval: ${service.config.approval}. Screenshots: ${service.config.screenshots}.`, "", COMPUTER_USE_LIMITS_TEXT].join("\n"),
  );
  if (!confirmed) return "Computer use not armed.";

  const by = `owner:${ctx.message.channel}:${ctx.message.senderId}`;
  const res = await service.arm({ minutes: requested, ...(apps.length > 0 ? { apps } : {}), by, epoch });
  if (!res.ok) {
    if (res.reason === "cancelled") return "Computer use not armed: /computer off arrived while it was being set up.";
    if (res.reason === "not-installed") return notInstalledText(res.status);
    if (res.reason === "unhealthy" && res.status) return problemsText(res.status);
    return "Computer use is off in config.";
  }
  deps.refreshSession?.(ctx.sessionKey);
  const lines = [
    `Armed for ${res.minutes} min${res.capped ? ` (capped at computerUse.maxArmMinutes = ${service.config.maxArmMinutes})` : ""}, apps: ${res.state.apps?.join(", ") ?? "any app not denied"}.`,
    service.config.approval === "per-app"
      ? "The first action in each app asks you first."
      : service.config.approval === "per-action"
        ? "Every action asks you first."
        : "Actions run without asking (approval: armed-only).",
    "/computer off to stop.",
  ];
  for (const w of res.status.warnings) lines.push(`Note: ${w}`);
  return lines.join("\n");
}

export function createComputerUseCommands(deps: ComputerUseCommandDeps): CommandDefinition[] {
  return [
    {
      name: "computer",
      description: "Desktop control: status, on [minutes] [apps], off",
      category: "media",
      ownerOnly: true,
      scope: "dm",
      args: "status | on [minutes] [app ...] | off",
      usage: USAGE,
      subcommands: {
        status: { description: "Show desktop control status and permissions" },
        on: { args: "[minutes] [app ...]", description: "Let Kirie control the Mac for a limited time" },
        off: { description: "Stop desktop control immediately" },
        help: { description: "Usage and limits" },
      },
      async handler(ctx) {
        const sub = (ctx.argv[0] ?? "status").toLowerCase();
        const { service } = deps;
        switch (sub) {
          case "status": {
            const status = service.config.enabled ? await service.probe() : service.lastStatus();
            return renderStatus(service, status);
          }
          case "on":
            return handleOn(ctx, deps);
          case "off": {
            const by = `owner:${ctx.message.channel}:${ctx.message.senderId}`;
            const res = await service.disarm("owner", by);
            return [
              res.wasArmed ? "Computer use is off. Grants cleared." : "Computer use was not armed; it is off.",
              res.driverStopped ? "The driver was stopped (cua-driver stop)." : "",
            ].filter(Boolean).join("\n");
          }
          case "help":
            return USAGE;
          default:
            return `Unknown subcommand "${sub}".\n${USAGE}`;
        }
      },
    },
  ];
}
