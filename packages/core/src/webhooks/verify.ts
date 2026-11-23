/**
 * Webhook signature verification (PLAN C.6, R3 "Signature schemes").
 *
 * Every check runs over the RAW body bytes and compares in constant time:
 * HMAC digests are compared as fixed-length byte buffers with
 * `timingSafeEqual`; bearer tokens are compared through their SHA-256 so the
 * comparison length never depends on the input. A malformed header is a
 * failed check, never a throw. The scheme is pinned per hook: a request is
 * only ever checked against its own hook's source.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebhookRejectReason, WebhookSource } from "./types.js";

/** Minimal header access, satisfied by `Headers`. */
export interface WebhookHeaders {
  get(name: string): string | null;
}

export interface WebhookSecretSet {
  current: string;
  /** Previous secret, accepted until `previousExpiresAtMs` (rotation grace) */
  previous?: string;
  previousExpiresAtMs?: number;
}

export type WebhookVerifyResult =
  | { ok: true; usedPrevious: boolean; /** generic scheme: the signed unix timestamp */ timestamp?: number; /** generic scheme: the verified signature hex */ signature?: string }
  | { ok: false; reason: Extract<WebhookRejectReason, "missing_signature" | "bad_signature" | "missing_timestamp" | "stale_timestamp">; skewSeconds?: number };

export interface WebhookVerifyOptions {
  nowMs: number;
  toleranceSeconds: number;
}

const MIN_SECRET_CHARS = 16;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;
/** Only used to flatten timing; never verifies anything. */
const THROWAWAY_KEY = randomBytes(32);
const ZERO_DIGEST = Buffer.alloc(32);

/** Rejects empty, whitespace-only and short secrets (auth-bypass shapes). */
export function assertUsableWebhookSecret(secret: string): void {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("Webhook secret must not be empty");
  }
  if (secret.trim() !== secret || secret.length < MIN_SECRET_CHARS) {
    throw new Error(`Webhook secret must be at least ${MIN_SECRET_CHARS} characters with no surrounding whitespace`);
  }
}

/** One HMAC over the body with a random key, so unknown and disabled hooks cost the same as known ones. */
export function burnWebhookVerification(rawBody: Buffer): void {
  const digest = createHmac("sha256", THROWAWAY_KEY).update(rawBody).digest();
  timingSafeEqual(digest, ZERO_DIGEST);
}

function hmac(secret: string, ...parts: Buffer[]): Buffer {
  const h = createHmac("sha256", secret);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Constant-time compare of a provided hex digest with an expected 32-byte digest. */
function hexDigestEquals(providedHex: string, expected: Buffer): boolean {
  if (!HEX64_RE.test(providedHex)) {
    timingSafeEqual(expected, ZERO_DIGEST);
    return false;
  }
  return timingSafeEqual(Buffer.from(providedHex, "hex"), expected);
}

/** Constant-time token compare through SHA-256, so neither length nor content leaks. */
function tokenEquals(provided: string, secret: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(a, b) && provided.length > 0;
}

function withPrevious(
  secrets: WebhookSecretSet,
  nowMs: number,
  check: (secret: string) => boolean,
): { ok: boolean; usedPrevious: boolean } {
  assertUsableWebhookSecret(secrets.current);
  if (check(secrets.current)) return { ok: true, usedPrevious: false };
  const prev = secrets.previous;
  if (prev && secrets.previousExpiresAtMs !== undefined && nowMs < secrets.previousExpiresAtMs) {
    assertUsableWebhookSecret(prev);
    if (check(prev)) return { ok: true, usedPrevious: true };
  }
  return { ok: false, usedPrevious: false };
}

function bearerToken(headers: WebhookHeaders, allowKirieToken: boolean): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(auth);
    return m ? m[1]! : "";
  }
  if (allowKirieToken) {
    const t = headers.get("x-kirie-token");
    if (t !== null) return t.trim();
  }
  return null;
}

/**
 * Verify one request for a hook's pinned source. Throws only on an unusable
 * configured secret (a programming or storage error, never caller input).
 */
