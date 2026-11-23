import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import {
  runSandboxBash,
  sandboxBashTargetFromEnv,
  sandboxBashTimeoutSeconds,
  type SandboxSpawnFn,
} from "../../sandbox/bash-runner.js";
import { SANDBOX_EXEC_DEFAULT_SECONDS } from "../../sandbox/docker.js";
import { SANDBOX_TOOL_ENV } from "../../sandbox/policy.js";

/**
 * Sandbox tools (PLAN B.13, W3-SBX).
 *
 * - `sandbox_status`: read-only. Proxies to the daemon's GET-only
 *   `/api/sandbox/status` route and adds what this session was started with.
 * - `sandbox_bash`: registered only when this session's kirie-tools server was
 *   started in docker mode (`KIRIE_SANDBOX_MODE=docker`, set per spawn by the
 *   `sandbox` contributor). Same input as the built-in Bash tool so an aliased
 *   `Bash` call validates. Runs the command in the container through
 *   `docker exec`; a missing container is an error, never a host run.
 *
 * There is deliberately no tool that changes the mode, the write list or the
 * container. The factory is pure: no file, process or network access when called.
 */
export function createSandboxToolsWith(opts: { spawn?: SandboxSpawnFn; fetch?: typeof fetch } = {}): FeatureToolFactory {
  return (ctx) => {
    const sessionMode = ctx.env[SANDBOX_TOOL_ENV.mode] ?? "off";
    const tools: Record<string, McpToolDefinition> = {
      sandbox_status: {
        description:
          "Show where shell commands run (sandbox mode off, native or docker), whether the docker container is up, which folders are writable, the network policy, and what is never sandboxed. " +
          "Read-only. Use it to explain a sandbox denial and to suggest the owner's /sandbox command.",
        parameters: { type: "object", properties: {}, required: [] },
        async handler() {
          const session = { modeAtSessionStart: sessionMode };
          if (!ctx.gatewayUrl) return { session, error: "sandbox status is unavailable (no gateway)" };
          try {
            const res = await (opts.fetch ?? fetch)(`${ctx.gatewayUrl}/api/sandbox/status`, { method: "GET" });
            if (!res.ok) return { session, error: `sandbox status is unavailable (HTTP ${res.status})` };
            const body = (await res.json()) as Record<string, unknown>;
            return { ...body, session };
          } catch {
            return { session, error: "sandbox status is unavailable" };
          }
        },
      },
    };

    if (sessionMode !== "docker") return tools;

    const defaultSeconds = Number(ctx.env[SANDBOX_TOOL_ENV.timeout] ?? SANDBOX_EXEC_DEFAULT_SECONDS);
    tools.sandbox_bash = {
      description:
        "Run a shell command inside Kirie's isolated sandbox container (docker sandbox mode). Use this instead of Bash. " +
        "The container sees only the sandbox workspace (mounted at the same path), runs as a normal user with a read-only system and no network unless the owner enabled it. " +
        "Default timeout 120 s, maximum 600 s. Background runs are not supported.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to execute (bash, inside the container)" },
          timeout: { type: "number", description: "Optional timeout in milliseconds (max 600000)" },
          description: { type: "string", description: "Short description of what the command does" },
          run_in_background: { type: "boolean", description: "Not supported in the sandbox; must be false or omitted" },
        },
        required: ["command"],
      },
      async handler(params) {
        const command = params.command;
        if (typeof command !== "string" || command.trim() === "") throw new Error("command is required");
        if (params.run_in_background === true) {
          throw new Error("run_in_background is not supported in the sandbox. Run the command in the foreground (up to 600 s).");
        }
        if (params.dangerouslyDisableSandbox === true) {
          throw new Error("The sandbox cannot be disabled from a tool call. Nothing ran.");
        }
        const target = sandboxBashTargetFromEnv(ctx.env);
        if ("error" in target) throw new Error(`The sandbox shell is unavailable: ${target.error}. Nothing ran on this Mac.`);
        const seconds = sandboxBashTimeoutSeconds(params.timeout, defaultSeconds);
        try {
          const r = await runSandboxBash(target, command, seconds, opts.spawn ? { spawn: opts.spawn } : {});
          return {
            exitCode: r.exitCode,
            output: r.output,
            ...(r.truncated ? { truncated: true } : {}),
            ...(r.timedOut ? { timedOut: true, note: `stopped after ${seconds} s` } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${message}. Nothing ran on this Mac; the owner can check with /sandbox.`);
        }
      },
    };
    return tools;
  };
}

const defaultSandboxTools = createSandboxToolsWith();

export const createSandboxTools: FeatureToolFactory = (ctx) => defaultSandboxTools(ctx);
