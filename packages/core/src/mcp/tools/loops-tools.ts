import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Loop tools (PLAN B.13, W2-LOOP).
 * Tools: loop_create, loop_list, loop_stop.
 *
 * Stub: registers nothing until W2-LOOP fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createLoopsTools: FeatureToolFactory = () => ({});
