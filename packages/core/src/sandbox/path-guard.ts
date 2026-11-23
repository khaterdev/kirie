/**
 * Gate `sandbox-path-guard` (order 200, PLAN B.1 and C.10). Deny only.
 *
 * The SDK's sandbox covers Bash and nothing else, and in docker mode Bash is
 * gone, so this gate holds the host-side tools to the same rules:
 *
 * - native: Write/Edit/MultiEdit/NotebookEdit only inside the cwd, the base
 *   scratch dirs and the owner's write list, never on a protected path; Read,
 *   Grep, Glob, LS, NotebookRead never on a protected-read path; no
 *   `dangerouslyDisableSandbox` (unless the owner allowed it); no Monitor or
 *   PowerShell (not covered by the SDK sandbox).
 * - docker: any built-in host shell tool, literal `Bash` included, is denied
 *   (the backstop for the alias, EXPERIMENTS E5); `sandbox_bash` only while the
 *   container is healthy; file writes only inside the workspace; file reads
 *   only inside the workspace, Kirie's media folder and `sandbox.docker.readPaths`.
 *
 * Paths with a `..` component are refused outright (a tool may normalise
 * `..` before opening while the kernel applies it after symlinks). Other
 * paths are resolved component by component with symlinks followed, so a link
 * out of an allowed folder is caught; in docker mode no symlink inside the
 * workspace is followed at all, because the container can plant or swap one.
 * Adding an MCP server is denied in both modes (its command runs on the host).
 * A query keeps the options it was spawned with; this gate applies the
 * stricter of its spawn mode and the live mode to file tools, and denies host
 * shells whenever either is docker.
 */

import type { ToolGate, ToolGateCall, ToolGateVerdict } from "../engine/sdk-options.js";
import { approvalPathMatches, compileApprovalPathList, type ApprovalPathList } from "../approvals/paths.js";
import type { AuditTrail } from "../security/audit-trail.js";
import {
  SANDBOX_PROTECTED_READ_PATHS,
  SANDBOX_PROTECTED_WRITE_PATHS,
  resolveSandboxPath,
  sandboxPathHasControlChars,
  sandboxPathHasDotDot,
  sandboxPathWithinRoots,
  sandboxRootForms,
  sandboxSymlinkBelow,
} from "./paths.js";
import { sandboxNativeWriteRoots } from "./native.js";
import {
  SANDBOX_BASH_TOOL,
  SANDBOX_EXEMPT_KINDS,
  SANDBOX_HOST_SHELL_TOOLS,
  type SandboxPolicySource,
  type SandboxSpawnRegistry,
} from "./policy.js";
import type { SandboxMode } from "./types.js";

export const SANDBOX_PATH_GUARD_NAME = "sandbox-path-guard";
export const SANDBOX_PATH_GUARD_ORDER = 200;

const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const READ_TOOLS: Readonly<Record<string, string>> = {
  Read: "file_path",
  NotebookRead: "notebook_path",
  Grep: "path",
  Glob: "path",
  LS: "path",
};

/** Adds an MCP server: the server's command then runs on this Mac, outside any sandbox. */
export const SANDBOX_MCP_ADD_TOOL = "mcp__kirie-tools__mcp_servers_add";

