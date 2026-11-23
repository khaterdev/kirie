import { z } from "zod/v3";

/**
 * `agent.fallback` (PLAN B.11, R1 item 2): retry a failed turn on another model.
 * Runtime overrides: `agent.fallback.enabled`, `agent.fallback.models`.
 */
export const FallbackConfigSchema = z.object({
  /** Retry a failed turn on the next model in `models`. */
  enabled: z.boolean().default(false),
  /** Ordered fallback models, e.g. ["claude-sonnet-5-5", "claude-haiku-5-5"]. */
  models: z.array(z.string().regex(/^[A-Za-z0-9._\-[\]:]{1,64}$/)).max(4).default([]),
  /** Also hand the chain to the SDK's own in-turn fallback (overload handling). */
  sdkNative: z.boolean().default(true),
  /** Failure classes that may advance to the next model. */
  on: z.array(z.enum(["model_unavailable", "overloaded", "usage_limit_model"]))
    .default(["model_unavailable", "overloaded", "usage_limit_model"]),
  /** How long a failed (account, model) pair is skipped when no reset time is known. */
  cooldownMinutes: z.number().int().min(1).default(30),
  /** Upper bound on attempts per turn across accounts and models. */
  maxAttemptsPerTurn: z.number().int().min(1).max(10).default(4),
  /** Tell the owner when a fallback model answers. */
  notify: z.boolean().default(true),
}).default({});

export type FallbackConfig = z.infer<typeof FallbackConfigSchema>;
