/**
 * `/plugins` owner command (PLAN B.12, C.15). Owner-only, DM-only: the
 * registry checks that before the handler runs. These handlers are the only
 * way to approve, enable, disable or reload a plugin; there is no MCP tool and
 * no HTTP route for any of it.
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { PluginInspection, PluginManager, PluginStatus } from "./manager.js";
import { isValidPluginName, PLUGIN_TRUST_STATEMENT } from "./types.js";

export interface PluginsCommandDeps {
  manager: Pick<PluginManager, "list" | "inspect" | "approve" | "disable" | "reload">;
  /** Effective master switch */
  isEnabled(): boolean;
  /** Sets the runtime override and starts or stops the plugin system. Returns what loaded. */
  setMaster(on: boolean, actor: string): Promise<{ loaded: string[]; refused: string[] }>;
  pluginsDir: string;
}

const USAGE = [
  "/plugins [list] - master switch and every plugin's state",
  "/plugins info <name> - manifest, hashes, files, static-scan findings",
  "/plugins enable <name> [force] - review and approve the current files, then load (asks to confirm)",
  "/plugins disable <name> - unload and stop loading it (the approval record is kept)",
  "/plugins reload [name] - check the hash again and reload; clears a suspension",
  "/plugins on | off - master switch (off unloads everything)",
  "",
  "Plugins are hooks only: they observe messages, tool calls, errors and channel events; with the",
  "transform-message capability a plugin may rewrite the text of an incoming message. They cannot",
  "block or change tool calls, add tools or add channels.",
  "",
  PLUGIN_TRUST_STATEMENT,
].join("\n");

const STATE_TEXT: Record<PluginStatus["state"], string> = {
  "not-approved": "not approved",
  disabled: "disabled",
  approved: "approved, not loaded",
  loaded: "loaded",
  suspended: "SUSPENDED",
  changed: "CHANGED since approval, not loaded",
  unverified: "approval not verified, not loaded",
  "not-allowed": "not in plugins.allow",
  failed: "FAILED",
  missing: "approved, directory missing",
};

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 16) : "-";
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function statusLine(s: PluginStatus): string {
  const parts = [`${s.name}${s.version ? ` ${s.version}` : ""}: ${STATE_TEXT[s.state]}`];
  if (s.events && s.events.length > 0) parts.push(`events ${s.events.join(", ")}`);
  if (s.capabilities?.includes("hooks:transform-message")) parts.push("may rewrite messages");
  if (s.failures > 0) parts.push(`${s.failures} hook failures`);
  if (s.dropped > 0) parts.push(`${s.dropped} events dropped`);
  return parts.join(" | ");
}

