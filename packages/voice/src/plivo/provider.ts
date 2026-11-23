/**
 * Plivo implementation of VoiceCallProvider.
 *
 * Webhooks are verified with X-Plivo-Signature-V3 (and its nonce header); a
 * match on X-Plivo-Signature-Ma-V3 is accepted too, so a main-account token
 * works for a subaccount's number. Plivo webhooks carry no account id.
 * Numbers go out without "+" and are read back with "+" added (Plivo's
 * examples use E.164 without "+"; not verified against a live account).
 */

import { normalizeE164 } from "../numbers.js";
import {
  formValue,
  isUnsetSecret,
  type VoiceCallEvent,
  type VoiceCallProvider,
  type VoiceCallStatus,
  type VoiceFetch,
  type VoiceWebhookRequest,
} from "../provider.js";
import { PlivoClient } from "./client.js";
import { validatePlivoV3Signature } from "./signature.js";
import { plivoXml } from "./xml.js";

export interface PlivoProviderConfig {
  /** Resolved secret (voice.env or the credential store). */
  authId?: string;
  /** Resolved secret. */
  authToken?: string;
  fromNumber?: string;
  apiBaseUrl: string;
  voice: string;
}

const STATUS_MAP: Record<string, VoiceCallStatus> = {
  queued: "ringing",
  ringing: "ringing",
  "in-progress": "in-progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  timeout: "no-answer",
  "no-answer": "no-answer",
  cancel: "canceled",
  canceled: "canceled",
  cancelled: "canceled",
};

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createPlivoProvider(cfg: PlivoProviderConfig, deps: { fetch?: VoiceFetch } = {}): VoiceCallProvider {
  const authId = isUnsetSecret(cfg.authId) ? "" : cfg.authId!.trim();
  const authToken = isUnsetSecret(cfg.authToken) ? "" : cfg.authToken!.trim();
  const fromNumber = normalizeE164(cfg.fromNumber, { assumePlus: true });
  const client = authId && authToken
    ? new PlivoClient({ authId, authToken, apiBaseUrl: cfg.apiBaseUrl }, deps.fetch)
    : null;

  const requireClient = (): PlivoClient => {
    if (!client) throw new Error("Plivo is not configured");
    return client;
  };

  return {
    name: "plivo",
    routePrefix: "/voice/plivo",
    markup: plivoXml,
    maxSayChars: 800,
    voice: cfg.voice,
    fromNumber,

    missing() {
      const out: string[] = [];
      if (!authId) out.push("plivo.authId");
      if (!authToken) out.push("plivo.authToken");
      if (!fromNumber) out.push("plivo.fromNumber");
      return out;
    },

    verifyWebhook(req: VoiceWebhookRequest): boolean {
      try {
        if (!authId || !authToken) return false;
        const nonce = req.headers["x-plivo-signature-v3-nonce"];
        const base = { method: req.method, authToken, url: req.url, params: req.params, nonce };
        const v3 = validatePlivoV3Signature({ ...base, signatureHeader: req.headers["x-plivo-signature-v3"] });
        const ma = validatePlivoV3Signature({ ...base, signatureHeader: req.headers["x-plivo-signature-ma-v3"] });
        return v3 || ma;
      } catch {
        return false;
      }
    },

    parseEvent(req: VoiceWebhookRequest, direction): VoiceCallEvent {
      const p = req.params;
      const rawStatus = formValue(p, "CallStatus")?.toLowerCase();
      let status = rawStatus ? STATUS_MAP[rawStatus] : undefined;
      if (!status && formValue(p, "Event") === "Hangup") status = "completed";
      const inputType = formValue(p, "InputType")?.toLowerCase();
      const speechRaw = formValue(p, "Speech");
      const digitsRaw = formValue(p, "Digits");
      // A speech GetInput posts Digits empty and a DTMF one posts Speech empty.
      const speech = inputType === "dtmf" ? undefined : speechRaw;
      const digits = inputType === "speech" ? undefined : digitsRaw;
      const confidence = num(formValue(p, "SpeechConfidenceScore"));
      const duration = num(formValue(p, "Duration"));
      return {
        providerCallId: formValue(p, "CallUUID") ?? "",
        from: normalizeE164(formValue(p, "From"), { assumePlus: true }),
        to: normalizeE164(formValue(p, "To"), { assumePlus: true }),
        direction,
        ...(status ? { status } : {}),
        ...(speech !== undefined ? { speech } : {}),
        ...(confidence !== undefined && speech !== undefined ? { speechConfidence: confidence } : {}),
        ...(digits !== undefined ? { digits } : {}),
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
      };
    },

    async createCall(p) {
      const res = await requireClient().createCall(p);
      return res.requestUuid ? { requestId: res.requestUuid } : {};
    },

    async endCall(providerCallId: string) {
      // Never call Plivo's hangup endpoint without an id: it would disconnect every call on the account.
      if (!providerCallId || providerCallId.trim() === "") throw new Error("Plivo endCall needs a CallUUID");
      await requireClient().endCall(providerCallId);
    },

    secrets() {
      return [authId, authToken].filter((s) => s.length > 0);
    },
  };
}
