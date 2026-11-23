/**
 * Native mode (PLAN C.10): the SDK's own macOS sandbox (Seatbelt) for Bash.
 * EXPERIMENTS E6: works under launchd; `allowWrite`/`denyWrite` take plain
 * absolute directories; `denyWrite` beats the cwd default; /tmp is not
 * writable outside cwd unless listed.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { join } from "node:path";
import { sandboxDenyReadPaths, sandboxDenyWritePaths, sandboxRootForms, type SandboxPathEnv } from "./paths.js";
import type { SandboxConfig } from "./types.js";

export type SandboxNativeSettings = NonNullable<Options["sandbox"]>;

/** Always writable in native mode besides the cwd: scratch dirs and Kirie's media folder. */
export function sandboxNativeBaseWrite(dataDir: string): string[] {
  return ["/tmp", "/private/tmp", join(dataDir, "media")];
}

export interface SandboxNativeInput {
  native: SandboxConfig["native"];
  /** Owner directories: config `sandbox.native.allowWrite` plus the runtime additions, `~` expanded. */
  allowWrite: readonly string[];
  /** The query's cwd (Seatbelt's implicit write root). */
  cwd: string;
  pathEnv: SandboxPathEnv;
  /** Extra denyWrite entries (the native self-test adds its own protected folder). */
  extraDenyWrite?: readonly string[];
}

/** Every writable root: cwd, the base list and the owner list, each with its resolved form. */
export function sandboxNativeWriteRoots(input: Pick<SandboxNativeInput, "allowWrite" | "cwd" | "pathEnv">): string[][] {
  return [input.cwd, ...sandboxNativeBaseWrite(input.pathEnv.dataDir), ...input.allowWrite].map((r) => sandboxRootForms(r, input.pathEnv));
}

/**
 * `options.sandbox` for native mode. Never silently unsandboxed
 * (`failIfUnavailable`), no model-controlled escape hatch unless the owner set
 * `allowUnsandboxed`, Kirie's own config, state, secrets and credentials (and
 * the rest of the approval gate's protected list) unwritable even though they
 * sit under the cwd, protected credential files unreadable, and the network
 * open unless the owner lists domains.
 */
export function buildSandboxNativeSettings(input: SandboxNativeInput): SandboxNativeSettings {
  const { native } = input;
  const allowWrite = [...new Set([...sandboxNativeBaseWrite(input.pathEnv.dataDir), ...input.allowWrite].flatMap((p) => sandboxRootForms(p, input.pathEnv)))];
  const roots = [...new Set(sandboxNativeWriteRoots(input).flat())];
  const denyWrite = [...new Set([...sandboxDenyWritePaths(input.pathEnv, roots), ...(input.extraDenyWrite ?? [])])];
  const denyRead = sandboxDenyReadPaths(input.pathEnv, roots);

  const settings: SandboxNativeSettings = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: native.allowUnsandboxed,
    autoAllowBashIfSandboxed: true,
    filesystem: { allowWrite, denyWrite, denyRead },
  };
  if (native.excludedCommands.length > 0) settings.excludedCommands = [...native.excludedCommands];
  if (native.allowedDomains.length > 0 || native.allowUnixSockets.length > 0) {
    settings.network = {
      ...(native.allowedDomains.length > 0 ? { allowedDomains: [...native.allowedDomains] } : {}),
      ...(native.allowUnixSockets.length > 0 ? { allowUnixSockets: [...native.allowUnixSockets] } : {}),
    };
  }
  return settings;
}
