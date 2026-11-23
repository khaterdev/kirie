import { z } from "zod/v3";

/**
 * `goals` (PLAN B.11, R2 section 2): /goal judge loop. Ships off (DECISIONS 17);
 * `/goal on` sets the runtime override `goals.enabled`.
 */
export const GoalsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Judge model. Unset = the utility model (proactive.tier2Model). */
  judgeModel: z.string().optional(),
  /** Worker model. Unset = agent.model. */
  workerModel: z.string().optional(),
  maxRounds: z.number().int().min(1).max(100).default(10),
  maxMinutes: z.number().int().min(1).max(1440).default(120),
  /** Estimated USD from the SDK. On a subscription this is a notional budget, still a useful brake. */
  maxCostUsd: z.number().min(0.1).max(1000).default(10),
  maxConcurrent: z.number().int().min(1).max(5).default(1),
  maxChecks: z.number().int().min(0).max(10).default(5),
  checkTimeoutSeconds: z.number().int().min(5).max(3600).default(300),
  progressMinIntervalSeconds: z.number().int().min(10).default(60),
  /** What happens when the agent calls goal_create. */
  agentCreate: z.enum(["ask", "allow", "deny"]).default("ask"),
  resumeOnRestart: z.boolean().default(true),
}).default({});

export type GoalsConfig = z.infer<typeof GoalsConfigSchema>;
