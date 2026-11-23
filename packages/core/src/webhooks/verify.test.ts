import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { assertUsableWebhookSecret, signWebhookPayload, verifyWebhookRequest, type WebhookSecretSet } from "./verify.js";
import { webhookDedupeKey } from "./replay.js";

// Synthetic secrets, assembled at run time.
const SECRET = ["synthetic", "hook", "secret", "a1b2"].join("-");
const OTHER = ["synthetic", "other", "secret", "c3d4"].join("-");
const NOW = 1_800_000_000_000;
const OPTS = { nowMs: NOW, toleranceSeconds: 300 };
const body = Buffer.from(JSON.stringify({ action: "opened", n: 1 }), "utf8");

function req(headers: Record<string, string>, raw: Buffer = body) {
  return { headers: new Headers(headers), rawBody: raw };
}

const set: WebhookSecretSet = { current: SECRET };

describe("assertUsableWebhookSecret", () => {
  it("rejects empty, whitespace and short secrets", () => {
    expect(() => assertUsableWebhookSecret("")).toThrow();
    expect(() => assertUsableWebhookSecret("    ")).toThrow();
    expect(() => assertUsableWebhookSecret("short")).toThrow();
    expect(() => assertUsableWebhookSecret(` ${SECRET}`)).toThrow();
    expect(() => assertUsableWebhookSecret(SECRET)).not.toThrow();
  });

  it("verification with an empty configured secret throws instead of passing", () => {
    expect(() => verifyWebhookRequest("bearer", req({ authorization: "Bearer x" }), { current: "" }, OPTS)).toThrow();
  });
});

describe("github", () => {
  const sig = (s: string, raw = body) => `sha256=${createHmac("sha256", s).update(raw).digest("hex")}`;

  it("accepts a valid X-Hub-Signature-256 over the raw body", () => {
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": sig(SECRET) }), set, OPTS)).toEqual({ ok: true, usedPrevious: false });
  });

  it("rejects a wrong secret, a missing prefix, a short or non-hex value without throwing", () => {
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": sig(OTHER) }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": sig(SECRET).slice(7) }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": "sha256=abc" }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": `sha256=${"z".repeat(64)}` }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("verifies the raw bytes, not a re-serialisation", () => {
    const pretty = Buffer.from(JSON.stringify({ action: "opened", n: 1 }, null, 2));
    expect(verifyWebhookRequest("github", req({ "x-hub-signature-256": sig(SECRET) }, pretty), set, OPTS)).toMatchObject({ ok: false });
  });

  it("ignores the SHA-1 X-Hub-Signature header", () => {
    const sha1 = `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`;
    expect(verifyWebhookRequest("github", req({ "x-hub-signature": sha1 }), set, OPTS)).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("sentry", () => {
  it("accepts the raw body, and the re-serialised JSON fallback", () => {
    const raw = Buffer.from('{ "action" : "created" }');
    const rawSig = createHmac("sha256", SECRET).update(raw).digest("hex");
    expect(verifyWebhookRequest("sentry", req({ "sentry-hook-signature": rawSig }, raw), set, OPTS)).toMatchObject({ ok: true });
    const reSig = createHmac("sha256", SECRET).update(JSON.stringify(JSON.parse(raw.toString()))).digest("hex");
    expect(verifyWebhookRequest("sentry", req({ "sentry-hook-signature": reSig }, raw), set, OPTS)).toMatchObject({ ok: true });
    expect(verifyWebhookRequest("sentry", req({ "sentry-hook-signature": "00".repeat(32) }, raw), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
  });
});

describe("generic", () => {
  const ts = Math.floor(NOW / 1000);

  it("accepts a valid v1 signature over v1:<timestamp>:<body>", () => {
    const h = signWebhookPayload("generic", SECRET, body, { timestampSeconds: ts });
    const res = verifyWebhookRequest("generic", req(h), set, OPTS);
    expect(res).toMatchObject({ ok: true, timestamp: ts });
  });

  it("rejects a timestamp outside the tolerance, with the skew", () => {
    const h = signWebhookPayload("generic", SECRET, body, { timestampSeconds: ts - 301 });
    expect(verifyWebhookRequest("generic", req(h), set, OPTS)).toEqual({ ok: false, reason: "stale_timestamp", skewSeconds: 301 });
    const future = signWebhookPayload("generic", SECRET, body, { timestampSeconds: ts + 400 });
    expect(verifyWebhookRequest("generic", req(future), set, OPTS)).toMatchObject({ ok: false, reason: "stale_timestamp" });
  });

  it("rejects a missing timestamp and a signature made for another timestamp", () => {
    const h = signWebhookPayload("generic", SECRET, body, { timestampSeconds: ts });
    expect(verifyWebhookRequest("generic", req({ "x-kirie-signature": h["x-kirie-signature"]! }), set, OPTS)).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(verifyWebhookRequest("generic", req({ ...h, "x-kirie-timestamp": String(ts - 1) }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("a body-only HMAC (another scheme's signature) is not accepted", () => {
    const bodyOnly = createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifyWebhookRequest("generic", req({ "x-kirie-signature": `v1=${bodyOnly}`, "x-kirie-timestamp": String(ts) }), set, OPTS)).toMatchObject({ ok: false });
  });
});

describe("bearer and alertmanager", () => {
  it("accepts the right token and rejects a wrong or missing one", () => {
    expect(verifyWebhookRequest("bearer", req({ authorization: `Bearer ${SECRET}` }), set, OPTS)).toMatchObject({ ok: true });
    expect(verifyWebhookRequest("bearer", req({ "x-kirie-token": SECRET }), set, OPTS)).toMatchObject({ ok: true });
    expect(verifyWebhookRequest("bearer", req({ authorization: `Bearer ${OTHER}` }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookRequest("bearer", req({ authorization: `Basic ${SECRET}` }), set, OPTS)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookRequest("bearer", req({}), set, OPTS)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyWebhookRequest("alertmanager", req({ authorization: `Bearer ${SECRET}` }), set, OPTS)).toMatchObject({ ok: true });
    // Alertmanager only sends Authorization.
    expect(verifyWebhookRequest("alertmanager", req({ "x-kirie-token": SECRET }), set, OPTS)).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("rotation grace", () => {
  it("accepts the previous secret inside the window and rejects it after", () => {
    const rotating: WebhookSecretSet = { current: OTHER, previous: SECRET, previousExpiresAtMs: NOW + 60_000 };
    const h = { authorization: `Bearer ${SECRET}` };
    expect(verifyWebhookRequest("bearer", req(h), rotating, OPTS)).toEqual({ ok: true, usedPrevious: true });
    expect(verifyWebhookRequest("bearer", req(h), rotating, { ...OPTS, nowMs: NOW + 60_001 })).toMatchObject({ ok: false });
  });
});

describe("dedupe key", () => {
  it("body-signed sources key on the body, not the unsigned delivery id", () => {
    const a = webhookDedupeKey("github", "h-1", body, {});
    expect(webhookDedupeKey("github", "h-1", body, {})).toBe(a);
    expect(webhookDedupeKey("github", "h-2", body, {})).not.toBe(a);
    expect(webhookDedupeKey("github", "h-1", Buffer.from("{}"), {})).not.toBe(a);
  });

  it("generic keys on the verified signature", () => {
    expect(webhookDedupeKey("generic", "h-1", body, { signature: "aa" })).not.toBe(webhookDedupeKey("generic", "h-1", body, { signature: "bb" }));
  });
});
