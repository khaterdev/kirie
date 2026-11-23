/**
 * Readiness of the active provider (PLAN C.14 "Disabled until credentials
 * exist"). Pure: the caller resolves credentials first. A provider that is not
 * active needs nothing.
 */

import { VOICE_PIN_RE, type VoiceConfig } from "@kirie/core";
import type { VoiceCallProvider } from "@kirie/voice";

export type VoiceReadiness = { ready: true; missing: [] } | { ready: false; missing: string[] };

export function resolveVoiceReadiness(input: {
  config: VoiceConfig;
  publicBaseUrl: string | null;
  provider: VoiceCallProvider;
  pin?: string;
}): VoiceReadiness {
  const missing: string[] = [...input.provider.missing()];
  const url = input.publicBaseUrl?.trim();
  if (!url) {
    missing.push("ingress.publicBaseUrl");
  } else {
    let https = false;
    try { https = new URL(url).protocol === "https:"; } catch { https = false; }
    if (!https) missing.push("ingress.publicBaseUrl (must be an https URL)");
  }
  if (input.config.ownerNumbers.length === 0) missing.push("voice.ownerNumbers");
  if (input.config.inbound.mode === "agent" && input.config.inbound.requirePin) {
    if (!input.pin || !VOICE_PIN_RE.test(input.pin)) missing.push("voice.inbound.pin (4 to 10 digits)");
  }
  return missing.length === 0 ? { ready: true, missing: [] } : { ready: false, missing };
}
