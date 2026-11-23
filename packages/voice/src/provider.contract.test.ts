import { runVoiceProviderContract } from "./provider.contract.js";
import { createTwilioProvider } from "./twilio/provider.js";
import { computeTwilioSignature } from "./twilio/signature.js";
import { createPlivoProvider } from "./plivo/provider.js";
import { computePlivoV3Signature } from "./plivo/signature.js";
import { withoutPlus } from "./numbers.js";

const SID = ["AC", "1".repeat(32)].join("");
const TWILIO_TOKEN = ["fake", "twilio", "auth"].join("-");
const PLIVO_ID = ["MA", "CONTRACTFAKE", "00000"].join("");
const PLIVO_TOKEN = ["fake", "plivo", "auth"].join("-");
const FROM = "+14155550100";

function twilio(omit: ReadonlyArray<string> = []) {
  return createTwilioProvider({
    ...(omit.includes("id") ? {} : { accountSid: SID }),
    ...(omit.includes("token") ? {} : { authToken: TWILIO_TOKEN }),
    ...(omit.includes("from") ? {} : { fromNumber: FROM }),
    apiBaseUrl: "https://api.twilio.com",
    voice: "Polly.Joanna-Neural",
  });
}

function plivo(omit: ReadonlyArray<string> = []) {
  return createPlivoProvider({
    ...(omit.includes("id") ? {} : { authId: PLIVO_ID }),
    ...(omit.includes("token") ? {} : { authToken: PLIVO_TOKEN }),
    ...(omit.includes("from") ? {} : { fromNumber: FROM }),
    apiBaseUrl: "https://api.plivo.com",
    voice: "WOMAN",
  });
}

runVoiceProviderContract({
  name: "twilio",
  routePrefix: "/voice/twilio",
  full: () => ({
    provider: twilio(),
    sign: (req) => ({ "x-twilio-signature": computeTwilioSignature(TWILIO_TOKEN, req.url, req.params) }),
    signWrong: (req) => ({ "x-twilio-signature": computeTwilioSignature("other-token", req.url, req.params) }),
  }),
  without: (fields) => twilio(fields),
  missingNames: { id: "twilio.accountSid", token: "twilio.authToken", from: "twilio.fromNumber" },
  payloads: {
    speech: (c, text, confidence) => ({
      CallSid: c.callId, AccountSid: SID, From: c.from, To: c.to, CallStatus: "in-progress",
      SpeechResult: text, Confidence: String(confidence),
    }),
    dtmf: (c, digits) => ({ CallSid: c.callId, AccountSid: SID, From: c.from, To: c.to, CallStatus: "in-progress", Digits: digits }),
    completed: (c, d) => ({ CallSid: c.callId, AccountSid: SID, From: c.from, To: c.to, CallStatus: "completed", CallDuration: String(d) }),
  },
});

let nonceCounter = 0;
function plivoSign(token: string, req: { url: string; params: Record<string, string | string[]> }): Record<string, string> {
  const nonce = String(10_000_000_000 + nonceCounter++);
  return {
    "x-plivo-signature-v3": computePlivoV3Signature(token, req.url, req.params, nonce),
    "x-plivo-signature-v3-nonce": nonce,
  };
}

runVoiceProviderContract({
  name: "plivo",
  routePrefix: "/voice/plivo",
  full: () => ({
    provider: plivo(),
    sign: (req) => plivoSign(PLIVO_TOKEN, req),
    signWrong: (req) => plivoSign("other-token", req),
  }),
  without: (fields) => plivo(fields),
  missingNames: { id: "plivo.authId", token: "plivo.authToken", from: "plivo.fromNumber" },
  payloads: {
    speech: (c, text, confidence) => ({
      CallUUID: c.callId, From: withoutPlus(c.from), To: withoutPlus(c.to), CallStatus: "in-progress",
      InputType: "speech", Speech: text, SpeechConfidenceScore: String(confidence), Digits: "",
    }),
    dtmf: (c, digits) => ({
      CallUUID: c.callId, From: withoutPlus(c.from), To: withoutPlus(c.to), CallStatus: "in-progress",
      InputType: "dtmf", Digits: digits, Speech: "",
    }),
    completed: (c, d) => ({
      CallUUID: c.callId, From: withoutPlus(c.from), To: withoutPlus(c.to), CallStatus: "completed", Event: "Hangup", Duration: String(d),
    }),
  },
});
