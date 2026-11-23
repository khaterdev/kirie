import { z } from "zod/v3";

const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "E.164 number, e.g. +201001234567");

/**
 * `voice` (PLAN B.11, C.14, R5 item 14 with the binding changes). Replaces the
 * old schema: `tts`, `stt` and `maxConcurrentCalls` are dropped (stripped on
 * parse, so old configs still load). The public URL is `ingress.publicBaseUrl`.
 * Secret fields may be omitted when `~/.kirie/secrets/voice.env` supplies them;
 * when set they must be `$credential:` references. Runtime overrides:
 * `voice.switch`, `voice.provider`.
 */
export const VoiceConfigSchema = z.object({
  /** Master switch. Even when true, voice starts only if readiness passes. */
  enabled: z.boolean().default(false),
  /** Exactly one provider is active. */
  provider: z.enum(["twilio", "plivo"]).default("twilio"),
  twilio: z.object({
    /** "$credential:twilio.account_sid" */
    accountSid: z.string().optional(),
    /** "$credential:twilio.auth_token" */
    authToken: z.string().optional(),
    /** The Twilio number, E.164 (not a secret). */
    fromNumber: z.string().optional(),
    apiBaseUrl: z.string().url().default("https://api.twilio.com"),
    voice: z.string().default("Polly.Joanna-Neural"),
  }).default({}),
  plivo: z.object({
    /** "$credential:plivo.auth_id" */
    authId: z.string().optional(),
    /** "$credential:plivo.auth_token" */
    authToken: z.string().optional(),
    /** The Plivo number, E.164 (not a secret). */
    fromNumber: z.string().optional(),
    apiBaseUrl: z.string().url().default("https://api.plivo.com"),
    voice: z.string().default("WOMAN"),
  }).default({}),
  /** Numbers that are the owner. Only these can talk to the agent. */
  ownerNumbers: z.array(E164).default([]),
  /** Outbound allowlist: alias -> number. "me" is implicit (first owner number). */
  contacts: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/), E164).default({}),
  inbound: z.object({
    mode: z.enum(["reject", "voicemail", "agent"]).default("reject"),
    unknownCallers: z.enum(["reject", "voicemail"]).default("reject"),
    requirePin: z.boolean().default(true),
    /** "$credential:voice.pin", 4-10 digits. */
    pin: z.string().optional(),
    maxPinAttempts: z.number().int().min(1).max(5).default(3),
    pinLockoutMinutes: z.number().int().min(1).default(30),
    greeting: z.string().default("Hi, it's Kirie. Go ahead."),
    voicemailGreeting: z.string().default("This is the owner's assistant. Please leave a short message."),
  }).default({}),
  outbound: z.object({
    enabled: z.boolean().default(false),
    /** How the agent's voice_call_initiate tool is treated. */
    agentCalls: z.enum(["off", "ask", "allow"]).default("ask"),
    approvalTimeoutSeconds: z.number().int().min(10).default(120),
    ringTimeoutSeconds: z.number().int().min(5).max(60).default(30),
    machineDetection: z.boolean().default(false),
    announce: z.string().default("Hello. This is Kirie, an AI assistant calling on behalf of its owner."),
  }).default({}),
  limits: z.object({
    maxCallSeconds: z.number().int().min(30).max(3600).default(300),
    maxCallsPerDay: z.number().int().min(0).default(10),
    maxMinutesPerDay: z.number().int().min(0).default(20),
    /**
     * Inbound calls nobody has verified yet (voicemails, calls still at the PIN
     * prompt) have their own daily budget, so a spoofed or unknown caller
     * cannot use up the two caps above. A call joins those caps once its PIN is right.
     */
    maxUnverifiedCallsPerDay: z.number().int().min(0).default(10),
    maxUnverifiedMinutesPerDay: z.number().int().min(0).default(10),
    maxConcurrentCalls: z.number().int().min(1).max(5).default(1),
    maxTurnsPerCall: z.number().int().min(1).default(30),
    maxThinkSeconds: z.number().int().min(10).max(300).default(60),
    maxSpeechChars: z.number().int().min(100).max(3000).default(1200),
  }).default({}),
  speech: z.object({
    language: z.string().default("en-US"),
    speechTimeoutSeconds: z.number().int().min(1).max(10).default(3),
    hints: z.array(z.string()).default([]),
  }).default({}),
  agent: z.object({
    toolProfile: z.enum(["chat", "full"]).default("chat"),
  }).default({}),
}).default({});

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** Runtime override keys owned by voice (PLAN B.6, B.11). Only the /voice command writes them. */
export const VOICE_SETTING_KEYS = {
  /** Runtime on/off switch; absent means on whenever `voice.enabled` is true. */
  switch: "voice.switch",
  /** The active provider; absent means `voice.provider`. */
  provider: "voice.provider",
} as const;

export const VoiceProviderSettingSchema = z.enum(["twilio", "plivo"]);
export const VoiceSwitchSettingSchema = z.boolean();

/** PIN format for inbound agent mode: 4 to 10 digits. */
export const VOICE_PIN_RE = /^\d{4,10}$/;

/** kirie-tools env flag the voice feature sets while voice is ready and switched on; the voice tools exist only then. */
export const VOICE_TOOLS_ENV_FLAG = "KIRIE_VOICE_TOOLS";
