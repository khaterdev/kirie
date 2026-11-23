/**
 * The `computer-use` tool gate (order 300, PLAN B.1 and C.13).
 *
 * Driver tools: resolve the target pid, then map the pure policy decision to
 * a gate verdict. An ask is answered by the owner through
 * `OwnerPrompts.requestApproval({ kind: "computer" })`, independent of the
 * global approval mode.
 *
 * Bash: a tripwire, not a boundary. With unrestricted Bash the agent could
 * drive the driver from the shell once CuaDriver.app has its macOS grants; the
 * tripwire denies the obvious forms (see docs/computer-use-setup.md).
 */

import type { ToolGate, ToolGateCall, ToolGateVerdict } from "../engine/sdk-options.js";
import { computerUseInputPids, computerUseTypedChars, decideComputerUse, type ComputerUseAppInfo } from "./policy.js";
import type { ComputerUseService } from "./service.js";
import { computerUseBareToolName, COMPUTER_USE_SERVER_NAME } from "./tools.js";

export const COMPUTER_USE_GATE_NAME = "computer-use";
export const COMPUTER_USE_GATE_ORDER = 300;
export const COMPUTER_USE_GATE_MATCHER = /^(Bash|mcp__(cua-driver|cua-computer-use)__.+)$/;

/** Driver subcommands that are never allowed from Bash, armed or not. */
const ALWAYS_DENIED = /\b(permissions\s+grant|connect|update|upgrade|serve|install|uninstall|config\s+set|telemetry\s+enable)\b/i;
/** Read-only driver subcommands allowed from Bash while armed. */
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["--version", "-v", "version", "status", "doctor", "list-tools", "help", "--help", "-h", "stop"]);

