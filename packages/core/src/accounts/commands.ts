/**
 * Owner commands for items 1 and 2 (PLAN B.12): /accounts, /rotation, /fallback.
 * All owner-only, DM-only; the registry checks the owner before a handler
 * runs. Changes are runtime overrides or accounts.db state, never config.yaml,
 * and each one writes an audit record.
 */

import { z } from "zod/v3";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { FallbackConfig } from "../config/sections/fallback.js";
import { MAX_FALLBACK_MODELS, MODEL_ID_RE, parseModelList, resolveFallbackChain } from "../engine/model-chain.js";
import { AccountImportError, type AccountManager, type AccountView } from "./account-manager.js";
import type { FallbackControl } from "./fallback-control.js";
import { ACCOUNTS_MCP_NOTE, displayPath, formatAccountTime, limitName, loginCommand } from "./notices.js";

export const ACCOUNTS_ROTATION_SETTING = "accounts.rotation.enabled";
export const FALLBACK_ENABLED_SETTING = "agent.fallback.enabled";
export const FALLBACK_MODELS_SETTING = "agent.fallback.models";

export const AccountsBooleanSetting = z.boolean();
export const FallbackModelsSetting = z.array(z.string().regex(MODEL_ID_RE)).max(MAX_FALLBACK_MODELS);

export interface AccountsCommandDeps {
  manager: AccountManager;
  fallback: FallbackControl;
  settings: Pick<RuntimeSettings, "set" | "delete" | "get">;
  audit: Pick<AuditTrail, "recent">;
  rotationEnabled: () => boolean;
  /** agent.model */
  primaryModel: () => string;
  /** Effective agent.fallback (overrides applied) */
  fallbackConfig: () => FallbackConfig;
  timezone?: string;
  home?: string;
}

const ACCOUNTS_USAGE = [
  "/accounts - list accounts (active one marked with *)",
  "/accounts discover - show ~/.claude* dirs and whether each looks logged in",
  "/accounts import <dir|all> - import one dir, or every discovered dir that looks logged in",
  "/accounts add <id> <dir> - import a dir outside the ~/.claude* pattern",
  "/accounts enable <id> | disable <id>",
  "/accounts use <id> - make it active from the next turn",
  "/accounts reset <id|all> - clear a limit or login error",
  "/accounts test <id> - login check, no quota used",
  "/accounts remove <id> - forget the account (the dir is not touched)",
  "/accounts log - recent account events",
  "",
  "The default account is the login with CLAUDE_CONFIG_DIR unset (~/.claude). To add another login, run CLAUDE_CONFIG_DIR=<dir> claude /login yourself, then /accounts add <id> <dir>.",
  "Rotation (/rotation on) moves to the next account when one hits its limit. Accounts are used only after you import them.",
  ACCOUNTS_MCP_NOTE,
].join("\n");

const FALLBACK_USAGE = [
  "/fallback - show the chain and benched models",
  "/fallback on | off",
  "/fallback set <model1,model2> - replace the chain (at most 4)",
  "/fallback clear - empty the chain",
  "/fallback reset - back to config.yaml values and clear benched models",
].join("\n");

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function errorText(err: unknown): string {
  if (err instanceof AccountImportError) return err.message;
  return "something went wrong; see the daemon log";
}

function statusText(a: AccountView, tz?: string): string {
  if (!a.enabled) return a.status === "auth_error" ? "disabled (needs login)" : "disabled";
  if (a.status === "limited") {
    const until = a.limitedUntil ? ` until ${formatAccountTime(a.limitedUntil, tz)}` : "";
    return `${limitName(a.limitType)}${until}`;
  }
  if (a.status === "auth_error") return `needs login${a.lastError ? ` (${a.lastError})` : ""}`;
  return "ok";
}

export function renderAccountList(deps: AccountsCommandDeps): string {
  const accounts = deps.manager.list();
  const rotation = deps.rotationEnabled() ? "on" : "off";
  if (accounts.length === 0) {
    return [
      `No Claude accounts imported (rotation ${rotation}). Kirie uses the default login (CLAUDE_CONFIG_DIR unset), as before.`,
      "/accounts discover lists the config dirs on this machine; /accounts import all adds the ones that look logged in.",
    ].join("\n");
  }
  const lines = [`Claude accounts (rotation ${rotation}):`];
  for (const a of accounts) {
    const where = a.kind === "default" ? "default login" : displayPath(a.configDir ?? "", deps.home);
    const parts = [`${a.active ? "*" : " "} ${a.id}`, a.label ?? "", a.subscription ?? "", where, statusText(a, deps.timezone)];
    lines.push(parts.filter(Boolean).join("  "));
  }
  const earliest = deps.manager.earliestReset();
  if (earliest && accounts.every((a) => !a.usable)) {
    lines.push(`All accounts are limited. Earliest reset: ${earliest.accountId} at ${formatAccountTime(earliest.atMs, deps.timezone)}.`);
  }
  lines.push(renderFallbackLine(deps));
  return lines.join("\n");
}