function findingsText(insp: Extract<PluginInspection, { ok: true }>, max = 8): string[] {
  if (insp.findings.length === 0) {
    return [`Static scan: no findings${insp.scanTruncated ? " (scan stopped early: large plugin)" : ""}. The scan is a hint, not a guarantee.`];
  }
  const order = { block: 0, warn: 1, info: 2 } as const;
  const sorted = [...insp.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const lines = [`Static scan: ${insp.findings.length} finding(s)${insp.scanTruncated ? " (scan stopped early)" : ""}:`];
  for (const f of sorted.slice(0, max)) {
    lines.push(`- ${f.severity}: ${f.description} (${f.file}${f.line ? `:${f.line}` : ""})`);
  }
  if (sorted.length > max) lines.push(`- ... ${sorted.length - max} more`);
  return lines;
}

export function createPluginsCommands(deps: PluginsCommandDeps): CommandDefinition[] {
  const list = (): string => {
    const rows = deps.manager.list();
    const head = `Plugins are ${deps.isEnabled() ? "ON" : "OFF"}. Directory: ${deps.pluginsDir}`;
    if (rows.length === 0) {
      return `${head}\nNo plugins found. Plugins are never installed or downloaded by Kirie; put one in that directory yourself, then /plugins enable <name>.`;
    }
    return [head, ...rows.map(statusLine), "", "Plugins run inside Kirie with its full privileges. /help plugins explains."].join("\n");
  };

  const info = (name: string): string => {
    const insp = deps.manager.inspect(name);
    if (!insp.ok) {
      const lines = [`${name}: ${insp.error}`];
      if (insp.status) lines.push(`State: ${STATE_TEXT[insp.status.state]}`);
      if (insp.approval) lines.push(`Approved hash: ${short(insp.approval.sha256)} by ${insp.approval.approvedBy} at ${insp.approval.approvedAt}`);
      return lines.join("\n");
    }
    const m = insp.manifest;
    const lines = [
      `${m.name} ${m.version}${m.description ? `: ${m.description}` : ""}`,
      `State: ${STATE_TEXT[insp.status.state]}`,
      `Events: ${m.events.join(", ")}`,
      `Capabilities: ${m.capabilities.join(", ")}`,
      `Entry: ${m.entry}. Files: ${insp.fileCount}, ${kb(insp.totalBytes)}`,
      `Current hash: ${short(insp.sha256)}`,
      `Approved hash: ${insp.approval ? `${short(insp.approval.sha256)}${insp.approval.sha256 === insp.sha256 ? " (matches)" : " (DIFFERENT)"}` : "none"}`,
    ];
    if (insp.approval) lines.push(`Approved by ${insp.approval.approvedBy} at ${insp.approval.approvedAt}`);
    if (insp.status.lastError) lines.push(`Last error: ${insp.status.lastError}`);
    lines.push(...findingsText(insp));
    return lines.join("\n");
  };

  const enable = async (ctx: CommandContext, name: string, force: boolean): Promise<string> => {
    const insp = deps.manager.inspect(name);
    if (!insp.ok) return `Cannot enable ${name}: ${insp.error}`;
    if (insp.blocking && !force) {
      return [
        `Not enabled: the static scan found blocking patterns in ${name}.`,
        ...findingsText(insp),
        "",
        `Read the code. If you still trust it: /plugins enable ${name} force`,
      ].join("\n");
    }
    const m = insp.manifest;
    const body = [
      `${m.name} ${m.version}`,
      `Events: ${m.events.join(", ")}`,
      `Capabilities: ${m.capabilities.join(", ")}${m.capabilities.includes("hooks:transform-message") ? " (it may rewrite the text of incoming messages before I see them)" : ""}`,
      `Files: ${insp.fileCount}, ${kb(insp.totalBytes)}. Hash: ${short(insp.sha256)}`,
      ...findingsText(insp, 5),
      "",
      "You approve exactly these files. Any later change to them stops the plugin from loading until you approve again.",
      "",
      PLUGIN_TRUST_STATEMENT,
    ].join("\n");
    const confirmed = await ctx.confirm(`Enable plugin ${name}?`, body);
    if (!confirmed) return `Not enabled. Nothing about ${name} changed.`;
    const res = await deps.manager.approve(name, insp.sha256, actorOf(ctx));
    if (!res.ok) return `Not enabled: ${res.reason}`;
    if (!deps.isEnabled()) {
      return `Approved ${name} ${res.approval.version} (hash ${short(res.approval.sha256)}). Plugins are off; send /plugins on to load approved plugins.`;
    }
    if (res.loaded) return `Approved and loaded ${name} ${res.approval.version} (hash ${short(res.approval.sha256)}).`;
    return `Approved ${name}, but it did not load: ${res.error ?? "unknown error"}. /plugins info ${name} shows details.`;
  };

  const definition: CommandDefinition = {
    name: "plugins",
    description: "Plugins: list, info, enable, disable, reload, on, off",
    category: "integrations",
    ownerOnly: true,
    scope: "dm",
    args: "[list | info <name> | enable <name> [force] | disable <name> | reload [name] | on | off]",
    usage: USAGE,
    subcommands: {
      list: { description: "Master switch and every plugin's state" },
      info: { args: "<name>", description: "Manifest, hashes, files, static-scan findings" },
      enable: { args: "<name> [force]", description: "Review, approve the current files and load (confirm first)" },
      disable: { args: "<name>", description: "Unload and stop loading it; keeps the approval record" },
      reload: { args: "[name]", description: "Check hashes again and reload; clears a suspension" },
      on: { description: "Turn plugins on (confirm first) and load the approved ones" },
      off: { description: "Turn plugins off and unload everything" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "list").toLowerCase();
      const arg = ctx.argv[1];
      const needName = (): string | null => (arg && isValidPluginName(arg) ? arg : null);

      switch (sub) {
        case "list":
          return list();
        case "info": {
          const name = needName();
          return name ? info(name) : "Usage: /plugins info <name> (lowercase letters, digits, '.', '_' and '-')";
        }
        case "enable": {
          const name = needName();
          if (!name) return "Usage: /plugins enable <name> [force]";
          const extra = ctx.argv[2]?.toLowerCase();
          if (extra !== undefined && extra !== "force") return "Usage: /plugins enable <name> [force]";
          return enable(ctx, name, extra === "force");
        }
        case "disable": {
          const name = needName();
          if (!name) return "Usage: /plugins disable <name>";
          const changed = await deps.manager.disable(name, actorOf(ctx));
          return changed
            ? `Disabled ${name}. It is unloaded and will not load again; /plugins enable ${name} approves its current files again.`
            : `${name} has no approval record and is not loaded. Nothing changed.`;
        }
        case "reload": {
          if (arg !== undefined && !isValidPluginName(arg)) return "Usage: /plugins reload [name]";
          if (!deps.isEnabled()) return "Plugins are off. Send /plugins on first.";
          const results = await deps.manager.reload(arg, actorOf(ctx));
          if (results.length === 0) return arg ? `${arg} is not approved and enabled.` : "No approved and enabled plugins.";
          return results.map((r) => `${r.name}: ${r.loaded ? "reloaded" : `not loaded (${r.error ?? "see /plugins info"})`}`).join("\n");
        }
        case "on": {
          if (deps.isEnabled()) return "Plugins are already on. /plugins reload loads approved plugins again.";
          const confirmed = await ctx.confirm(
            "Turn plugins on?",
            `Every approved and enabled plugin will be loaded into Kirie now and at each start.\n\n${PLUGIN_TRUST_STATEMENT}`,
          );
          if (!confirmed) return "Plugins stay off.";
          const r = await deps.setMaster(true, actorOf(ctx));
          const lines = ["Plugins are on."];
          lines.push(r.loaded.length > 0 ? `Loaded: ${r.loaded.join(", ")}.` : "No approved plugin was loaded.");
          if (r.refused.length > 0) lines.push(`Not loaded: ${r.refused.join(", ")} (see /plugins).`);
          return lines.join(" ");
        }
        case "off": {
          await deps.setMaster(false, actorOf(ctx));
          return "Plugins are off. Every plugin was unloaded; approvals are kept.";
        }
        default:
          return `Unknown subcommand "${sub}".\n\n${USAGE}`;
      }
    },
  };
  return [definition];
}