export function verifyWebhookRequest(
  source: WebhookSource,
  req: { headers: WebhookHeaders; rawBody: Buffer },
  secrets: WebhookSecretSet,
  opts: WebhookVerifyOptions,
): WebhookVerifyResult {
  const { headers, rawBody } = req;
  switch (source) {
    case "github": {
      const header = headers.get("x-hub-signature-256");
      if (!header) return { ok: false, reason: "missing_signature" };
      const provided = header.trim().startsWith("sha256=") ? header.trim().slice(7) : "";
      const res = withPrevious(secrets, opts.nowMs, (s) => hexDigestEquals(provided, hmac(s, rawBody)));
      return res.ok ? { ok: true, usedPrevious: res.usedPrevious } : { ok: false, reason: "bad_signature" };
    }
    case "sentry": {
      const header = headers.get("sentry-hook-signature");
      if (!header) return { ok: false, reason: "missing_signature" };
      const provided = header.trim();
      // Sentry's documented example signs re-serialised JSON; try the raw bytes first, then that.
      let reserialised: Buffer | null = null;
      const res = withPrevious(secrets, opts.nowMs, (s) => {
        if (hexDigestEquals(provided, hmac(s, rawBody))) return true;
        if (reserialised === null) reserialised = reserialiseJson(rawBody);
        return reserialised !== null && hexDigestEquals(provided, hmac(s, reserialised));
      });
      return res.ok ? { ok: true, usedPrevious: res.usedPrevious } : { ok: false, reason: "bad_signature" };
    }
    case "generic": {
      const header = headers.get("x-kirie-signature");
      if (!header) return { ok: false, reason: "missing_signature" };
      const tsRaw = headers.get("x-kirie-timestamp")?.trim() ?? "";
      if (!TIMESTAMP_RE.test(tsRaw)) {
        burnWebhookVerification(rawBody);
        return { ok: false, reason: "missing_timestamp" };
      }
      const provided = header.trim().startsWith("v1=") ? header.trim().slice(3) : "";
      const prefix = Buffer.from(`v1:${tsRaw}:`, "utf8");
      const res = withPrevious(secrets, opts.nowMs, (s) => hexDigestEquals(provided, hmac(s, prefix, rawBody)));
      if (!res.ok) return { ok: false, reason: "bad_signature" };
      const ts = Number(tsRaw);
      const skew = Math.round(opts.nowMs / 1000 - ts);
      if (Math.abs(skew) > opts.toleranceSeconds) return { ok: false, reason: "stale_timestamp", skewSeconds: skew };
      return { ok: true, usedPrevious: res.usedPrevious, timestamp: ts, signature: provided.toLowerCase() };
    }
    case "bearer":
    case "alertmanager": {
      const token = bearerToken(headers, source === "bearer");
      if (token === null) return { ok: false, reason: "missing_signature" };
      const res = withPrevious(secrets, opts.nowMs, (s) => tokenEquals(token, s));
      return res.ok ? { ok: true, usedPrevious: res.usedPrevious } : { ok: false, reason: "bad_signature" };
    }
  }
}

function reserialiseJson(rawBody: Buffer): Buffer | null {
  try {
    return Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8"))), "utf8");
  } catch {
    return null;
  }
}

/**
 * The headers a sender must add for `source`. Used by `/webhook test` (signs a
 * sample with the real secret, in process) and by tests.
 */
export function signWebhookPayload(
  source: WebhookSource,
  secret: string,
  rawBody: Buffer,
  opts: { timestampSeconds?: number } = {},
): Record<string, string> {
  assertUsableWebhookSecret(secret);
  switch (source) {
    case "github":
      return { "x-hub-signature-256": `sha256=${hmac(secret, rawBody).toString("hex")}` };
    case "sentry":
      return { "sentry-hook-signature": hmac(secret, rawBody).toString("hex") };
    case "generic": {
      const ts = String(opts.timestampSeconds ?? Math.floor(Date.now() / 1000));
      return {
        "x-kirie-timestamp": ts,
        "x-kirie-signature": `v1=${hmac(secret, Buffer.from(`v1:${ts}:`, "utf8"), rawBody).toString("hex")}`,
      };
    }
    case "bearer":
    case "alertmanager":
      return { authorization: `Bearer ${secret}` };
  }
}
