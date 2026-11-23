import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Goal tools (PLAN B.13, W2-GOAL).
 * Tools: goal_create, goal_list, goal_status, goal_stop.
 *
 * Stub: registers nothing until W2-GOAL fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createGoalsTools: FeatureToolFactory = () => ({});
