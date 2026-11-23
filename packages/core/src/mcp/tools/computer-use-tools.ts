import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Computer use tools (PLAN B.13, W3-CU).
 * Tools: computer_use_status.
 *
 * Stub: registers nothing until W3-CU fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createComputerUseTools: FeatureToolFactory = () => ({});
