import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Secret scan tools (PLAN B.13, W2-SEC).
 * Tools: secrets_scan.
 *
 * Stub: registers nothing until W2-SEC fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createSecretsTools: FeatureToolFactory = () => ({});
