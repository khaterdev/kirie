// @kirie/channel-voice: phone calls as a Kirie channel (PLAN C.14). Names no provider.
export { VoiceAdapter } from "./adapter.js";
export type { VoiceAdapterDeps } from "./adapter.js";
export { VoiceCallFlow } from "./flow.js";
export type { FlowResult, VoiceFlowDeps, VoiceTurnEmission, CapCheck } from "./flow.js";
export { createVoiceRoutes, VOICE_MAX_BODY_BYTES } from "./routes.js";
export type { VoiceRouteDeps } from "./routes.js";
export { VoiceService, VOICE_MAX_MESSAGE_CHARS } from "./service.js";
export type { VoiceServiceDeps, VoiceIngress, PlaceCallRequest, PlaceCallResult, VoiceCallView } from "./service.js";
export { resolveVoiceReadiness } from "./readiness.js";
export type { VoiceReadiness } from "./readiness.js";
export { loadVoiceCredentials, buildVoiceProviders } from "./credentials.js";
export type { VoiceCredentials } from "./credentials.js";
export { createVoiceInternalApi } from "./internal-api.js";
export { createVoiceCommands, createVoiceCommand, createCallCommand, parseCallArgs, VOICE_COMMAND_USAGE, CALL_COMMAND_USAGE } from "./commands.js";
export {
  applyVoiceToolProfile,
  isVoiceSession,
  voicePromptAddendum,
  VOICE_PROMPT_ADDENDUM,
  VOICE_CHAT_PROFILE_DISALLOWED,
  VOICE_ALWAYS_DISALLOWED,
} from "./profile.js";
export {
  LiveCallRegistry,
  voiceSessionKey,
  voiceTurnMessageId,
  parseVoiceTurnMessageId,
  newCallToken,
} from "./session.js";
export type { LiveCall, LivePhase, PendingTurn } from "./session.js";
