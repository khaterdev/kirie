import { z } from "zod/v3";

/**
 * `sandbox` (PLAN B.11, R2 section 5). Replaces the old schema. Old keys
 * (`workspaceAccess`, `prune`) are stripped, so old configs still load;
 * `docker.network: "host"` is no longer valid. Runtime overrides:
 * `sandbox.mode`, `sandbox.native.allowWrite`.
 */
export const SandboxConfigSchema = z.object({
  /** off = host execution (today). native = SDK OS sandbox. docker = shell inside a container. */
  mode: z.enum(["off", "native", "docker"]).default("off"),
  /** Only "shared" is implemented. Other values are accepted and treated as shared. */
  scope: z.enum(["shared", "agent", "session"]).default("shared"),
  native: z.object({
    allowWrite: z.array(z.string()).default([]),
    /** Empty = network unrestricted. */
    allowedDomains: z.array(z.string()).default([]),
    allowUnixSockets: z.array(z.string()).default([]),
    excludedCommands: z.array(z.string()).default([]),
    allowUnsandboxed: z.boolean().default(false),
  }).default({}),
  docker: z.object({
    binary: z.string().optional(),
    image: z.string().default("kirie-sandbox:latest"),
    workspaceDir: z.string().default("~/.kirie/sandbox-workspace"),
    readPaths: z.array(z.string()).default([]),
    /** The container is always read-only with every capability dropped; false here is ignored (docs/sandbox.md). */
    readOnlyRoot: z.boolean().default(true),
    network: z.enum(["none", "bridge"]).default("none"),
    capDrop: z.array(z.string()).default(["ALL"]),
    memory: z.string().default("1g"),
    cpus: z.number().min(0.25).max(16).default(2),
    pidsLimit: z.number().int().min(16).max(4096).default(256),
    tmpfsSizeMb: z.number().int().min(16).max(4096).default(256),
    execTimeoutSeconds: z.number().int().min(5).max(600).default(120),
    stopOnShutdown: z.boolean().default(true),
  }).default({}),
}).default({});

/** Parsed `sandbox`. Named so it does not collide with `SandboxConfig` in sandbox/types.ts. */
export type SandboxSchemaConfig = z.infer<typeof SandboxConfigSchema>;
