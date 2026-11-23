import { SandboxConfigSchema, type SandboxSchemaConfig } from "../config/sections/sandbox.js";

/** Where shell commands run (PLAN C.10). `off` = on the host, as before. */
export type SandboxMode = "off" | "native" | "docker";
/** Only `shared` is implemented; `agent` and `session` are treated as shared. */
export type SandboxScope = "shared" | "agent" | "session";

/** The parsed `sandbox` config section. */
export type SandboxConfig = SandboxSchemaConfig;

/** Every default of the `sandbox` section (mode `off`). */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = SandboxConfigSchema.parse({});

/** The one container Kirie runs in docker mode. */
export interface SandboxInstance {
  containerId: string;
  name: string;
  image: string;
  workspaceDir: string;
  fingerprint: string;
  scope: SandboxScope;
  createdAt: string;
  status: "created" | "running" | "stopped";
}

export type SandboxContainerHealth = "running" | "stopped" | "missing" | "unknown";

/** Result of a docker CLI call. `code` is the exit code (non-zero on any failure, never thrown). */
export interface SandboxDockerResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs the docker CLI with these arguments. Injected so tests never touch Docker. */
export type SandboxDockerExec = (args: string[], opts?: { timeoutMs?: number }) => Promise<SandboxDockerResult>;
