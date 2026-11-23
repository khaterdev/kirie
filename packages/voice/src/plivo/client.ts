/**
 * Plivo REST client for the two calls Kirie makes
 * (https://www.plivo.com/docs/voice/api/calls). Plain HTTPS with an injected
 * fetch; no SDK.
 *
 * Plivo documents that DELETE .../Call/ without a call UUID disconnects every
 * ongoing call on the account. endCall therefore refuses an empty or malformed
 * id before any request is made.
 */

import { basicAuth } from "../crypto-util.js";
import { VoiceProviderHttpError, assertSafeId, readProviderCode } from "../http-error.js";
import { withoutPlus } from "../numbers.js";
import type { VoiceCreateCallParams, VoiceFetch } from "../provider.js";

export interface PlivoClientConfig {
  authId: string;
  authToken: string;
  apiBaseUrl?: string;
}

export class PlivoClient {
  private readonly authId: string;
  private readonly authToken: string;
  private readonly base: string;
  private readonly fetchFn: VoiceFetch;

  constructor(cfg: PlivoClientConfig, fetchFn?: VoiceFetch) {
    this.authId = cfg.authId;
    this.authToken = cfg.authToken;
    this.base = (cfg.apiBaseUrl ?? "https://api.plivo.com").replace(/\/+$/, "");
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private callUrl(callUuid?: string): string {
    const root = `${this.base}/v1/Account/${encodeURIComponent(this.authId)}/Call/`;
    return callUuid === undefined ? root : `${root}${encodeURIComponent(callUuid)}/`;
  }

  /** Response is { message: "call fired", request_uuid, api_id }; the call UUID arrives on the answer webhook. */
  async createCall(p: VoiceCreateCallParams): Promise<{ requestUuid: string }> {
    const body: Record<string, unknown> = {
      from: withoutPlus(p.from),
      to: withoutPlus(p.to),
      answer_url: p.answerUrl,
      answer_method: "POST",
      hangup_url: p.statusUrl,
      hangup_method: "POST",
      time_limit: Math.max(1, Math.round(p.timeLimitSeconds)),
      ring_timeout: Math.max(5, Math.round(p.ringTimeoutSeconds)),
    };
    if (p.machineDetection) body.machine_detection = "true";
    const res = await this.fetchFn(this.callUrl(), {
      method: "POST",
      headers: {
        Authorization: basicAuth(this.authId, this.authToken),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new VoiceProviderHttpError("Plivo", "create call", res.status, await readProviderCode(res));
    const json = (await res.json().catch(() => ({}))) as { request_uuid?: unknown };
    return { requestUuid: typeof json.request_uuid === "string" ? json.request_uuid : "" };
  }

  /** DELETE .../Call/<uuid>/ (204). Throws before any request when the id is empty or malformed. */
  async endCall(callUuid: string): Promise<void> {
    assertSafeId("Plivo CallUUID", callUuid);
    const res = await this.fetchFn(this.callUrl(callUuid), {
      method: "DELETE",
      headers: { Authorization: basicAuth(this.authId, this.authToken), Accept: "application/json" },
    });
    if (!res.ok) throw new VoiceProviderHttpError("Plivo", "end call", res.status, await readProviderCode(res));
  }
}
