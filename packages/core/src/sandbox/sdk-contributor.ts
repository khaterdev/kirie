/**
 * Contributor `sandbox` (order 50, PLAN B.1 and C.10). Runs once per query()
 * spawn and reads the live mode.
 *
 * - off: options untouched.
 * - native: `options.sandbox` (SDK Seatbelt sandbox for Bash).
 * - docker: the built-in host shells go to `disallowedTools`. When the
 *   container is healthy, `toolAliases.Bash` points at `sandbox_bash` and the
 *   tool joins this spawn's allow list. When it is not: fail closed, no alias,
 *   no host shell (the gate also denies). This spawn's kirie-tools server gets
 *   the container, workdir and binary in its env, so `sandbox_bash` exists.
 *
 * Shared objects (the engines' `mcpServers` map, the `allowedTools` array) are
 * never mutated: the contributor replaces them on this spawn's options with
 * copies.
 */

import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SdkCallContext, SdkOptionsContributor } from "../engine/sdk-options.js";
import { buildSandboxNativeSettings } from "./native.js";
import {
  SANDBOX_BASH_TOOL,
  SANDBOX_EXEMPT_KINDS,
  SANDBOX_HOST_SHELL_TOOLS,
  SANDBOX_TOOL_ENV,
  type SandboxPolicySource,
  type SandboxSpawnRegistry,
} from "./policy.js";

export const SANDBOX_CONTRIBUTOR_NAME = "sandbox";
export const SANDBOX_CONTRIBUTOR_ORDER = 50;

/** The kirie-tools server name in `options.mcpServers`. */
const KIRIE_TOOLS_SERVER = "kirie-tools";

/** Replace this spawn's kirie-tools server entry with a copy whose env has `extra`. */
function withKirieToolsEnv(options: Options, extra: Record<string, string>): void {
  const servers = options.mcpServers;
  const server = servers?.[KIRIE_TOOLS_SERVER] as (McpServerConfig & { env?: Record<string, string> }) | undefined;
  if (!servers || !server || !("command" in server)) return;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(server.env ?? {})) {
    if (!Object.values(SANDBOX_TOOL_ENV).includes(k as (typeof SANDBOX_TOOL_ENV)[keyof typeof SANDBOX_TOOL_ENV])) env[k] = v;
  }
  options.mcpServers = { ...servers, [KIRIE_TOOLS_SERVER]: { ...server, env: { ...env, ...extra } } as McpServerConfig };
}

export function createSandboxContributor(deps: { source: SandboxPolicySource; spawns: SandboxSpawnRegistry }): SdkOptionsContributor {
  const { source, spawns } = deps;
  return (options: Options, ctx: SdkCallContext): void => {
    if (SANDBOX_EXEMPT_KINDS.has(ctx.kind)) return;
    const mode = source.mode();
    const generation = source.generation();
    const cwd = options.cwd ?? ctx.cwd;

    if (mode === "off") {
      spawns.record(ctx, { mode, generation, cwd });
      return;
    }

    if (mode === "native") {
      options.sandbox = buildSandboxNativeSettings({
        native: source.config().native,
        allowWrite: source.allowWrite(),
        cwd,
        pathEnv: source.pathEnv(),
      });
      withKirieToolsEnv(options, { [SANDBOX_TOOL_ENV.mode]: "native" });
      spawns.record(ctx, { mode, generation, cwd });
      return;
    }

    const docker = source.docker();
    const disallowed = options.disallowedTools ?? [];
    options.disallowedTools = [...disallowed, ...SANDBOX_HOST_SHELL_TOOLS.filter((t) => !disallowed.includes(t))];
    if (docker.healthy) {
      options.toolAliases = { ...(options.toolAliases ?? {}), Bash: SANDBOX_BASH_TOOL };
      if (options.allowedTools && !options.allowedTools.includes(SANDBOX_BASH_TOOL)) {
        options.allowedTools = [...options.allowedTools, SANDBOX_BASH_TOOL];
      }
    } else if (options.toolAliases?.Bash) {
      const { Bash: _removed, ...rest } = options.toolAliases;
      options.toolAliases = rest;
    }
    const cfg = source.config().docker;
    withKirieToolsEnv(options, {
      [SANDBOX_TOOL_ENV.mode]: "docker",
      [SANDBOX_TOOL_ENV.container]: docker.container,
      [SANDBOX_TOOL_ENV.workdir]: source.workspaceDir(),
      [SANDBOX_TOOL_ENV.timeout]: String(cfg.execTimeoutSeconds),
      [SANDBOX_TOOL_ENV.network]: cfg.network,
      ...(docker.binary ? { [SANDBOX_TOOL_ENV.binary]: docker.binary } : {}),
    });
    spawns.record(ctx, { mode, generation, cwd, dockerHealthy: docker.healthy });
  };
}
