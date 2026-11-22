import { z } from "zod/v3";

const PluginsObjectSchema = z.object({
  /** Master switch. Nothing is loaded when false. */
  enabled: z.boolean().default(false),
  /** The only directory plugins may load from. */
  dir: z.string().default("~/.kirie/plugins"),
  /** Optional static outer bound. Empty means "whatever the owner approved". */
  allow: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/)).default([]),
  /** Per-plugin settings passed to the factory. */
  config: z.record(z.record(z.unknown())).default({}),
  hookTimeoutMs: z.number().int().min(100).max(30_000).default(2000),
  loadTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  maxConsecutiveFailures: z.number().int().min(1).max(100).default(5),
  maxQueuedEventsPerPlugin: z.number().int().min(1).max(10_000).default(100),
  scrubEventPayloads: z.boolean().default(true),
  /** Refuse to load a plugin whose files differ from the approved hash. */
  requireHashPin: z.boolean().default(true),
});

/** True when the raw `plugins` value is the legacy array form `[{ package, enabled, config }]`. */
export function isLegacyPluginsConfig(raw: unknown): boolean {
  return Array.isArray(raw);
}

/**
 * `plugins` (PLAN B.11, R3 item 15). Old configs used an array of
 * `{ package, enabled, config }`; that form is accepted and neutralised to
 * `{ enabled: false }`. Runtime override: `plugins.enabled`.
 */
export const PluginsConfigSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { enabled: false } : v),
  PluginsObjectSchema.default({}),
);

export type PluginsConfig = z.infer<typeof PluginsObjectSchema>;
