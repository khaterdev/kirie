/**
 * Twilio implementation of VoiceCallProvider.
 */

import { safeEqual } from "../crypto-util.js";
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
import { TwilioClient } from "./client.js";
import { validateTwilioSignature } from "./signature.js";
import { twiml } from "./twiml.js";

export interface TwilioProviderConfig {
  /** Resolved secret (voice.env or the credential store). */
  accountSid?: string;
  /** Resolved secret. */
  authToken?: string;
  fromNumber?: string;
  apiBaseUrl: string;
  voice: string;
}

const STATUS_MAP: Record<string, VoiceCallStatus> = {
  queued: "ringing",
  initiated: "ringing",
  ringing: "ringing",
  "in-progress": "in-progress",
  answered: "in-progress",
  completed: "completed",
  busy: "busy",
  failed: "failed",
  "no-answer": "no-answer",
  canceled: "canceled",
};

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function createTwilioProvider(cfg: TwilioProviderConfig, deps: { fetch?: VoiceFetch } = {}): VoiceCallProvider {
  const accountSid = isUnsetSecret(cfg.accountSid) ? "" : cfg.accountSid!.trim();
  const authToken = isUnsetSecret(cfg.authToken) ? "" : cfg.authToken!.trim();
  const fromNumber = normalizeE164(cfg.fromNumber);
  const client = accountSid && authToken
    ? new TwilioClient({ accountSid, authToken, apiBaseUrl: cfg.apiBaseUrl }, deps.fetch)
    : null;

  const requireClient = (): TwilioClient => {
    if (!client) throw new Error("Twilio is not configured");
    return client;
  };

  return {
    name: "twilio",
    routePrefix: "/voice/twilio",
    markup: twiml,
    maxSayChars: 800,
    voice: cfg.voice,
    fromNumber,

    missing() {
      const out: string[] = [];
      if (!accountSid) out.push("twilio.accountSid");
      if (!authToken) out.push("twilio.authToken");
      if (!fromNumber) out.push("twilio.fromNumber");
      return out;
    },

    verifyWebhook(req: VoiceWebhookRequest): boolean {
      try {
        if (!accountSid || !authToken) return false;
        if (req.method.toUpperCase() !== "POST") return false;
        const sigOk = validateTwilioSignature({
          authToken,
          signature: req.headers["x-twilio-signature"],
          url: req.url,
          params: req.params,
        });
        const acctOk = safeEqual(formValue(req.params, "AccountSid") ?? "", accountSid);
        return sigOk && acctOk;
      } catch {
        return false;
      }
    },

    parseEvent(req: VoiceWebhookRequest, direction): VoiceCallEvent {
      const p = req.params;
      const rawStatus = formValue(p, "CallStatus")?.toLowerCase();
      const status = rawStatus ? STATUS_MAP[rawStatus] : undefined;
      const speech = formValue(p, "SpeechResult");
      const confidence = num(formValue(p, "Confidence"));
      const digits = formValue(p, "Digits");
      const duration = num(formValue(p, "CallDuration"));
      const accountId = formValue(p, "AccountSid");
      return {
        providerCallId: formValue(p, "CallSid") ?? "",
        ...(accountId ? { accountId } : {}),
        from: normalizeE164(formValue(p, "From")),
        to: normalizeE164(formValue(p, "To")),
        direction,
        ...(status ? { status } : {}),
        ...(speech !== undefined ? { speech } : {}),
        ...(confidence !== undefined ? { speechConfidence: confidence } : {}),
        ...(digits !== undefined ? { digits } : {}),
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
      };
    },

    async createCall(p) {
      const res = await requireClient().createCall(p);
      return res.callSid ? { providerCallId: res.callSid } : {};
    },

    async endCall(providerCallId: string) {
      if (!providerCallId || providerCallId.trim() === "") throw new Error("Twilio endCall needs a CallSid");
      await requireClient().endCall(providerCallId);
    },

    secrets() {
      return [accountSid, authToken].filter((s) => s.length > 0);
    },
  };
}
