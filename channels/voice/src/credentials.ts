/**
 * Loads every voice secret through the one rule (`resolveVoiceSecret`,
 * PLAN C.14) and builds both providers. A provider without credentials is
 * still built: it reports what is missing and refuses every webhook and call.
 */

import type { VoiceConfig } from "@kirie/core";
import {
  createPlivoProvider,
  createTwilioProvider,
  readVoiceEnvFile,
  resolveVoiceSecret,
  type VoiceCallProvider,
  type VoiceCredentialLookup,
  type VoiceFetch,
  type VoiceProviderName,
  type VoiceSecretName,
} from "@kirie/voice";

export interface VoiceCredentials {
  twilio: { accountSid?: string; authToken?: string };
  plivo: { authId?: string; authToken?: string };
  pin?: string;
  envFile: { status: "ok" | "absent" | "ignored"; reason?: string };
  /** Refused config values, per provider and for the PIN. Never contain a value. */
  problems: { twilio: string[]; plivo: string[]; pin: string[] };
}

export async function loadVoiceCredentials(opts: {
  config: VoiceConfig;
  voiceEnvPath: string;
  credentials?: VoiceCredentialLookup;
  uid?: number;
}): Promise<VoiceCredentials> {
  const envFile = readVoiceEnvFile(opts.voiceEnvPath, opts.uid !== undefined ? { uid: opts.uid } : {});
  const resolve = (name: VoiceSecretName, configValue: string | undefined, configPath: string) =>
    resolveVoiceSecret(name, {
      envFile,
      configPath,
      ...(configValue !== undefined ? { configValue } : {}),
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
    });
  const c = opts.config;
  const [sid, twTok, authId, plTok, pin] = await Promise.all([
    resolve("TWILIO_ACCOUNT_SID", c.twilio.accountSid, "voice.twilio.accountSid"),
    resolve("TWILIO_AUTH_TOKEN", c.twilio.authToken, "voice.twilio.authToken"),
    resolve("PLIVO_AUTH_ID", c.plivo.authId, "voice.plivo.authId"),
    resolve("PLIVO_AUTH_TOKEN", c.plivo.authToken, "voice.plivo.authToken"),
    resolve("VOICE_PIN", c.inbound.pin, "voice.inbound.pin"),
  ]);
  const problems = (...rs: Array<{ problem?: string }>) => rs.map((r) => r.problem).filter((p): p is string => !!p);
  return {
    twilio: { ...(sid.value ? { accountSid: sid.value } : {}), ...(twTok.value ? { authToken: twTok.value } : {}) },
    plivo: { ...(authId.value ? { authId: authId.value } : {}), ...(plTok.value ? { authToken: plTok.value } : {}) },
    ...(pin.value ? { pin: pin.value } : {}),
    envFile: { status: envFile.status, ...(envFile.reason ? { reason: envFile.reason } : {}) },
    problems: { twilio: problems(sid, twTok), plivo: problems(authId, plTok), pin: problems(pin) },
  };
}

export function buildVoiceProviders(
  config: VoiceConfig,
  creds: VoiceCredentials,
  deps: { fetch?: VoiceFetch } = {},
): Record<VoiceProviderName, VoiceCallProvider> {
  const fetchDep = deps.fetch ? { fetch: deps.fetch } : {};
  return {
    twilio: createTwilioProvider({
      ...creds.twilio,
      ...(config.twilio.fromNumber ? { fromNumber: config.twilio.fromNumber } : {}),
      apiBaseUrl: config.twilio.apiBaseUrl,
      voice: config.twilio.voice,
    }, fetchDep),
    plivo: createPlivoProvider({
      ...creds.plivo,
      ...(config.plivo.fromNumber ? { fromNumber: config.plivo.fromNumber } : {}),
      apiBaseUrl: config.plivo.apiBaseUrl,
      voice: config.plivo.voice,
    }, fetchDep),
  };
}
