import { z } from "zod/v3";

/**
 * `accounts` (PLAN B.11, R1 item 1): Claude account rotation. The account list
 * itself is state in `~/.kirie/accounts.db`, not config.
 * Runtime override: `accounts.rotation.enabled`.
 */
export const AccountsConfigSchema = z.object({
  rotation: z.object({
    /** Rotate to the next enabled account when the active one hits a limit or auth error. */
    enabled: z.boolean().default(false),
    /** Go back to the lowest-priority-number account as soon as it recovers. */
    returnToPrimary: z.boolean().default(false),
    /** Most account switches attempted within one turn. */
    maxRotationsPerTurn: z.number().int().min(1).max(10).default(3),
    /** Cooldown when the limit message carries no parseable reset time. */
    defaultCooldownMinutes: z.number().int().min(1).default(60),
    /** Tell the owner on Telegram when a rotation happens. */
    notify: z.boolean().default(true),
    /** Resume the same SDK session on the next account (experiment E2 passed). */
    carrySession: z.boolean().default(true),
  }).default({}),
  /** Directories under which a config dir may be imported. Empty means the home directory. */
  importRoots: z.array(z.string()).default([]),
  /** Run a no-cost login check (accountInfo) when importing. */
  verifyOnImport: z.boolean().default(true),
  /** What the main agent may do through MCP tools. */
  agentTools: z.enum(["off", "read", "manage"]).default("manage"),
}).default({});

export type AccountsConfig = z.infer<typeof AccountsConfigSchema>;
