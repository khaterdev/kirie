import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Sandbox tools (PLAN B.13, W3-SBX).
 * Tools: sandbox_status, sandbox_bash (docker mode only).
 *
 * Stub: registers nothing until W3-SBX fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createSandboxTools: FeatureToolFactory = () => ({});
