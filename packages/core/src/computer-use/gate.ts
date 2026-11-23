/**
 * The `computer-use` tool gate (order 300, PLAN B.1 and C.13).
 *
 * Driver tools: resolve the target pid, then map the pure policy decision to
 * a gate verdict. An ask is answered by the owner through
 * `OwnerPrompts.requestApproval({ kind: "computer" })`, independent of the
 * global approval mode.
 *
 * Shell tools (Bash, Monitor, PowerShell): a tripwire, not a boundary, and
 * only while `computerUse.enabled` is true. With unrestricted Bash the agent
 * could drive the driver from the shell once CuaDriver.app has its macOS
 * grants; the tripwire denies commands that run the driver or open its app
 * (see docs/computer-use-setup.md). A command that only mentions it (grep, a
 * commit message, ls of the app) passes (CONF-B1).
 */

import type { ToolGate, ToolGateCall, ToolGateVerdict } from "../engine/sdk-options.js";
import { matchApprovalGlob } from "../approvals/glob.js";
import { parseShell, type ShellSegment } from "../approvals/shell-parse.js";
import { computerUseInputPids, computerUseTypedChars, decideComputerUse, type ComputerUseAppInfo } from "./policy.js";
import type { ComputerUseService } from "./service.js";
import { computerUseBareToolName, COMPUTER_USE_SERVER_NAME } from "./tools.js";

export const COMPUTER_USE_GATE_NAME = "computer-use";
export const COMPUTER_USE_GATE_ORDER = 300;
export const COMPUTER_USE_GATE_MATCHER = /^(Bash|Monitor|PowerShell|mcp__(cua-driver|cua-computer-use)__.+)$/;

/** Built-in tools whose `command` runs in a shell. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "Monitor", "PowerShell"]);

/** Driver subcommands that are never allowed from a shell, armed or not. */
const ALWAYS_DENIED = /\b(permissions\s+grant|connect|update|upgrade|serve|install|uninstall|config\s+set|telemetry\s+enable)\b/i;
/** Read-only driver subcommands allowed from a shell while armed. */
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["--version", "-v", "version", "status", "doctor", "list-tools", "help", "--help", "-h", "stop"]);

const DRIVER_CLI = "cua-driver";
/** The app bundle's own executables (`.../CuaDriver.app/Contents/MacOS/CuaDriver`). */
const DRIVER_APP_BINARY = /CuaDriver\.app\/Contents\/(MacOS|Resources)\//i;
/** An app name, path or bundle id that opens the driver app. */
const DRIVER_APP_REF = /(^|\/)CuaDriver(\.app)?\/?$|^com\.trycua\.driver$/i;
/** Package runners that execute their first argument (`npx cua-driver`). */
const RUNNERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx", "uvx"]);
const RUNNER_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = { pnpm: ["dlx"], yarn: ["dlx"], npm: ["exec", "x"], pipx: ["run"], uv: ["tool"] };

type DriverInvocation =
  | { kind: "cli"; args: string[] }
  | { kind: "app-binary" }
  | { kind: "app" }
  | { kind: "computed"; name: string };

function isDriverName(word: string | undefined): boolean {
  if (!word) return false;
  const base = (word.split("/").pop() ?? "").toLowerCase();
  return base === DRIVER_CLI || base.startsWith(`${DRIVER_CLI}@`);
}

/** A computed command name (`"$c-driver"`, `cua-$d`, `~/.local/bin/cua-*`) that could be the driver. */
function maybeDriverName(cmd: string): boolean {
  const base = cmd.split("/").pop() ?? cmd;
  if (/[*?[]/.test(base) && !base.includes("$")) return matchApprovalGlob(base, DRIVER_CLI) || matchApprovalGlob(base, "cuadriver");
  const literal = base.replace(/\$\{[^}]*\}|\$\([^)]*\)|\$[A-Za-z_][A-Za-z0-9_]*|`[^`]*`/g, "");
  return literal !== base && (literal.includes("cua") || literal.includes("driver"));
}

/** How one parsed simple command runs the driver, or null when it does not. */
function driverInvocation(seg: ShellSegment): DriverInvocation | null {
  const argv = seg.argv;
  const head = argv[0] ?? "";
  if (DRIVER_APP_BINARY.test(head) || seg.cmd === "cuadriver") return { kind: "app-binary" };
  if (isDriverName(head) && seg.cmd !== "") return { kind: "cli", args: argv.slice(1) };
  if (seg.args[0] && (seg.args[0].expansion || seg.args[0].glob) && maybeDriverName(seg.cmd)) return { kind: "computed", name: head };
  const runner = RUNNERS.has(seg.cmd) ? 1 : (RUNNER_SUBCOMMANDS[seg.cmd] ?? []).includes(argv[1] ?? "") ? 2 : -1;
  if (runner !== -1) {
    let i = runner;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
    if (isDriverName(argv[i])) return { kind: "cli", args: argv.slice(i + 1) };
    return null;
  }
  if (seg.cmd === "open") {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      if ((a === "-a" || a === "-b") && DRIVER_APP_REF.test(argv[i + 1] ?? "")) return { kind: "app" };
      if (!a.startsWith("-") && DRIVER_APP_REF.test(a)) return { kind: "app" };
    }
    return null;
  }
  if (seg.cmd === "osascript" && argv.slice(1).some((a) => /CuaDriver|com\.trycua\.driver/i.test(a))) return { kind: "app" };
  return null;
}

/**
 * Decide a shell command for the tripwire. Returns a deny reason, or null to pass.
 * Only while computer use is enabled; disabled, it denies nothing (CONF-B1).
 * It looks at what the command runs (each parsed simple command, wrappers and
 * nested `bash -c`, `xargs` and the like included), never at mentions:
 * - always: cua-driver permissions grant, connect, update, serve, install, config set, telemetry enable
 * - armed or not: running an executable inside CuaDriver.app
 * - not armed: running cua-driver (directly, through a package runner, or under a computed name) or opening its app
 * - armed: only read-only subcommands (status, permissions status, doctor, list-tools, --version, help, stop)
 */
export function checkComputerUseBash(rawCommand: string, armed: boolean, enabled = true): string | null {
  if (!enabled || typeof rawCommand !== "string" || rawCommand.length === 0) return null;
  const invocations: DriverInvocation[] = [];
  for (const seg of parseShell(rawCommand).segments) {
    const inv = driverInvocation(seg);
    if (inv) invocations.push(inv);
  }
  if (invocations.length === 0) return null;

  for (const inv of invocations) {
    if (inv.kind === "cli" && ALWAYS_DENIED.test(inv.args.join(" "))) {
      return "Kirie never grants permissions to, connects, updates, serves or reconfigures cua-driver. The owner does that from Terminal (docs/computer-use-setup.md).";
    }
  }
  if (invocations.some((inv) => inv.kind === "app-binary")) {
    return "Do not run CuaDriver.app's executables from the shell; desktop control goes through the cua-driver MCP tools while armed.";
  }
  if (!armed) {
    return "Desktop control is off. Do not drive cua-driver from the shell; the owner can arm computer use with /computer on.";
  }
  for (const inv of invocations) {
    if (inv.kind === "computed") return "Use the cua-driver MCP tools for desktop control, not the shell: only read-only cua-driver commands may run from a shell, by their plain name.";
    if (inv.kind !== "cli") continue;
    const words = inv.args.filter((w) => !/^--?(json|quiet|q|verbose)$/i.test(w));
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
      if (SHELL_TOOLS.has(call.tool)) {
        const reason = checkComputerUseBash(bashCommand(call.input), service.arming.isArmed(), service.isEnabled());
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