function renderFallbackLine(deps: AccountsCommandDeps): string {
  const cfg = deps.fallbackConfig();
  const chain = resolveFallbackChain(deps.primaryModel(), cfg.models);
  if (!cfg.enabled) return `Model fallback: off${chain.length ? ` (chain: ${chain.join(", ")})` : ""}`;
  return `Model fallback: on (${chain.length ? chain.join(", ") : "empty chain"})`;
}

async function accountsHandler(deps: AccountsCommandDeps, ctx: CommandContext): Promise<string> {
  const [sub = "list", ...rest] = ctx.argv;
  const actor = actorOf(ctx);
  const m = deps.manager;
  try {
    switch (sub.toLowerCase()) {
      case "list":
        return renderAccountList(deps);
      case "help":
        return ACCOUNTS_USAGE;
      case "discover": {
        const dirs = m.discover();
        if (dirs.length === 0) return "No ~/.claude* config dirs found.";
        const lines = ["Config dirs:"];
        for (const d of dirs) {
          const who = d.identity.ok ? d.identity.identity.label : d.identity.reason === "not_logged_in" ? "not logged in" : "no identity file";
          const login = d.login === "logged_in" ? "login found" : d.login === "not_found" ? "no saved login" : "login unknown";
          const state = d.importedAs ? `imported as ${d.importedAs}` : `not imported (id ${d.suggestedId})`;
          lines.push(`${displayPath(d.path, deps.home)}${d.kind === "default" ? " (default)" : ""}  ${who}  ${login}  ${state}`);
        }
        return lines.join("\n");
      }
      case "import": {
        const target = rest.join(" ").trim();
        if (!target) return "Usage: /accounts import <dir|all>";
        if (target.toLowerCase() === "all") return importAll(deps, actor);
        return importOne(deps, target, actor);
      }
      case "add": {
        const [id, ...dirParts] = rest;
        const dir = dirParts.join(" ").trim();
        if (!id || !dir) return "Usage: /accounts add <id> <dir>";
        return importOne(deps, dir, actor, id);
      }
      case "enable":
      case "disable": {
        const id = rest[0];
        if (!id) return `Usage: /accounts ${sub} <id>`;
        m.setEnabled(id, sub === "enable", actor);
        return `Account ${id} ${sub === "enable" ? "enabled" : "disabled"}. It applies from the next turn.`;
      }
      case "use": {
        const id = rest[0];
        if (!id) return "Usage: /accounts use <id>";
        const { clearedLimit } = m.use(id, actor);
        return `Account ${id} is active from the next turn.${clearedLimit ? " Its limit or login error was cleared by this switch; if it is still limited, the next turn will say so." : ""}`;
      }
      case "reset": {
        const id = rest[0];
        if (!id) return "Usage: /accounts reset <id|all>";
        const ids = m.reset(id === "all" ? "all" : id, actor);
        return ids.length ? `Cleared limits and login errors for: ${ids.join(", ")}.` : "No accounts to reset.";
      }
      case "test": {
        const id = rest[0];
        if (!id) return "Usage: /accounts test <id>";
        const acc = m.get(id);
        if (!acc) return `No account named ${id}.`;
        const res = await m.test(id, actor);
        const identity = res.identity.ok ? res.identity.identity.label : "no account in its identity file";
        const verify = !res.verify
          ? "not verified"
          : res.verify.ok
            ? `verified (${res.verify.label ?? "?"}${res.verify.subscription ? `, ${res.verify.subscription}` : ""})`
            : res.verify.reason === "timeout"
              ? "verify timed out: the login is not readable from the daemon"
              : `not logged in (run: ${loginCommand(acc, deps.home)})`;
        return `${id}: identity ${identity}; saved login ${res.login.replace("_", " ")}; ${verify}. No quota was used.`;
      }
      case "remove": {
        const id = rest[0];
        if (!id) return "Usage: /accounts remove <id>";
        if (!m.get(id)) return `No account named ${id}.`;
        const ok = await ctx.confirm(`Forget Claude account ${id}?`, "Kirie stops using it. The config dir and its login are not touched; you can import it again.");
        if (!ok) return "Cancelled.";
        m.remove(id, actor);
        return `Account ${id} removed.`;
      }
      case "log": {
        const records = deps.audit.recent({ feature: "accounts", limit: 10 });
        if (records.length === 0) return "No account events yet.";
        return records
          .map((r) => {
            const d = r.detail ?? {};
            const who = typeof d.account === "string" ? d.account : Array.isArray(d.accounts) ? (d.accounts as unknown[]).join(",") : typeof d.to === "string" ? `${String(d.from ?? "-")} -> ${d.to}` : "";
            return `${r.ts.slice(0, 16).replace("T", " ")}  ${r.action}  ${who}  ${r.actor}`;
          })
          .join("\n");
      }
      default:
        return `Unknown subcommand "${sub}".\n${ACCOUNTS_USAGE}`;
    }
  } catch (err) {
    return errorText(err);
  }
}

