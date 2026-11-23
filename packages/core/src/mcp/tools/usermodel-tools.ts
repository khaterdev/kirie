import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * User model tools (PLAN B.13, W3-UM).
 * Tools: user_model_query.
 *
 * Stub: registers nothing until W3-UM fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createUserModelTools: FeatureToolFactory = () => ({});
