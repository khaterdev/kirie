/**
 * What a session is given (PLAN C.13, contributor `computer-use`, order 60).
 *
 * Experiment E8: a server-level name in `disallowedTools` hides nothing. So
 * when a session must not have computer use, the cua-driver server is kept out
 * of `mcpServers` and every known tool name of both reserved servers is listed
 * in full in `disallowedTools` (that hides a copy the upstream installer put in
 * ~/.claude.json, which Kirie sessions inherit unless `agent.strictMcpConfig`
 * is on). The `reserved-mcp` and `computer-use` gates remain the binding
 * control for any name not on the list.
 *
 * The shared `mcpServers`, `allowedTools` and `disallowedTools` objects are
 * never mutated: the options get fresh copies.
 */

import { basename } from "node:path";
import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ComputerUseConfig } from "../config/sections/computer-use.js";
import { expandComputerUsePath } from "./driver.js";
import {
  classifyComputerUseTool,
  computerUseKnownToolNames,
  COMPUTER_USE_SERVER_NAME,
  COMPUTER_USE_SERVER_NAMES,
  isComputerUseToolName,
} from "./tools.js";

/** Telemetry off for the proxy (variable name from Hermes' docs; cua's own docs only document `cua-driver telemetry disable`). */
export const COMPUTER_USE_DRIVER_ENV: Readonly<Record<string, string>> = { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };

/** The stdio server entry: `<driverPath> mcp`, telemetry off. */
export function computerUseServerConfig(cfg: ComputerUseConfig, home?: string): McpServerConfig {
  return {
    command: expandComputerUsePath(cfg.driverPath, home),
    args: ["mcp"],
    env: { ...COMPUTER_USE_DRIVER_ENV },
  };
}

function mentionsDriver(text: string): boolean {
  // Quotes and backslashes do not split a word in the shell: "cua-dri''ver" still runs cua-driver.
  return /cua-?driver|com\.trycua/i.test(text.replace(/['"\\]/g, ""));
}

/** True when an MCP server entry would run the cua driver (by command basename or anywhere in its command line). */
export function isComputerUseDriverServer(entry: { command?: string; args?: readonly string[] } | null | undefined): boolean {
  if (!entry || typeof entry.command !== "string") return false;
  const base = basename(entry.command.trim()).toLowerCase();
  if (base === "cua-driver" || base === "cua-driver.exe") return true;
  return mentionsDriver(entry.command) || (entry.args ?? []).some((a) => typeof a === "string" && mentionsDriver(a));
}

export function isComputerUseReservedServerName(name: string): boolean {
  return COMPUTER_USE_SERVER_NAMES.includes(name.toLowerCase());
}

/**
 * Remove the reserved names and any entry that runs the driver from a server
 * map, in place. For the daemon's shared map at setup: the driver is only ever
 * added per session by the contributor. Returns the names removed.
 */
export function removeComputerUseServers(servers: Record<string, McpServerConfig>): string[] {
  const removed: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (isComputerUseReservedServerName(name) || isComputerUseDriverServer(entry as { command?: string; args?: string[] })) {
      delete servers[name];
      removed.push(name);
    }
  }
  return removed;
}

/** Full names of every known tool of both reserved servers. */
export function computerUseHiddenToolNames(): string[] {
  return COMPUTER_USE_SERVER_NAMES.flatMap((server) => computerUseKnownToolNames().map((n) => `mcp__${server}__${n}`));
}

/** Full names of the tools a session with the server may call (observe, capture when enabled, act). */
export function computerUseOfferedToolNames(cfg: ComputerUseConfig): string[] {
  const names = [...new Set([...computerUseKnownToolNames(), ...cfg.tools.allow])];
  return names
    .filter((n) => {
      const cls = classifyComputerUseTool(n, cfg.tools);
      if (cls === "blocked") return false;
      if (cls === "capture") return cfg.screenshots === "desktop";
      return true;
    })
    .map((n) => `mcp__${COMPUTER_USE_SERVER_NAME}__${n}`);
}

/**
 * Shape one spawn's options. `offer` true: add the cua-driver server, allow its
 * offered tools, hide the rest. `offer` false: no cua server of either name,
 * no allowed cua entry, every known cua tool hidden.
 */
export function applyComputerUseSessionOptions(options: Options, offer: boolean, cfg: ComputerUseConfig, home?: string): void {
  if (options.mcpServers || offer) {
    const servers: Record<string, McpServerConfig> = { ...(options.mcpServers ?? {}) };
    removeComputerUseServers(servers);
    if (offer) servers[COMPUTER_USE_SERVER_NAME] = computerUseServerConfig(cfg, home);
    options.mcpServers = servers;
  }

  // A tool the call site already disallows stays disallowed, even while offered.
  const existing = options.disallowedTools ?? [];
  const alreadyDisallowed = new Set(existing);
  const offered = offer ? computerUseOfferedToolNames(cfg).filter((n) => !alreadyDisallowed.has(n)) : [];
  if (options.allowedTools || offered.length > 0) {
    const allowed = (options.allowedTools ?? []).filter((t) => !isComputerUseToolName(t));
    options.allowedTools = [...allowed, ...offered];
  }

  const offeredSet = new Set(offered);
  const hide = computerUseHiddenToolNames().filter((n) => !offeredSet.has(n));
  options.disallowedTools = [...new Set([...existing, ...hide])];
}