async function importOne(deps: AccountsCommandDeps, dir: string, actor: string, id?: string): Promise<string> {
  try {
    const out = await deps.manager.importDir(dir, { actor, ...(id ? { id } : {}) });
    const a = out.account;
    const verified = out.verify
      ? out.verify.ok
        ? ` Verified (${out.verify.subscription ?? a.subscription ?? "login ok"}).`
        : ` Imported DISABLED: ${a.lastError ?? "not logged in"}. Fix it with: ${loginCommand(a, deps.home)}, then /accounts reset ${a.id} and /accounts enable ${a.id}.`
      : a.enabled
        ? ""
        : ` Imported DISABLED: ${a.lastError ?? "no saved login"}.`;
    const active = out.becameActive ? " It is the active account." : "";
    return `Imported ${a.id} (${a.label ?? "?"}).${verified}${active}`;
  } catch (err) {
    return `Not imported: ${errorText(err)}`;
  }
}

async function importAll(deps: AccountsCommandDeps, actor: string): Promise<string> {
  const candidates = deps.manager
    .discover()
    .filter((d) => !d.importedAs && d.identity.ok && d.login !== "not_found");
  if (candidates.length === 0) return "Nothing to import: every logged-in config dir is already imported.";
  const lines: string[] = [];
  for (const d of candidates) {
    lines.push(`${displayPath(d.path, deps.home)}: ${await importOne(deps, d.path, actor)}`);
  }
  lines.push(ACCOUNTS_MCP_NOTE);
  return lines.join("\n");
}

function rotationHandler(deps: AccountsCommandDeps, ctx: CommandContext): string {
  const arg = (ctx.argv[0] ?? "").toLowerCase();
  const actor = actorOf(ctx);
  if (!arg || arg === "status") {
    const count = deps.manager.list().filter((a) => a.enabled).length;
    return `Account rotation is ${deps.rotationEnabled() ? "on" : "off"} (${count} enabled account${count === 1 ? "" : "s"}).`;
  }
  if (arg === "on" || arg === "off") {
    deps.settings.set(ACCOUNTS_ROTATION_SETTING, arg === "on", actor);
    const count = deps.manager.list().filter((a) => a.enabled).length;
    const warn = arg === "on" && count < 2 ? " Import at least two accounts for it to do anything (/accounts discover)." : "";
    return `Account rotation is ${arg}.${warn}${arg === "on" ? ` ${ACCOUNTS_MCP_NOTE}` : ""}`;
  }
  if (arg === "reset") {
    deps.settings.delete(ACCOUNTS_ROTATION_SETTING, actor);
    return `Rotation override removed; it is ${deps.rotationEnabled() ? "on" : "off"} per config.yaml.`;
  }
  return "Usage: /rotation [on|off|reset]";
}

