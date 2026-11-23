import { z } from "zod/v3";
import { validateScrubPattern } from "../../security/secret-patterns.js";

/**
 * `security.scrubbing` (PLAN B.8, B.11, R3 item 12). Read once at process start:
 * a hot reload or a runtime setting cannot change it, and there is no command to
 * turn it off. The output type is structurally assignable to the scrubber's
 * `ScrubbingConfig` input interface (security/secret-scrubber.ts).
 *
 * Custom and allow patterns must follow the bounded grammar of
 * `validateScrubPattern`: every quantifier bounded ({n} or {n,m}, m <= 256),
 * no `*`, `+` or `{n,}`, no quantified groups, at most one variable-length
 * quantifier, no backreferences; custom secret patterns start with two or more
 * literal characters. An invalid pattern fails config validation.
 */
export const ScrubbingConfigSchema = z.object({
  /** On by default. */
  enabled: z.boolean().default(true),
  sinks: z.object({
    channels: z.boolean().default(true),
    logs: z.boolean().default(true),
    memory: z.boolean().default(true),
    chatHistory: z.boolean().default(true),
    taskResults: z.boolean().default(true),
    heartbeatLogs: z.boolean().default(true),
    http: z.boolean().default(true),
    webhookPayloads: z.boolean().default(true),
    pluginEvents: z.boolean().default(true),
    /** Rewrites tool output before the model sees it. Breaks flows that read a key to use it. */
    toolOutputToModel: z.boolean().default(false),
  }).default({}),
  knownSecrets: z.object({
    credentialStore: z.boolean().default(true),
    config: z.boolean().default(true),
    env: z.boolean().default(true),
    secretsDir: z.boolean().default(true),
    minLength: z.number().int().min(6).max(64).default(12),
  }).default({}),
  disabledRules: z.array(z.string()).default([]),
  customPatterns: z.array(z.object({
    name: z.string().regex(/^[a-z0-9-]{1,40}$/),
    pattern: z.string(),
    flags: z.string().regex(/^[imsu]*$/).default(""),
  }).superRefine((entry, ctx) => {
    const error = validateScrubPattern(entry.pattern, entry.flags, { requirePrefix: true });
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["pattern"], message: error });
  })).default([]),
  allowPatterns: z.array(z.string().superRefine((pattern, ctx) => {
    const error = validateScrubPattern(pattern);
    if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  })).default([]),
  mask: z.enum(["label", "partial"]).default("label"),
}).default({});

/** Parsed `security.scrubbing`. Named so it does not collide with the scrubber's `ScrubbingConfig`. */
export type ScrubbingSchemaConfig = z.infer<typeof ScrubbingConfigSchema>;

/**
 * The scrubber configuration the daemon passes to `configureScrubber`. The
 * deprecated `logging.redactSensitive: "off"` maps to `sinks.logs = false`;
 * any other value changes nothing.
 */
export function resolveScrubbingConfig(config: {
  security: { scrubbing: ScrubbingSchemaConfig };
  logging?: { redactSensitive?: string };
}): ScrubbingSchemaConfig {
  const base = config.security.scrubbing;
  if (config.logging?.redactSensitive !== "off") return base;
  return { ...base, sinks: { ...base.sinks, logs: false } };
}