const GUARDED = new Set([...SANDBOX_HOST_SHELL_TOOLS, SANDBOX_BASH_TOOL, SANDBOX_MCP_ADD_TOOL, ...Object.keys(WRITE_TOOLS), ...Object.keys(READ_TOOLS)]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const SANDBOX_PATH_GUARD_MATCHER = new RegExp(`^(${[...GUARDED].map(escapeRe).join("|")})$`);

/** Counters for `/sandbox` status. */
export class SandboxGuardStats {
  denied = 0;
  byRule: Record<string, number> = {};
  note(rule: string): void {
    this.denied++;
    this.byRule[rule] = (this.byRule[rule] ?? 0) + 1;
  }
}

export interface SandboxPathGuardDeps {
  source: SandboxPolicySource;
  spawns: SandboxSpawnRegistry;
  audit?: Pick<AuditTrail, "record">;
  stats?: SandboxGuardStats;
  /** lstat: true for a symlink, false for anything else, null when missing. Injected for tests. */
  isSymlink?: (p: string) => boolean | null;
}

type Denial = { rule: string; reason: string };

const DOCKER_SHELL_REASON =
  `In docker sandbox mode, shell commands run only inside the sandbox container. Use the ${SANDBOX_BASH_TOOL} tool (same input as Bash). Nothing ran on this Mac.`;
const DOCKER_DOWN_REASON =
  "The docker sandbox container is not running, so no shell is available right now. Nothing ran, and nothing will run on this Mac instead. Tell the owner; they can check it with /sandbox.";

/** The path argument of a file tool, or the cwd for search tools called without one. */
function targetPath(call: ToolGateCall, key: string, optional: boolean): string | null {
  const value = call.input[key];
  if (typeof value === "string" && value.trim() !== "") return value;
  return optional ? call.cwd : null;
}

/** Glob with an absolute pattern: the expanded pattern and the literal directory before the first wildcard. */
function globPatternRoot(pattern: unknown, home: string): { pattern: string; root: string } | null {
  if (typeof pattern !== "string") return null;
  const p = pattern.startsWith("~/") ? `${home}${pattern.slice(1)}` : pattern;
  if (!p.startsWith("/")) return null;
  const segs = p.split("/");
  const literal: string[] = [];
  for (const s of segs) {
    if (/[*?[{]/.test(s)) break;
    literal.push(s);
  }
  return { pattern: p, root: literal.join("/") || "/" };
}

export function createSandboxPathGuard(deps: SandboxPathGuardDeps): ToolGate {
  const { source, spawns } = deps;
  let compiledKey = "";
  let protectedWrite: ApprovalPathList | null = null;
  let protectedRead: ApprovalPathList | null = null;

  const lists = (): { write: ApprovalPathList; read: ApprovalPathList } => {
    const env = source.pathEnv();
    const key = `${env.home}|${env.dataDir}`;
    if (!protectedWrite || !protectedRead || key !== compiledKey) {
      const aenv = { home: env.home, dataDir: env.dataDir, ...(env.realpath ? { realpath: env.realpath } : {}) };
      protectedWrite = compileApprovalPathList(SANDBOX_PROTECTED_WRITE_PATHS, aenv);
      protectedRead = compileApprovalPathList(SANDBOX_PROTECTED_READ_PATHS, aenv);
      compiledKey = key;
    }
    return { write: protectedWrite, read: protectedRead };
  };

  const resolveTarget = (raw: string, call: ToolGateCall): ReturnType<typeof resolveSandboxPath> | Denial => {
    if (sandboxPathHasControlChars(raw) || raw.length > 4096) return { rule: "path.invalid", reason: "That path contains control characters or is too long." };
    if (sandboxPathHasDotDot(raw)) return { rule: "path.dotdot", reason: "The sandbox does not accept paths with \"..\" in them. Give the full path without \"..\"." };
    return resolveSandboxPath(raw, call.cwd, source.pathEnv());
  };

  /** Docker mode: the container controls the workspace, so a link inside it is never followed by a host tool. */
  const workspaceLink = (resolvedLexical: string): Denial | null => {
    const link = sandboxSymlinkBelow(resolvedLexical, source.workspaceDir(), deps.isSymlink);
    return link ? { rule: "path.symlink", reason: `${link} is a symlink inside the sandbox workspace; host file tools do not follow links there. Use the shell tool inside the container instead.` } : null;
  };

  const checkFileTool = (mode: "native" | "docker", call: ToolGateCall, spawnCwd: string): Denial | null => {
    const writeKey = WRITE_TOOLS[call.tool];
    const readKey = READ_TOOLS[call.tool];
    if (!writeKey && !readKey) return null;
    const { write, read } = lists();
    const env = source.pathEnv();

    const targets: string[] = [];
    const main = targetPath(call, writeKey ?? readKey!, !writeKey && call.tool !== "Read" && call.tool !== "NotebookRead");
    if (main === null) return { rule: "path.missing", reason: `The sandbox needs an explicit path for ${call.tool}.` };
    targets.push(main);
    if (call.tool === "Glob") {
      if (typeof call.input.pattern === "string" && sandboxPathHasDotDot(call.input.pattern)) {
        return { rule: "path.dotdot", reason: "The sandbox does not accept patterns with \"..\" in them." };
      }
      const glob = globPatternRoot(call.input.pattern, env.home);
      if (glob) {
        // The pattern itself counts when it could reach a protected file (`~/.ssh/id_*`).
        if (approvalPathMatches({ lexical: glob.pattern, real: glob.pattern }, read)) {
          return { rule: "read.protected", reason: "That pattern reaches protected files (secrets or credentials). The sandbox does not allow reading them." };
        }
        targets.push(glob.root);
      }
    }

    for (const raw of targets) {
      const resolved = resolveTarget(raw, call);
      if ("rule" in resolved) return resolved;
      if (mode === "docker") {
        const link = workspaceLink(resolved.lexical);
        if (link) return link;
      }
      if (writeKey) {
        if (approvalPathMatches(resolved, write)) {
          return { rule: "write.protected", reason: `${resolved.real} is protected (Kirie's config, state, secrets or credentials, or a credential file). The sandbox does not allow writing it.` };
        }
        const roots = mode === "native"
          ? sandboxNativeWriteRoots({ allowWrite: source.allowWrite(), cwd: spawnCwd, pathEnv: env })
          : [sandboxRootForms(source.workspaceDir(), env)];
        if (!sandboxPathWithinRoots(resolved, roots)) {
          return mode === "native"
            ? { rule: "write.outside", reason: `${resolved.real} is outside the folders the macOS sandbox lets me write (my workspace and the folders the owner allowed). The owner can allow a folder with /sandbox allow-write <path>.` }
            : { rule: "write.outside", reason: `In docker sandbox mode I can only write inside ${source.workspaceDir()}. ${resolved.real} is outside it.` };
        }
      } else {
        if (approvalPathMatches(resolved, read)) {
          return { rule: "read.protected", reason: `${resolved.real} is a protected file (secrets or credentials). The sandbox does not allow reading it.` };
        }
        if (mode === "docker") {
          const roots = [source.workspaceDir(), ...source.dockerReadPaths()].map((r) => sandboxRootForms(r, env));
          if (!sandboxPathWithinRoots(resolved, roots)) {
            return { rule: "read.outside", reason: `In docker sandbox mode I can only read inside ${source.workspaceDir()} (and Kirie's media folder or folders the owner listed). ${resolved.real} is outside them; pass a path inside the workspace.` };
          }
        }
      }
    }
    return null;
  };

  const checkMode = (mode: "native" | "docker", call: ToolGateCall, spawnMode: SandboxMode | undefined, spawnCwd: string): Denial | null => {
    const tool = call.tool;
    if (SANDBOX_HOST_SHELL_TOOLS.includes(tool)) {
      if (mode === "docker") return { rule: "shell.host", reason: DOCKER_SHELL_REASON };
      if (tool === "Monitor") {
        return { rule: "shell.unsandboxed", reason: "The Monitor tool is not covered by the macOS sandbox. Use Bash for commands while the sandbox is on." };
      }
      if (tool === "PowerShell") return { rule: "shell.unsandboxed", reason: "PowerShell is not covered by the macOS sandbox." };
      if (tool === "Bash" && call.input.dangerouslyDisableSandbox === true && !source.config().native.allowUnsandboxed && spawnMode !== "off") {
        return { rule: "shell.escape", reason: "Commands cannot leave the macOS sandbox here (dangerouslyDisableSandbox is not allowed). Run the command without that flag; if it needs access the sandbox blocks, tell the owner." };
      }
      return null;
    }
    if (tool === SANDBOX_MCP_ADD_TOOL) {
      return { rule: "mcp.add", reason: "While the sandbox is on, I cannot add MCP servers: their commands would run on this Mac outside the sandbox. The owner can add one with the sandbox off." };
    }
    if (tool === SANDBOX_BASH_TOOL) {
      if (mode === "docker" && !source.docker().healthy) return { rule: "container.down", reason: DOCKER_DOWN_REASON };
      return null;
    }
    return checkFileTool(mode, call, spawnCwd);
  };

  const check = (call: ToolGateCall): ToolGateVerdict => {
    if (SANDBOX_EXEMPT_KINDS.has(call.ctx.kind)) return { decision: "pass" };
    const spawn = spawns.get(call.ctx);
    const live = source.mode();
    const modes = new Set<SandboxMode>([live, ...(spawn ? [spawn.mode] : [])]);
    modes.delete("off");
    if (modes.size === 0) return { decision: "pass" };
    // docker first: its rules are the strictest and its reasons the most useful.
    const ordered = [...modes].sort((a, b) => (a === "docker" ? -1 : b === "docker" ? 1 : 0)) as Array<"native" | "docker">;
    for (const mode of ordered) {
      const denial = checkMode(mode, call, spawn?.mode, spawn?.cwd ?? call.ctx.cwd);
      if (denial) {
        deps.stats?.note(denial.rule);
        deps.audit?.record({
          feature: "sandbox",
          action: "gate.denied",
          actor: call.ctx.sessionKey ? `agent:${call.ctx.sessionKey}` : "system",
          detail: { tool: call.tool, rule: denial.rule, mode, label: call.ctx.label, ...(call.agentType ? { agentType: call.agentType } : {}) },
        });
        return { decision: "deny", reason: denial.reason };
      }
    }
    return { decision: "pass" };
  };

  return {
    name: SANDBOX_PATH_GUARD_NAME,
    order: SANDBOX_PATH_GUARD_ORDER,
    matcher: SANDBOX_PATH_GUARD_MATCHER,
    check,
  };
}
