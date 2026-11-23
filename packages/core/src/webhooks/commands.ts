/**
 * `/webhook` (alias `/webhooks`) owner commands (PLAN B.12, C.6, R3 "Telegram owner commands").
 *
 * Owner-only and DM-only through the registry (the central check runs before
 * any handler). Replies never contain a secret: `add`, `rotate-secret` and
 * `secret` write it to a 0600 file and reply with the path. There is no agent
 * tool for any of this.
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { parseIntInRange, parseOnOff } from "../commands/parse.js";
import type { WebhooksConfig } from "../config/sections/webhooks.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { WEBHOOK_SOURCES, WEBHOOK_TOOL_PROFILES, type WebhookDefinition, type WebhookSource, type WebhookToolProfile } from "./types.js";
import type { WebhookPatch } from "./store.js";
import { invalidWebhookCidr, WEBHOOK_MAX_GRACE_MINUTES, type WebhookService } from "./service.js";
import { webhookSetupText } from "./sources.js";

export interface WebhookCommandDeps {
  service: WebhookService;
  config(): WebhooksConfig;
  /** Effective `webhooks.enabled` (runtime override ?? config) */
  isEnabled(): boolean;
  /** Writes the runtime override and mounts or unmounts the listener */
  setEnabled(enabled: boolean, by: string): Promise<void>;
  /** After a hook is enabled, disabled or removed: the listener is bound only while some hook is enabled */
  onHooksChanged?(): Promise<void>;
  listener(): { listening: boolean; port: number | null; publicBaseUrl: string | null };
  /** GET <publicBaseUrl>/healthz with a short timeout. Omitted in tests */
  probeHealth?(url: string): Promise<boolean>;
  audit?: Pick<AuditTrail, "recent">;
}

const SUBCOMMANDS = {
  status: { description: "Listener, public URL, hook count, deliveries and refusals in 24 h" },
  list: { description: "All hooks (never secrets)" },
  add: { args: "<name> <github|sentry|alertmanager|generic|bearer> [events=a,b] [action=notify|task] [tools=summarize|investigate] [fields=a.b,c] [-- instructions]", description: "Create a hook (disabled) and write its secret to a 0600 file" },
  show: { args: "<id>", description: "One hook's definition and provider setup" },
  set: { args: "<id> key=value ... [-- instructions]", description: "Keys: events, action, tools, fields, ip, rate, daily, raw, instructions" },
  remove: { args: "<id>", description: "Delete a hook and its secret (asks to confirm)" },
  enable: { args: "<id>", description: "Accept deliveries for a hook" },
  disable: { args: "<id>", description: "Refuse deliveries for a hook (404)" },
  test: { args: "<id> [run]", description: "Sign a sample with the real secret and run it through the ingress in process" },
  "rotate-secret": { args: "<id> [grace=<minutes>] [from-file]", description: "New secret; the old one stays valid for the grace period" },
  secret: { args: "<id>", description: "Write the secret to a 0600 file again (removed after 10 minutes)" },
  log: { args: "[id] [n]", description: "Recent deliveries and refusals" },
  forget: { args: "<delivery>", description: "Drop a delivery's replay row so a provider redelivery is accepted" },
  on: { description: "Turn webhooks on: mount /hooks on the public listener" },
  off: { description: "Turn webhooks off: unmount /hooks; the listener closes when idle" },
} as const;

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function splitInstructions(args: string): { head: string; instructions: string | undefined } {
  const m = /(^|\s)--(\s|$)/.exec(args);
  if (!m) return { head: args, instructions: undefined };
  return { head: args.slice(0, m.index), instructions: args.slice(m.index + m[0].length).trim() };
}

function parseKeyValues(tokens: readonly string[]): { pairs: Array<[string, string]>; flags: string[] } {
  const pairs: Array<[string, string]> = [];
  const flags: string[] = [];
  for (const t of tokens) {
    const i = t.indexOf("=");
    if (i > 0) pairs.push([t.slice(0, i).toLowerCase(), t.slice(i + 1)]);
    else flags.push(t.toLowerCase());
  }
  return { pairs, flags };
}

