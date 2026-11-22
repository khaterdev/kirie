import { z } from "zod/v3";

/**
 * `webhooks` (PLAN B.11, R3 item 6). The listener settings (port, public URL,
 * trusted IP header) live under `ingress`. Hook definitions live in
 * `~/.kirie/webhooks.db`, not in YAML. Runtime override: `webhooks.enabled`.
 */
export const WebhooksConfigSchema = z.object({
  /** Master switch. Nothing is mounted on the ingress listener when false. */
  enabled: z.boolean().default(false),
  maxBodyBytes: z.number().int().min(1024).max(5 * 1024 * 1024).default(512 * 1024),
  timestampToleranceSeconds: z.number().int().min(30).max(900).default(300),
  deliveryRetentionDays: z.number().int().min(1).max(365).default(30),
  rateLimit: z.object({
    perIpPerMinute: z.number().int().positive().default(60),
    globalPerMinute: z.number().int().positive().default(300),
    perHookPerMinute: z.number().int().positive().default(10),
    perHookPerDay: z.number().int().positive().default(100),
  }).default({}),
  maxConcurrentTasks: z.number().int().min(1).max(10).default(2),
  maxQueuedTasks: z.number().int().min(0).max(200).default(20),
  defaultAction: z.enum(["notify", "task"]).default("notify"),
  defaultToolProfile: z.enum(["summarize", "investigate"]).default("summarize"),
  /** Second key required before any hook may use the "full" profile. */
  allowFullProfile: z.boolean().default(false),
  onSuspiciousPayload: z.enum(["downgrade", "drop", "proceed"]).default("downgrade"),
  maxFieldChars: z.number().int().min(50).max(5000).default(500),
  maxPayloadChars: z.number().int().min(500).max(50_000).default(8000),
  secretDelivery: z.enum(["file", "chat"]).default("file"),
  authFailureAlertThreshold: z.number().int().min(1).default(20),
}).default({});

export type WebhooksConfig = z.infer<typeof WebhooksConfigSchema>;