function fallbackHandler(deps: AccountsCommandDeps, ctx: CommandContext): string {
  const [sub = "show", ...rest] = ctx.argv;
  const actor = actorOf(ctx);
  const primary = deps.primaryModel();
  switch (sub.toLowerCase()) {
    case "show":
    case "status": {
      const cfg = deps.fallbackConfig();
      const chain = resolveFallbackChain(primary, cfg.models);
      const lines = [
        `Primary model: ${primary}`,
        `Fallback: ${cfg.enabled ? "on" : "off"}; chain: ${chain.length ? chain.join(", ") : "(empty)"}${cfg.sdkNative ? "; also passed to the SDK for overloads" : ""}`,
      ];
      const benched = deps.fallback.benched();
      if (benched.length > 0) {
        lines.push("Benched:");
        for (const b of benched) {
          lines.push(`  ${b.model} on ${b.accountId ?? "default login"} until ${formatAccountTime(b.limitedUntil, deps.timezone)} (${b.reason ?? "?"})`);
        }
      }
      return lines.join("\n");
    }
    case "on":
    case "off": {
      deps.settings.set(FALLBACK_ENABLED_SETTING, sub === "on", actor);
      const empty = sub === "on" && resolveFallbackChain(primary, deps.fallbackConfig().models).length === 0;
      return `Model fallback is ${sub}.${empty ? " The chain is empty; set it with /fallback set <model1,model2>." : ""}`;
    }
    case "set": {
      const { models, invalid } = parseModelList(rest.join(" "));
      if (invalid.length > 0) return `Invalid model id: ${invalid.join(", ")}`;
      if (models.length === 0) return "Usage: /fallback set <model1,model2>";
      if (models.length > MAX_FALLBACK_MODELS) return `At most ${MAX_FALLBACK_MODELS} fallback models.`;
      deps.settings.set(FALLBACK_MODELS_SETTING, models, actor);
      const dropped = models.includes(primary) ? ` ${primary} is the primary model and is skipped in the chain.` : "";
      return `Fallback chain: ${models.join(", ")}.${dropped}${deps.fallbackConfig().enabled ? "" : " Fallback is off; turn it on with /fallback on."}`;
    }
    case "clear":
      deps.settings.set(FALLBACK_MODELS_SETTING, [], actor);
      return "Fallback chain cleared.";
    case "reset": {
      deps.settings.delete(FALLBACK_ENABLED_SETTING, actor);
      deps.settings.delete(FALLBACK_MODELS_SETTING, actor);
      const n = deps.fallback.clearBenches();
      return `Fallback overrides removed (config.yaml values apply) and ${n} benched model${n === 1 ? "" : "s"} cleared.`;
    }
    case "help":
      return FALLBACK_USAGE;
    default:
      return `Unknown subcommand "${sub}".\n${FALLBACK_USAGE}`;
  }
}

export function createAccountsCommands(deps: AccountsCommandDeps): CommandDefinition[] {
  return [
    {
      name: "accounts",
      aliases: ["account"],
      description: "Claude accounts: list, discover, import, add, enable, disable, use, reset, test, remove, log",
      category: "accounts",
      ownerOnly: true,
      scope: "dm",
      args: "[discover|import|add|enable|disable|use|reset|test|remove|log]",
      usage: ACCOUNTS_USAGE,
      subcommands: {
        discover: { description: "Show ~/.claude* dirs and their login state" },
        import: { args: "<dir|all>", description: "Import a config dir, or all logged-in ones" },
        add: { args: "<id> <dir>", description: "Import a dir outside the ~/.claude* pattern" },
        enable: { args: "<id>", description: "Let the account take part" },
        disable: { args: "<id>", description: "Stop using the account" },
        use: { args: "<id>", description: "Make it active from the next turn" },
        reset: { args: "<id|all>", description: "Clear a limit or login error" },
        test: { args: "<id>", description: "Login check, no quota used" },
        remove: { args: "<id>", description: "Forget the account" },
        log: { description: "Recent account events" },
      },
      handler: (ctx) => accountsHandler(deps, ctx),
    },
    {
      name: "rotation",
      description: "Turn automatic account rotation on or off",
      category: "accounts",
      ownerOnly: true,
      scope: "dm",
      args: "[on|off|reset]",
      usage: `/rotation - show the state\n/rotation on | off\n/rotation reset - back to config.yaml\n${ACCOUNTS_MCP_NOTE}`,
      handler: (ctx) => rotationHandler(deps, ctx),
    },
    {
      name: "fallback",
      description: "Fallback model chain: show, set, clear, reset, on, off",
      category: "accounts",
      ownerOnly: true,
      scope: "dm",
      args: "[on|off|set <models>|clear|reset]",
      usage: FALLBACK_USAGE,
      handler: (ctx) => fallbackHandler(deps, ctx),
    },
  ];
}