function csv(value: string): string[] {
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

const EVENT_RE = /^[A-Za-z0-9_.*:-]{1,80}$/;
const FIELD_RE = /^[A-Za-z0-9_-]{1,64}(\.[A-Za-z0-9_-]{1,64}){0,9}$/;

function parseEvents(value: string): string[] {
  const list = csv(value);
  for (const e of list) if (!EVENT_RE.test(e)) throw new Error(`Bad event "${e}"`);
  return list;
}

function parseFields(value: string): string[] {
  const list = csv(value);
  if (list.length > 50) throw new Error("At most 50 fields");
  for (const f of list) if (!FIELD_RE.test(f)) throw new Error(`Bad field path "${f}"`);
  return list;
}

function hookLine(h: WebhookDefinition, last: string | null): string {
  const mode = h.action === "notify" ? "notify" : `task/${h.toolProfile}`;
  const events = h.events.length > 0 ? h.events.join(",") : "all events";
  return `${h.id}  ${h.source}  ${h.enabled ? "enabled" : "disabled"}  ${mode}  ${events}  ${h.verifiedAt ? "verified" : "unverified"}  last ${last ?? "never"}`;
}

function describeHook(service: WebhookService, h: WebhookDefinition): string {
  const url = service.hookUrl(h.id);
  const lines = [
    `${h.name} (${h.id})`,
    `source: ${h.source}`,
    `enabled: ${h.enabled ? "yes" : "no"}`,
    `action: ${h.action}${h.action === "task" ? `, tools ${h.toolProfile}${h.toolProfile === "full" ? (h.allowFull ? " (opted in)" : " (not opted in)") : ""}` : ""}`,
    `events: ${h.events.length > 0 ? h.events.join(", ") : "all"}`,
    `fields: ${h.fields.length > 0 ? h.fields.join(", ") : "source defaults"}`,
    `raw payload in prompts: ${h.includeRaw ? "yes" : "no"}`,
    `ip allowlist: ${h.ipAllowlist.length > 0 ? h.ipAllowlist.join(", ") : "any"}`,
    `rate: ${h.ratePerMin ?? "default"}/min, daily: ${h.dailyCap ?? "default"}`,
    `delivers to: ${h.channel} DM`,
    `verified: ${h.verifiedAt ?? "not yet"}`,
    `secret rotation grace until: ${h.prevSecretExpiresAt ?? "none"}`,
    `instructions: ${h.instructions || "(default summary)"}`,
    `URL: ${url ?? "(set ingress.publicBaseUrl in config.yaml)"}`,
  ];
  lines.push("", webhookSetupText(h.source, url ?? "<publicBaseUrl>/hooks/" + h.id));
  if (h.source === "sentry") lines.push(`Import file: ${service.importFilePath(h.id)}`);
  return lines.join("\n");
}

export function createWebhookCommands(deps: WebhookCommandDeps): CommandDefinition[] {
  const { service } = deps;

  async function status(): Promise<string> {
    const l = deps.listener();
    const hooks = service.store.listHooks();
    const counts = service.store.countByStatusSince(new Date(Date.now() - 86_400_000));
    const refused = Object.values(service.rejectCounts()).reduce((a, b) => a + b, 0);
    const lines = [
      `Webhooks: ${deps.isEnabled() ? "on" : "off"}`,
      `Listener: ${l.listening ? `127.0.0.1:${l.port}` : "not bound (needs webhooks on and an enabled hook)"}`,
      `Public URL: ${l.publicBaseUrl ?? "not set (ingress.publicBaseUrl)"}`,
    ];
    if (l.publicBaseUrl && deps.probeHealth) {
      const ok = await deps.probeHealth(`${l.publicBaseUrl}/healthz`).catch(() => false);
      lines.push(`Tunnel /healthz: ${ok ? "reachable" : "not reachable"}`);
    }
    const work = service.workload();
    lines.push(
      `Hooks: ${hooks.length} (${hooks.filter((h) => h.enabled).length} enabled)`,
      `Last 24 h: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ") || "no deliveries"}; refused ${refused}`,
      `Model work: ${work.active} running, ${work.queued} queued`,
    );
    return lines.join("\n");
  }

  async function add(ctx: CommandContext): Promise<string> {
    const { head, instructions } = splitInstructions(ctx.args.replace(/^add\b/i, "").trim());
    const tokens = head.split(/\s+/).filter(Boolean);
    const [name, sourceRaw, ...rest] = tokens;
    if (!name || !sourceRaw) return `Usage: /webhook add ${SUBCOMMANDS.add.args}`;
    const source = sourceRaw.toLowerCase() as WebhookSource;
    if (!WEBHOOK_SOURCES.includes(source)) return `Unknown source "${sourceRaw}". Use one of: ${WEBHOOK_SOURCES.join(", ")}`;
    const { pairs, flags } = parseKeyValues(rest);
    if (flags.length > 0) return `Unexpected "${flags[0]}". Options are key=value; instructions go after --.`;
    let events: string[] | undefined;
    let action: "notify" | "task" | undefined;
    let toolProfile: WebhookToolProfile | undefined;
    let fields: string[] | undefined;
    for (const [k, v] of pairs) {
      if (k === "events") events = parseEvents(v);
      else if (k === "action") {
        if (v !== "notify" && v !== "task") return "action must be notify or task";
        action = v;
      } else if (k === "tools") {
        if (v === "full") return "tools=full cannot be set at creation. Create the hook, then /webhook set <id> tools=full.";
        if (v !== "summarize" && v !== "investigate") return "tools must be summarize or investigate";
        toolProfile = v;
      } else if (k === "fields") fields = parseFields(v);
      else return `Unknown option "${k}"`;
    }
    const res = await service.addHook({
      name: name.toLowerCase(), source, events, action, toolProfile, fields,
      instructions: instructions ?? "",
      channel: ctx.message.channel, chatId: ctx.message.chatId, by: actorOf(ctx),
    });
    const h = res.hook;
    const lines = [
      `Created ${h.id} (disabled). Source ${h.source}, ${h.action === "notify" ? "notify (no model)" : `task with tools ${h.toolProfile}`}.`,
      `URL: ${res.url ?? `<publicBaseUrl>/hooks/${h.id} (set ingress.publicBaseUrl)`}`,
      `Secret: written to ${res.secretFile} (0600), deleted in 10 minutes. Copy it with: pbcopy < ${res.secretFile}`,
    ];
    if ((h.source === "bearer" || h.source === "alertmanager") && h.action === "task") {
      lines.push("Note: bearer hooks have no body signature; anyone holding the token can send any body to a task.");
    }
    lines.push("", webhookSetupText(h.source, res.url ?? `<publicBaseUrl>/hooks/${h.id}`));
    if (h.source === "sentry") lines.push(`Import file: ${service.importFilePath(h.id)}`);
    lines.push("", `Then: /webhook test ${h.id}, /webhook enable ${h.id}${deps.isEnabled() ? "" : ", /webhook on"}.`);
    return lines.join("\n");
  }

  async function set(ctx: CommandContext, id: string): Promise<string> {
    const hook = service.requireHook(id);
    const { head, instructions } = splitInstructions(ctx.args.replace(/^set\s+\S+/i, "").trim());
    const { pairs, flags } = parseKeyValues(head.split(/\s+/).filter(Boolean));
    if (flags.length > 0) return `Unexpected "${flags[0]}". Use key=value.`;
    if (pairs.length === 0 && instructions === undefined) return `Usage: /webhook set ${SUBCOMMANDS.set.args}`;
    const patch: WebhookPatch = {};
    for (const [k, v] of pairs) {
      switch (k) {
        case "events": patch.events = v === "all" ? [] : parseEvents(v); break;
        case "action":
          if (v !== "notify" && v !== "task") return "action must be notify or task";
          patch.action = v;
          break;
        case "tools":
          if (!WEBHOOK_TOOL_PROFILES.includes(v as WebhookToolProfile)) return "tools must be summarize, investigate or full";
          patch.toolProfile = v as WebhookToolProfile;
          patch.allowFull = v === "full";
          break;
        case "fields": patch.fields = v === "default" ? [] : parseFields(v); break;
        case "ip": {
          const list = v === "any" ? [] : csv(v);
          const bad = invalidWebhookCidr(list);
          if (bad) return `Bad address or CIDR "${bad}"`;
          patch.ipAllowlist = list;
          break;
        }
        case "rate": {
          const n = v === "default" ? null : parseIntInRange(v, 1, 600);
          if (n === null && v !== "default") return "rate must be 1 to 600 per minute, or default";
          patch.ratePerMin = n;
          break;
        }
        case "daily": {
          const n = v === "default" ? null : parseIntInRange(v, 1, 10_000);
          if (n === null && v !== "default") return "daily must be 1 to 10000, or default";
          patch.dailyCap = n;
          break;
        }
        case "raw": {
          const b = parseOnOff(v);
          if (b === null) return "raw must be on or off";
          patch.includeRaw = b;
          break;
        }
        case "instructions": patch.instructions = v; break;
        default: return `Unknown key "${k}". Keys: events, action, tools, fields, ip, rate, daily, raw, instructions`;
      }
    }
    if (instructions !== undefined) patch.instructions = instructions;
    if (patch.instructions !== undefined && patch.instructions.length > 2000) return "instructions are limited to 2000 characters";
    if (patch.toolProfile === "full") {
      if (!deps.config().allowFullProfile) return "tools=full needs webhooks.allowFullProfile: true in config.yaml first.";
      const ok = await ctx.confirm(
        `Allow the full tool profile for webhook ${hook.name}?`,
        "Its tasks run unattended with every tool Kirie has (shell, files, network), started by an external system. The payload is untrusted.",
      );
      if (!ok) return "Not changed.";
    }
    const updated = service.updateHook(hook.id, patch, actorOf(ctx));
    return `Updated ${updated.id}.\n${hookLine(updated, service.store.lastDeliveryAt(updated.id))}`;
  }

  function log(argv: readonly string[]): string {
    let hookId: string | undefined;
    let n = 10;
    for (const a of argv) {
      const num = parseIntInRange(a, 1, 50);
      if (num !== null) n = num;
      else hookId = service.requireHook(a).id;
    }
    const rows = service.store.recentDeliveries({ hookId, limit: n });
    const lines = rows.map((d) =>
      `#${d.id} ${d.receivedAt.slice(0, 19).replace("T", " ")} ${d.hookId} ${d.event ?? "-"} ${d.status}${d.taskId ? ` task ${d.taskId.slice(0, 8)}` : ""}${d.note ? ` (${d.note})` : ""}`);
    const rejects = (deps.audit?.recent({ feature: "webhooks", action: "delivery.rejected", limit: 200 }) ?? [])
      .filter((r) => !hookId || r.actor === `webhook:${hookId}`)
      .slice(-n)
      .map((r) => `${r.ts.slice(0, 19).replace("T", " ")} refused ${r.actor.replace(/^webhook:/, "")}: ${String(r.detail?.reason ?? "?")}${typeof r.detail?.skewSeconds === "number" ? ` (skew ${r.detail.skewSeconds}s)` : ""}${Number(r.detail?.suppressed) > 0 ? ` (+${String(r.detail?.suppressed)} earlier, not sampled)` : ""}`);
    return [
      rows.length > 0 ? "Deliveries:" : "No deliveries.",
      ...lines,
      ...(rejects.length > 0 ? ["", "Refused (sampled):", ...rejects] : []),
    ].join("\n");
  }

  async function handler(ctx: CommandContext): Promise<string> {
    const [subRaw, ...rest] = ctx.argv;
    const sub = (subRaw ?? "status").toLowerCase();
    const by = actorOf(ctx);
    const need = (what: string): string => {
      const v = rest[0];
      if (!v) throw new Error(`Usage: /webhook ${sub} ${what}`);
      return v;
    };
    switch (sub) {
      case "status": return status();
      case "list": {
        const hooks = service.store.listHooks();
        if (hooks.length === 0) return "No hooks. Create one with /webhook add <name> <source>.";
        return hooks.map((h) => hookLine(h, service.store.lastDeliveryAt(h.id))).join("\n");
      }
      case "add": return add(ctx);
      case "show": return describeHook(service, service.requireHook(need("<id>")));
      case "set": return set(ctx, need("<id> key=value ..."));
      case "remove": {
        const hook = service.requireHook(need("<id>"));
        const ok = await ctx.confirm(`Remove webhook ${hook.name}?`, `Deletes ${hook.id} and its secret. The provider's deliveries will get 404.`);
        if (!ok) return "Not removed.";
        await service.removeHook(hook.id, by);
        await deps.onHooksChanged?.();
        return `Removed ${hook.id}. Its delivery log stays for ${deps.config().deliveryRetentionDays} days.`;
      }
      case "enable":
      case "disable": {
        const h = await service.setHookEnabled(need("<id>"), sub === "enable", by);
        await deps.onHooksChanged?.();
        const note = sub === "enable" && !deps.isEnabled() ? " Webhooks are off globally: /webhook on." : "";
        return `${h.id} ${sub}d.${note}`;
      }
      case "test": {
        const id = need("<id> [run]");
        const run = rest[1]?.toLowerCase() === "run";
        const report = await service.testHook(id, { run });
        return [`Test of ${id}${run ? " (run: the action is performed)" : " (dry run: nothing stored, no action)"}:`, ...report].join("\n");
      }
      case "rotate-secret": {
        const id = need("<id> [grace=<minutes>] [from-file]");
        const { pairs, flags } = parseKeyValues(rest.slice(1));
        let grace = 0;
        for (const [k, v] of pairs) {
          if (k !== "grace") return `Unknown option "${k}"`;
          const n = parseIntInRange(v, 0, WEBHOOK_MAX_GRACE_MINUTES);
          if (n === null) return `grace must be 0 to ${WEBHOOK_MAX_GRACE_MINUTES} minutes`;
          grace = n;
        }
        const fromFile = flags.includes("from-file");
        if (flags.some((f) => f !== "from-file")) return `Unknown option "${flags.find((f) => f !== "from-file")}"`;
        const res = await service.rotateSecret(id, { graceMinutes: grace, fromFile, by });
        const lines = [`New secret for ${res.hook.id}${fromFile ? " imported (the import file was deleted)" : ""}.`];
        if (res.secretFile) lines.push(`Written to ${res.secretFile} (0600), deleted in 10 minutes: pbcopy < ${res.secretFile}`);
        lines.push(grace > 0 ? `The old secret stays valid for ${grace} minutes.` : "The old secret no longer works.");
        return lines.join("\n");
      }
      case "secret": {
        const id = need("<id>");
        if (rest[1]?.toLowerCase() === "chat") {
          return "Secrets are never sent in chat: outbound messages are scrubbed of known secrets. Use /webhook secret <id> (file).";
        }
        const path = await service.revealSecretToFile(id, by);
        return `Written to ${path} (0600), deleted in 10 minutes. Copy it with: pbcopy < ${path}`;
      }
      case "log": return log(rest);
      case "forget": {
        const n = parseIntInRange(need("<delivery>").replace(/^#/, ""), 1, Number.MAX_SAFE_INTEGER);
        if (n === null) return "Usage: /webhook forget <delivery number>";
        return service.forgetDelivery(n, by) ? `Delivery #${n} forgotten: a provider redelivery of the same body is accepted again.` : `No delivery #${n}.`;
      }
      case "on":
      case "off": {
        await deps.setEnabled(sub === "on", by);
        const l = deps.listener();
        return sub === "on"
          ? `Webhooks on. Listener ${l.listening ? `127.0.0.1:${l.port}` : "not bound until a hook is enabled"}.${l.publicBaseUrl ? "" : " Set ingress.publicBaseUrl and create the tunnel (docs/webhooks.md)."}`
          : `Webhooks off. /hooks is unmounted${l.listening ? "; the listener stays up for another feature" : " and the listener is closed"}.`;
      }
      default:
        return `Unknown subcommand "${sub}". Subcommands: ${Object.keys(SUBCOMMANDS).join(", ")}`;
    }
  }

  return [{
    name: "webhook",
    aliases: ["webhooks"],
    description: "Webhook triggers: status, list, add, show, set, remove, enable, disable, test, rotate-secret, secret, log, forget, on, off",
    category: "integrations",
    ownerOnly: true,
    scope: "dm",
    args: "[status|list|add|show|set|remove|enable|disable|test|rotate-secret|secret|log|forget|on|off]",
    usage: "/webhook add deploys github events=workflow_run -- Tell me when a deploy fails.",
    subcommands: SUBCOMMANDS,
    handler,
  }];
}
