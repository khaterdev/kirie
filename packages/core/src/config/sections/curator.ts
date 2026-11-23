import { z } from "zod/v3";

/** `curator` (PLAN B.11, R4 item 4): skill cleanup. Runtime override: `curator.enabled`. */
export const CuratorConfigSchema = z.object({
  /** Weekly automatic run. Off by default; /curator on. */
  enabled: z.boolean().default(false),
  intervalHours: z.number().int().min(1).default(168),
  preferredHour: z.number().int().min(0).max(23).default(4),
  minIdleMinutes: z.number().int().min(0).default(30),
  staleAfterDays: z.number().int().min(1).default(30),
  archiveAfterDays: z.number().int().min(1).default(90),
  duplicateThreshold: z.number().min(0).max(1).default(0.9),
  /** Allow archiving unused bundled (repo) skills. */
  pruneBundled: z.boolean().default(false),
  /** Report on ~/.claude/skills (never modified). */
  includeUserSkills: z.boolean().default(false),
  /** Optional LLM pass for merge suggestions and better descriptions. */
  llm: z.boolean().default(false),
  /** Unset = the utility model (proactive.tier2Model). */
  model: z.string().optional(),
  maxProposalsPerRun: z.number().int().min(0).default(8),
}).default({});

export type CuratorConfig = z.infer<typeof CuratorConfigSchema>;
