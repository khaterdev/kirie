/**
 * Owner notices and display text for accounts (PLAN C.1). One plain line each;
 * the owner notifier scrubs and rate-limits them (one per account per event
 * type per 10 minutes, by key).
 */

import { homedir } from "node:os";
import { formatResetTime } from "../engine/reset-time.js";
import type { AccountAuthErrorEvent, AccountRotatedEvent, AccountsExhaustedEvent } from "./account-manager.js";
import type { ClaudeAccount } from "./account-store.js";

/**
 * DECISIONS 22: the default account loads the owner's claude.ai connectors
 * into Kirie's sessions; another config dir may have none, so a switch can
 * change which MCP tools the agent has.
 */
export const ACCOUNTS_MCP_NOTE =
  "Note: MCP tools can differ between accounts. The default account loads your claude.ai connectors; other config dirs may not have them.";

/** "/Users/x/.claude2" -> "~/.claude2" for display. */
export function displayPath(path: string, home: string = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** "session limit", "weekly limit", ... from a rate-limit type. */
export function limitName(limitType: string | null | undefined): string {
  if (!limitType) return "usage limit";
  if (limitType === "five_hour") return "session limit";
  if (limitType === "seven_day_opus") return "weekly Opus limit";
  if (limitType === "seven_day_sonnet") return "weekly Sonnet limit";
  if (limitType.startsWith("seven_day")) return "weekly limit";
  return "usage limit";
}

export function formatAccountTime(ms: number, tz?: string): string {
  return formatResetTime(ms, tz);
}

/** The login command the owner runs for an account. */
export function loginCommand(account: Pick<ClaudeAccount, "configDir">, home: string = homedir()): string {
  return account.configDir ? `CLAUDE_CONFIG_DIR=${displayPath(account.configDir, home)} claude /login` : "claude /login";
}

export function rotationNotice(ev: AccountRotatedEvent, tz?: string): string {
  const reset = ev.fromResetAtMs ? ` (resets ${formatAccountTime(ev.fromResetAtMs, tz)})` : "";
  let head: string;
  switch (ev.cause) {
    case "limit":
      head = `Claude account ${ev.from} hit its ${limitName(ev.fromLimitType)}${reset}. Switched to ${ev.to}.`;
      break;
    case "auth":
      head = `Claude account ${ev.from} is signed out or blocked. Switched to ${ev.to}.`;
      break;
    case "model_limit":
      head = `Claude account ${ev.from} reached a model limit. Switched to ${ev.to}.`;
      break;
    case "primary":
      head = `Claude account ${ev.to} is usable again. Switched back to it from ${ev.from}.`;
      break;
    case "disabled":
      head = `The active Claude account${ev.from ? ` ${ev.from}` : ""} is disabled or removed. Using ${ev.to}.`;
      break;
  }
  return `${head} ${ACCOUNTS_MCP_NOTE}`;
}

export function exhaustedNotice(ev: AccountsExhaustedEvent, tz?: string): string {
  if (!ev.earliest) return "All Claude accounts are limited or signed out. Send /accounts for details.";
  return `All Claude accounts are limited. Earliest reset: ${ev.earliest.accountId} at ${formatAccountTime(ev.earliest.atMs, tz)}.`;
}

export function authErrorNotice(ev: AccountAuthErrorEvent, account: Pick<ClaudeAccount, "configDir"> | null, home?: string): string {
  if (ev.reason === "identity_changed") {
    const where = account?.configDir ? displayPath(account.configDir, home) : "the default login";
    return `Claude account ${ev.accountId}: ${where} is now logged in to a different Claude account, so Kirie stopped using it. Check it, then send /accounts reset ${ev.accountId}.`;
  }
  const cmd = account ? loginCommand(account, home) : "claude /login";
  return `Claude account ${ev.accountId} needs a new login (run: ${cmd}, then send /accounts reset ${ev.accountId}).`;
}
