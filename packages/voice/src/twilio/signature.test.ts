import { describe, it, expect } from "vitest";
import { computeTwilioSignature, validateTwilioSignature, twilioUrlVariants } from "./signature.js";

// Twilio's published example (https://www.twilio.com/docs/usage/webhooks/webhooks-security).
const VECTOR = {
  token: "12345",
  url: "https://mycompany.com/myapp.php?foo=1&bar=2",
  params: {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675309",
    Digits: "1234",
    From: "+14158675309",
    To: "+18005551212",
  },
  expected: "RSOYDt4T1cUTdK1PDd93/VVr8B8=",
};

describe("Twilio signature", () => {
  it("reproduces the published vector", () => {
    expect(computeTwilioSignature(VECTOR.token, VECTOR.url, VECTOR.params)).toBe(VECTOR.expected);
    expect(validateTwilioSignature({ authToken: VECTOR.token, signature: VECTOR.expected, url: VECTOR.url, params: VECTOR.params })).toBe(true);
  });

  it("does not depend on parameter order", () => {
    const reversed = Object.fromEntries(Object.entries(VECTOR.params).reverse());
    expect(computeTwilioSignature(VECTOR.token, VECTOR.url, reversed)).toBe(VECTOR.expected);
  });

  it("fails for a changed param, a changed URL, a missing header and a wrong token", () => {
    const base = { authToken: VECTOR.token, signature: VECTOR.expected, url: VECTOR.url, params: VECTOR.params };
    expect(validateTwilioSignature({ ...base, params: { ...VECTOR.params, Digits: "1235" } })).toBe(false);
    expect(validateTwilioSignature({ ...base, params: { ...VECTOR.params, Extra: "x" } })).toBe(false);
    expect(validateTwilioSignature({ ...base, url: "https://mycompany.com/myapp.php?foo=1&bar=3" })).toBe(false);
    expect(validateTwilioSignature({ ...base, url: "https://evil.example/myapp.php?foo=1&bar=2" })).toBe(false);
    expect(validateTwilioSignature({ ...base, signature: undefined })).toBe(false);
    expect(validateTwilioSignature({ ...base, signature: "" })).toBe(false);
    expect(validateTwilioSignature({ ...base, authToken: "54321" })).toBe(false);
    expect(validateTwilioSignature({ ...base, authToken: "" })).toBe(false);
  });

  it("rejects a signature of a different length without throwing", () => {
    expect(validateTwilioSignature({ authToken: VECTOR.token, signature: "short", url: VECTOR.url, params: VECTOR.params })).toBe(false);
    expect(validateTwilioSignature({ authToken: VECTOR.token, signature: `${VECTOR.expected}AAAA`, url: VECTOR.url, params: VECTOR.params })).toBe(false);
  });

  it("accepts the :443 and trailing-slash variants of the URL", () => {
    const token = ["fake", "twilio", "token"].join("-");
    const params = { CallSid: "CA00000000000000000000000000000000", AccountSid: "AC00000000000000000000000000000000" };
    const configured = "https://kirie.example.com/voice/twilio/inbound";
    const sigWithPort = computeTwilioSignature(token, "https://kirie.example.com:443/voice/twilio/inbound", params);
    const sigWithSlash = computeTwilioSignature(token, "https://kirie.example.com/voice/twilio/inbound/", params);
    expect(validateTwilioSignature({ authToken: token, signature: sigWithPort, url: configured, params })).toBe(true);
    expect(validateTwilioSignature({ authToken: token, signature: sigWithSlash, url: configured, params })).toBe(true);
    const sigPlain = computeTwilioSignature(token, configured, params);
    expect(validateTwilioSignature({ authToken: token, signature: sigPlain, url: "https://kirie.example.com:443/voice/twilio/inbound", params })).toBe(true);
  });

  it("lists URL variants without touching the query", () => {
    const v = twilioUrlVariants("https://h.example/p?x=1");
    expect(v).toContain("https://h.example/p?x=1");
    expect(v).toContain("https://h.example:443/p?x=1");
    expect(v).toContain("https://h.example/p/?x=1");
    expect(twilioUrlVariants("not a url")).toEqual(["not a url"]);
  });

  it("handles array-valued params (sorted, deduplicated)", () => {
    const token = ["fake", "twilio", "token"].join("-");
    const a = computeTwilioSignature(token, "https://h.example/x", { Tag: ["b", "a", "b"] });
    const b = computeTwilioSignature(token, "https://h.example/x", { Tag: ["a", "b"] });
    expect(a).toBe(b);
  });
});
