import { z } from "zod/v3";

/**
 * `loops` (PLAN B.11, R2 section 3): /loop recurring prompts in a chat. Ships off
 * (DECISIONS 17); `/loop on` sets the runtime override `loops.enabled`.
 */
export const LoopsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minIntervalSeconds: z.number().int().min(30).default(60),
  maxIntervalSeconds: z.number().int().max(604_800).default(86_400),
  maxActive: z.number().int().min(1).max(20).default(5),
  defaultMaxRuns: z.number().int().min(1).max(10_000).default(100),
  defaultExpiryHours: z.number().int().min(1).max(720).default(72),
  backoffFactor: z.number().min(1).max(10).default(2),
  /** Backoff never stretches the interval beyond base * this. */
  backoffMaxMultiplier: z.number().min(1).max(64).default(8),
  quietSentinel: z.string().min(3).default("NO_REPLY"),
  agentCreate: z.enum(["ask", "allow", "deny"]).default("ask"),
}).default({});

export type LoopsConfig = z.infer<typeof LoopsConfigSchema>;
