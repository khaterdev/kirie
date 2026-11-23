// Phone calls (PLAN C.14): the provider abstraction, both providers, and the shared pieces.
export * from "./provider.js";
export * from "./numbers.js";
export * from "./secrets.js";
export * from "./call-store.js";
export * from "./speech.js";
export * from "./http-error.js";
export { escapeXml } from "./xml.js";
export { TwilioClient, TWILIO_STATUS_CALLBACK_EVENTS } from "./twilio/client.js";
export type { TwilioClientConfig } from "./twilio/client.js";
export { computeTwilioSignature, validateTwilioSignature, twilioSignatureBase, twilioUrlVariants } from "./twilio/signature.js";
export { twiml } from "./twilio/twiml.js";
export { createTwilioProvider } from "./twilio/provider.js";
export type { TwilioProviderConfig } from "./twilio/provider.js";
export { PlivoClient } from "./plivo/client.js";
export type { PlivoClientConfig } from "./plivo/client.js";
export { computePlivoV3Signature, validatePlivoV3Signature, plivoV3Base } from "./plivo/signature.js";
export { plivoXml } from "./plivo/xml.js";
export { createPlivoProvider } from "./plivo/provider.js";
export type { PlivoProviderConfig } from "./plivo/provider.js";

// Not used by the webhook call path; left in place (PLAN C.14).
export * from "./tts/types.js";
export * from "./tts/elevenlabs.js";
export * from "./tts/openai-tts.js";
export * from "./tts/edge-tts.js";
export * from "./tts/manager.js";
export * from "./transcription/whisper.js";
export * from "./voice-wake.js";
export * from "./telephony-audio.js";
export * from "./media-stream.js";
export * from "./response-generator.js";
