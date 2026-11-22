import { z } from "zod/v3";

/**
 * `ingress` (PLAN B.9, B.11): the public listener shared by webhooks and voice.
 * It always binds 127.0.0.1 (there is deliberately no bind key) and is reached
 * through a tunnel. It is only bound while a feature has mounted something.
 */
export const IngressConfigSchema = z.object({
  /** Loopback port of the public listener. */
  port: z.number().int().min(1).max(65535).default(18787),
  /** Public https origin the tunnel serves, e.g. https://hooks.example.com. No trailing slash needed. */
  publicBaseUrl: z.string().url().optional(),
  /** Header carrying the real client IP behind the tunnel. Empty string disables. */
  trustedIpHeader: z.string().default("cf-connecting-ip"),
}).default({});

export type IngressConfig = z.infer<typeof IngressConfigSchema>;