const DRIVER_TOKEN = /(?:^|[^\w.-])((?:[^\s'"`;&|()<>]*\/)?cua-driver)(?![\w.-])/gi;
const DRIVER_APP = /CuaDriver\.app|com\.trycua\.driver/i;
/** The app bundle's own executables: never run from Bash, armed or not. */
const DRIVER_APP_BINARY = /CuaDriver\.app\/Contents\/(MacOS|Resources)\//i;

/** Up to the next shell separator. */
function invocationAfter(command: string, index: number): string {
  const rest = command.slice(index);
  const end = rest.search(/[;&|\n()`]/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Decide a Bash command for the tripwire. Returns a deny reason, or null to pass.
 * - always: cua-driver permissions grant, connect, update, serve, install, config set, telemetry enable
 * - not armed: any mention of cua-driver, CuaDriver.app or com.trycua.driver
 * - armed or not: running an executable inside CuaDriver.app
 * - armed: only read-only subcommands (status, permissions status, doctor, list-tools, --version, help, stop)
 */
export function checkComputerUseBash(rawCommand: string, armed: boolean): string | null {
  if (typeof rawCommand !== "string" || rawCommand.length === 0) return null;
  // Quotes and backslashes do not split a word in the shell (c'u'a-driver, cua\-driver): drop them before matching.
  const command = rawCommand.replace(/['"\\]/g, "");
  const invocations: string[] = [];
  DRIVER_TOKEN.lastIndex = 0;
  for (let m = DRIVER_TOKEN.exec(command); m !== null; m = DRIVER_TOKEN.exec(command)) {
    const start = m.index + m[0].length - (m[1]?.length ?? 0);
    invocations.push(invocationAfter(command, start));
  }

  for (const inv of invocations) {
    if (ALWAYS_DENIED.test(inv)) {
      return "Kirie never grants permissions to, connects, updates, serves or reconfigures cua-driver. The owner does that from Terminal (docs/computer-use-setup.md).";
    }
  }
  if (DRIVER_APP_BINARY.test(command)) {
    return "Do not run CuaDriver.app's executables from the shell; desktop control goes through the cua-driver MCP tools while armed.";
  }
  if (!armed) {
    if (invocations.length > 0 || DRIVER_APP.test(command)) {
      return "Desktop control is off. Do not drive cua-driver from the shell; the owner can arm computer use with /computer on.";
    }
    return null;
  }
  for (const inv of invocations) {
    const words = inv.trim().split(/\s+/).slice(1).filter((w) => !/^--?(json|quiet|q|verbose)$/i.test(w));
    const sub = (words[0] ?? "").toLowerCase();
    if (sub === "permissions" && (words[1] ?? "").toLowerCase() === "status") continue;
    if (READ_ONLY_SUBCOMMANDS.has(sub)) continue;
    return "Use the cua-driver MCP tools for desktop control, not the shell: only read-only cua-driver commands may run from Bash.";
  }
  return null;
}

function bashCommand(input: Record<string, unknown>): string {
  return typeof input.command === "string" ? input.command : "";
}

/** True when the call comes from the owner's own interactive DM turn, on the main thread. */
function ownerInteractive(service: ComputerUseService, call: ToolGateCall): boolean {
  if (!service.isOwnerChatContext(call.ctx)) return false;
  if (call.agentId) return false;
  return service.safeOrigin(call.ctx) === "owner_message";
}

async function resolveApps(service: ComputerUseService, input: Record<string, unknown>): Promise<Map<number, ComputerUseAppInfo | null>> {
  const apps = new Map<number, ComputerUseAppInfo | null>();
  for (const pid of computerUseInputPids(input).slice(0, 2)) {
    try {
      apps.set(pid, await service.resolveApp(pid));
    } catch {
      apps.set(pid, null);
    }
  }
  return apps;
}

export function createComputerUseGate(service: ComputerUseService): ToolGate {
  return {
    name: COMPUTER_USE_GATE_NAME,
    order: COMPUTER_USE_GATE_ORDER,
    matcher: COMPUTER_USE_GATE_MATCHER,
    async check(call: ToolGateCall): Promise<ToolGateVerdict> {
      if (call.tool === "Bash") {
        const reason = checkComputerUseBash(bashCommand(call.input), service.arming.isArmed());
        if (!reason) return { decision: "pass" };
        service.audit("bash.denied", `agent:${call.ctx.sessionKey ?? call.ctx.label}`, { label: call.ctx.label });
        return { decision: "deny", reason };
      }

      const bare = computerUseBareToolName(call.tool);
      const actor = `agent:${call.ctx.sessionKey ?? call.ctx.label}`;
      if (!bare) return { decision: "pass" };
      if (bare.server !== COMPUTER_USE_SERVER_NAME) {
        service.audit("call.denied", actor, { tool: bare.name, server: bare.server, reason: "unmanaged server" });
        return { decision: "deny", reason: `The ${bare.server} server is not managed by Kirie; computer use goes only through cua-driver.` };
      }

      const decision = decideComputerUse(bare.name, call.input, {
        cfg: service.config,
        arm: service.arming.state(),
        grants: service.arming.grants(),
        now: Date.now(),
        ownerInteractive: ownerInteractive(service, call),
        apps: await resolveApps(service, call.input),
        isDangerousText: (t) => service.isDangerousText(t),
      });

      const chars = computerUseTypedChars(bare.name, call.input);
      const detail: Record<string, unknown> = {
        tool: bare.name,
        class: decision.toolClass,
        label: call.ctx.label,
        ...(decision.app ? { app: decision.app.bundleId } : {}),
        ...(chars !== undefined ? { chars } : {}),
        ...(call.agentId ? { subagent: true } : {}),
      };

      if (decision.kind === "deny") {
        service.audit("call.denied", actor, { ...detail, reason: decision.reason });
        return { decision: "deny", reason: decision.reason };
      }
      if (decision.kind === "allow") {
        service.audit("call.allowed", actor, detail);
        return decision.updatedInput ? { decision: "pass", updatedInput: decision.updatedInput } : { decision: "pass" };
      }

      if (decision.updatedInput) {
        // An ask cannot carry a rewritten input through canUseTool; never run the unrewritten one.
        const reason = "Screenshots are off for computer use: call again with include_screenshot set to false.";
        service.audit("call.denied", actor, { ...detail, reason });
        return { decision: "deny", reason };
      }
      service.audit("call.asked", actor, detail);
      const app = decision.app;
      const grantKey = decision.grantKey;
      const store = service.config.approval === "per-app";
      return {
        decision: "ask",
        summary: decision.summary,
        resolve: (signal) => service.requestGrant(app, grantKey, { tool: bare.name, label: call.ctx.label }, store, signal),
      };
    },
  };
}
