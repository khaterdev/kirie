import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Webhook tools (PLAN B.13, W2-HOOK).
 * Tools: webhook_list, webhook_deliveries.
 *
 * Stub: registers nothing until W2-HOOK fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createWebhooksTools: FeatureToolFactory = () => ({});
