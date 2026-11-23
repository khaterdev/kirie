import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Claude account tools (PLAN B.13, W2-ACC).
 * Tools: accounts_list, accounts_discover, accounts_set_enabled, accounts_use, accounts_set_rotation, accounts_reset, accounts_import.
 *
 * Stub: registers nothing until W2-ACC fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createAccountsTools: FeatureToolFactory = () => ({});
