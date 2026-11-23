/**
 * Twilio REST client for the two calls Kirie makes: create a call and end it
 * (https://www.twilio.com/docs/voice/api/call-resource). Plain HTTPS with an
 * injected fetch; no SDK.
 */

import { basicAuth } from "../crypto-util.js";
import { VoiceProviderHttpError, assertSafeId, readProviderCode } from "../http-error.js";
import type { VoiceCreateCallParams, VoiceFetch } from "../provider.js";

export interface TwilioClientConfig {
  accountSid: string;
  authToken: string;
  apiBaseUrl?: string;
}

export const TWILIO_STATUS_CALLBACK_EVENTS = ["initiated", "ringing", "answered", "completed"] as const;

export class TwilioClient {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly base: string;
  private readonly fetchFn: VoiceFetch;

  constructor(cfg: TwilioClientConfig, fetchFn?: VoiceFetch) {
    this.accountSid = cfg.accountSid;
    this.authToken = cfg.authToken;
    this.base = (cfg.apiBaseUrl ?? "https://api.twilio.com").replace(/\/+$/, "");
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private callsUrl(suffix = ""): string {
    return `${this.base}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Calls${suffix}.json`;
  }

  private async post(url: string, form: URLSearchParams, operation: string): Promise<Response> {
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.accountSid, this.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: form.toString(),
    });
    if (!res.ok) throw new VoiceProviderHttpError("Twilio", operation, res.status, await readProviderCode(res));
    return res;
  }

  async createCall(p: VoiceCreateCallParams): Promise<{ callSid: string; status: string }> {
    const form = new URLSearchParams();
    form.set("To", p.to);
    form.set("From", p.from);
    form.set("Url", p.answerUrl);
    form.set("Method", "POST");
    form.set("StatusCallback", p.statusUrl);
    form.set("StatusCallbackMethod", "POST");
    for (const ev of TWILIO_STATUS_CALLBACK_EVENTS) form.append("StatusCallbackEvent", ev);
    form.set("TimeLimit", String(Math.max(1, Math.round(p.timeLimitSeconds))));
    form.set("Timeout", String(Math.max(5, Math.round(p.ringTimeoutSeconds))));
    if (p.machineDetection) form.set("MachineDetection", "Enable");
    const res = await this.post(this.callsUrl(), form, "create call");
    const body = (await res.json().catch(() => ({}))) as { sid?: unknown; status?: unknown };
    const callSid = typeof body.sid === "string" ? body.sid : "";
    return { callSid, status: typeof body.status === "string" ? body.status : "queued" };
  }

  /** POST Status=completed. Throws on an empty or malformed sid and on a non-2xx response. */
  async endCall(callSid: string): Promise<void> {
    assertSafeId("Twilio CallSid", callSid);
    const form = new URLSearchParams({ Status: "completed" });
    await this.post(this.callsUrl(`/${encodeURIComponent(callSid)}`), form, "end call");
  }
}
