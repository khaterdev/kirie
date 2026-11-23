/**
 * What the sandbox contributor and the path guard need to know, and the
 * record of what each SDK query was actually given at spawn time.
 */

import type { SdkCallContext, SdkCallKind } from "../engine/sdk-options.js";
import type { SandboxPathEnv } from "./paths.js";
import type { SandboxConfig, SandboxMode } from "./types.js";

/** The docker shell tool as the model and the hook see it (EXPERIMENTS E5). */
export const SANDBOX_BASH_TOOL = "mcp__kirie-tools__sandbox_bash";

/**
 * Built-in tools that run shell commands on the host. In docker mode they are
 * all disallowed and denied by name; `Monitor` and `PowerShell` are denied in
 * native mode too, because the SDK sandbox is only documented for Bash.
 */
export const SANDBOX_HOST_SHELL_TOOLS: readonly string[] = ["Bash", "Monitor", "PowerShell"];

/** Calls that carry no tools (judge, triage, oneshot) or are opened by daemon code itself (utility). */
export const SANDBOX_EXEMPT_KINDS: ReadonlySet<SdkCallKind> = new Set<SdkCallKind>(["judge", "triage", "oneshot", "utility"]);

/** Env keys the contributor sets on the kirie-tools server of one spawn. */
export const SANDBOX_TOOL_ENV = {
  mode: "KIRIE_SANDBOX_MODE",
  container: "KIRIE_SANDBOX_CONTAINER",
  workdir: "KIRIE_SANDBOX_WORKDIR",
  binary: "KIRIE_DOCKER_BIN",
  timeout: "KIRIE_SANDBOX_TIMEOUT",
  network: "KIRIE_SANDBOX_NETWORK",
} as const;

export interface SandboxDockerReadiness {
  /** The shared container is up and passed its checks. */
  healthy: boolean;
  binary?: string;
  container: string;
  reason?: string;
}

/** Live state, read at every spawn and every gate call. */
export interface SandboxPolicySource {
  /** Effective mode now (config plus the `sandbox.mode` override). */
  mode(): SandboxMode;
  config(): SandboxConfig;
  /** Owner write list for native mode, `~` expanded (config entries plus runtime additions). */
  allowWrite(): readonly string[];
  pathEnv(): SandboxPathEnv;
  /** Absolute docker workspace directory. */
  workspaceDir(): string;
  /** Directories host file tools may read in docker mode besides the workspace. */
  dockerReadPaths(): readonly string[];
  docker(): SandboxDockerReadiness;
  /** Bumped on every change that alters spawn options (mode, write list, container). */
  generation(): number;
}

export interface SandboxSpawnInfo {
  mode: SandboxMode;
  generation: number;
  /** Docker mode: was the container healthy (so the alias was set). */
  dockerHealthy?: boolean;
  cwd: string;
}

/**
 * Spawn-time records, keyed by the exact context object the pipeline hands to
 * the gate for that query's calls, plus the latest spawn per chat session so
 * stale sessions can be restarted after a switch.
 */
export class SandboxSpawnRegistry {
  private readonly byCtx = new WeakMap<SdkCallContext, SandboxSpawnInfo>();
  private readonly chats = new Map<string, number>();
  private static readonly MAX_CHATS = 500;

  record(ctx: SdkCallContext, info: SandboxSpawnInfo): void {
    this.byCtx.set(ctx, info);
    if (ctx.kind === "chat" && ctx.sessionKey) {
      this.chats.delete(ctx.sessionKey);
      this.chats.set(ctx.sessionKey, info.generation);
      if (this.chats.size > SandboxSpawnRegistry.MAX_CHATS) {
        const oldest = this.chats.keys().next().value;
        if (oldest !== undefined) this.chats.delete(oldest);
      }
    }
  }

  get(ctx: SdkCallContext): SandboxSpawnInfo | undefined {
    return this.byCtx.get(ctx);
  }

  /** Chat sessions spawned with an older generation. */
  staleChats(current: number): string[] {
    return [...this.chats].filter(([, gen]) => gen !== current).map(([key]) => key);
  }

  forgetChat(sessionKey: string): void {
    this.chats.delete(sessionKey);
  }
}
