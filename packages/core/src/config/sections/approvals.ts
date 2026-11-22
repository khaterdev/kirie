import { z } from "zod/v3";

/**
 * `approvals` (PLAN B.11, R2 section 4; DECISIONS 1, 2). `yolo` is today's
 * behaviour; the hardline blocklist is on by default and `hardline: false`
 * restores exactly the current behaviour. Runtime overrides: `approvals.mode`,
 * `approvals.askScope`, `approvals.hardline`, `approvals.allow`, `approvals.deny`.
 */
export const ApprovalsConfigSchema = z.object({
  /** Master switch for the gate machinery. */
  enabled: z.boolean().default(true),
  /** yolo = today's behaviour, nothing is asked. ask = risky actions need an owner tap. */
  mode: z.enum(["yolo", "ask"]).default("yolo"),
  /** In ask mode: only dangerous and unparseable actions ask, or everything not allowlisted. */
  askScope: z.enum(["dangerous", "all"]).default("dangerous"),
  /** Always-deny list for catastrophic commands. Applies in every mode. */
  hardline: z.boolean().default(true),
  allow: z.array(z.string().max(200)).max(200).default([]),
  deny: z.array(z.string().max(200)).max(200).default([]),
  timeoutSeconds: z.number().int().min(15).max(3600).default(300),
  /** Background tasks, goals and payload schedules: ask the owner, or deny outright. */
  unattended: z.enum(["ask", "deny"]).default("ask"),
  inlineCode: z.enum(["ask", "heuristic", "allow"]).default("ask"),
  maxPending: z.number().int().min(1).max(20).default(5),
  redenyWindowSeconds: z.number().int().min(0).max(86_400).default(600),
  maxDenialsPerTurn: z.number().int().min(1).max(20).default(3),
  /** Extra tool-name globs that ask in ask mode. */
  mcpAsk: z.array(z.string().max(200)).default([]),
  /** Extra protected paths, added to the built-in lists. */
  protectedWritePaths: z.array(z.string()).default([]),
  protectedReadPaths: z.array(z.string()).default([]),
  /** Built-in dangerous rule ids to switch off, e.g. ["git.destroy"]. */
  disabledRules: z.array(z.string()).default([]),
}).default({});

export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;
