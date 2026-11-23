import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Voice call tools (PLAN B.13, W3-VOICE).
 * Tools: voice_call_initiate, voice_call_status, voice_call_list, voice_call_hangup.
 *
 * Stub: registers nothing until W3-VOICE fills this file in. The factory must stay
 * pure (no file, DB or network access when called); handlers open what they
 * need on first use. A tool that needs daemon state proxies to the daemon's
 * InternalApi over `ctx.gatewayUrl`.
 */
export const createVoiceTools: FeatureToolFactory = () => ({});
