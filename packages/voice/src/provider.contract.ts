/**
 * The shared VoiceCallProvider contract suite (PLAN C.14), run against both
 * providers by provider.contract.test.ts. A provider passes when it reports
 * every missing item, verifies only correctly signed POSTs, and parses
 * equivalent payloads into the same VoiceCallEvent.
 */

import { describe, it, expect } from "vitest";
import type { VoiceCallEvent, VoiceCallProvider, VoiceWebhookRequest } from "./provider.js";

export interface ContractCall {
  callId: string;
  /** E.164 with "+" */
  from: string;
  to: string;
}

export interface VoiceProviderContractSpec {
  name: string;
  routePrefix: string;
  /** A provider with every credential present. */
  full(): VoiceProviderContractInstance;
  /** A provider built without the listed fields. */
  without(fields: ReadonlyArray<"id" | "token" | "from">): VoiceCallProvider;
  /** missing() names for "id", "token", "from". */
  missingNames: { id: string; token: string; from: string };
  /** Provider-dialect form fields. */
  payloads: {
    speech(c: ContractCall, text: string, confidence: number): Record<string, string>;
    dtmf(c: ContractCall, digits: string): Record<string, string>;
    completed(c: ContractCall, durationSeconds: number): Record<string, string>;
  };
}

export interface VoiceProviderContractInstance {
  provider: VoiceCallProvider;
  /** Headers that sign `req` with the configured token. */
  sign(req: Omit<VoiceWebhookRequest, "headers">): Record<string, string>;
  /** Headers that sign `req` with some other token. */
  signWrong(req: Omit<VoiceWebhookRequest, "headers">): Record<string, string>;
}

const CALL: ContractCall = { callId: "", from: "+201001234567", to: "+14155550100" };

export function runVoiceProviderContract(spec: VoiceProviderContractSpec): void {
  describe(`VoiceCallProvider contract: ${spec.name}`, () => {
    const call = (id: string): ContractCall => ({ ...CALL, callId: id });

    it("identifies itself", () => {
      const { provider } = spec.full();
      expect(provider.name).toBe(spec.name);
      expect(provider.routePrefix).toBe(spec.routePrefix);
      expect(provider.markup.contentType).toBe("text/xml");
      expect(provider.maxSayChars).toBeGreaterThan(100);
    });

    it("missing() is empty with every credential and lists each absent item", () => {
      expect(spec.full().provider.missing()).toEqual([]);
      expect(spec.without(["id"]).missing()).toEqual([spec.missingNames.id]);
      expect(spec.without(["token"]).missing()).toEqual([spec.missingNames.token]);
      expect(spec.without(["from"]).missing()).toEqual([spec.missingNames.from]);
      expect(spec.without(["id", "token", "from"]).missing()).toEqual([spec.missingNames.id, spec.missingNames.token, spec.missingNames.from]);
    });

    it("verifyWebhook is true for a correctly signed POST and false otherwise", () => {
      const inst = spec.full();
      const base = {
        method: "POST",
        url: `https://kirie.example.com${spec.routePrefix}/turn/0123456789abcdef0123456789abcdef`,
        params: spec.payloads.speech(call("id-0001-aaaa"), "hello", 0.9),
      };
      expect(inst.provider.verifyWebhook({ ...base, headers: inst.sign(base) })).toBe(true);
      expect(inst.provider.verifyWebhook({ ...base, headers: {} })).toBe(false);
      expect(inst.provider.verifyWebhook({ ...base, headers: inst.signWrong(base) })).toBe(false);
      const tampered = { ...base, params: { ...base.params, Extra: "1" } };
      expect(inst.provider.verifyWebhook({ ...tampered, headers: inst.sign(base) })).toBe(false);
      const otherUrl = { ...base, url: `${base.url}x` };
      expect(inst.provider.verifyWebhook({ ...otherUrl, headers: inst.sign(base) })).toBe(false);
      expect(inst.provider.verifyWebhook({ ...base, method: "GET", headers: inst.sign(base) })).toBe(false);
    });

    it("verifyWebhook is false when the provider has no credentials", () => {
      const inst = spec.full();
      const base = { method: "POST", url: `https://kirie.example.com${spec.routePrefix}/inbound`, params: spec.payloads.completed(call("id-0002-bbbb"), 3) };
      expect(spec.without(["token"]).verifyWebhook({ ...base, headers: inst.sign(base) })).toBe(false);
    });

    const parse = (params: Record<string, string>, direction: "inbound" | "outbound"): VoiceCallEvent => {
      const { provider } = spec.full();
      const ev = provider.parseEvent({ method: "POST", url: "https://kirie.example.com/x", headers: {}, params }, direction);
      // accountId is Twilio-only by design.
      const { accountId: _ignored, ...rest } = ev;
      return rest;
    };

    it("parseEvent: speech turn", () => {
      expect(parse(spec.payloads.speech(call("id-0003-cccc"), "what's next", 0.87), "inbound")).toEqual({
        providerCallId: "id-0003-cccc",
        from: CALL.from,
        to: CALL.to,
        direction: "inbound",
        status: "in-progress",
        speech: "what's next",
        speechConfidence: 0.87,
      });
    });

    it("parseEvent: DTMF", () => {
      expect(parse(spec.payloads.dtmf(call("id-0004-dddd"), "4321"), "inbound")).toEqual({
        providerCallId: "id-0004-dddd",
        from: CALL.from,
        to: CALL.to,
        direction: "inbound",
        status: "in-progress",
        digits: "4321",
      });
    });

    it("parseEvent: completed", () => {
      expect(parse(spec.payloads.completed(call("id-0005-eeee"), 42), "outbound")).toEqual({
        providerCallId: "id-0005-eeee",
        from: CALL.from,
        to: CALL.to,
        direction: "outbound",
        status: "completed",
        durationSeconds: 42,
      });
    });

    it("parseEvent: a withheld caller id is null", () => {
      const params = { ...spec.payloads.completed(call("id-0006-ffff"), 1), From: "anonymous" };
      expect(parse(params, "inbound").from).toBeNull();
    });
  });
}
