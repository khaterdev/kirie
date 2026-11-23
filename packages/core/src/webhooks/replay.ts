/**
 * Replay protection (PLAN C.6): the dedupe key stored in `deliveries`.
 *
 * Body-signed sources (github, sentry) use `sha256(hookId + ":" +
 * sha256(rawBody))`: the delivery-id headers are not signed, so an attacker
 * who swaps them still hits the same key, and a provider redelivery of the
 * same body is a duplicate. The generic scheme signs a timestamp too; its key
 * is the verified signature, so the same body re-signed at a later time is a
 * new delivery while a captured request is refused both by the timestamp
 * window and by this key.
 *
 * Bearer and Alertmanager requests carry neither a signed timestamp nor a
 * delivery id, and their senders legitimately repeat identical bodies (a
 * nightly "backup ok", Alertmanager's repeat notification for a group that
 * still fires). A body-only key would swallow every repeat for a year while
 * adding no security (the token holder can change one byte), so their key is
 * the body hash plus a time window of `timestampToleranceSeconds`, and the
 * previous window's key also counts: an identical body is a duplicate for at
 * least one window and at most two, then a new delivery.
 */

import { createHash } from "node:crypto";
import type { WebhookSource } from "./types.js";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function webhookDedupeKey(
  source: WebhookSource,
  hookId: string,
  rawBody: Buffer,
  verified: { signature?: string },
): string {
  if (source === "generic" && verified.signature) {
    return sha256Hex(`${hookId}:sig:${verified.signature}`);
  }
  if (source === "sentry") {
    // Sentry may sign re-serialised JSON, which verify accepts as a fallback.
    // Key on that canonical form, so a whitespace edit of a captured delivery
    // (which still verifies) is the same delivery, not a new one.
    return sha256Hex(`${hookId}:json:${sha256Hex(canonicalJson(rawBody))}`);
  }
  return sha256Hex(`${hookId}:${sha256Hex(rawBody)}`);
}

/** Sources whose key is scoped to a time window (see the file comment). */
const WINDOWED_SOURCES: ReadonlySet<WebhookSource> = new Set(["bearer", "alertmanager"]);

export interface WebhookReplayKeys {
  /** Stored with the delivery. */
  key: string;
  /** A delivery is also a duplicate when one of these was already claimed. */
  priorKeys: string[];
}

export function webhookReplayKeys(
  source: WebhookSource,
  hookId: string,
  rawBody: Buffer,
  verified: { signature?: string },
  window: { nowMs: number; windowSeconds: number },
): WebhookReplayKeys {
  if (!WINDOWED_SOURCES.has(source)) return { key: webhookDedupeKey(source, hookId, rawBody, verified), priorKeys: [] };
  const windowMs = Math.max(1, Math.floor(window.windowSeconds)) * 1000;
  const bucket = Math.floor(window.nowMs / windowMs);
  const bodyHash = sha256Hex(rawBody);
  const keyFor = (b: number): string => sha256Hex(`${hookId}:${bodyHash}:window:${windowMs}:${b}`);
  return { key: keyFor(bucket), priorKeys: [keyFor(bucket - 1)] };
}

function canonicalJson(rawBody: Buffer): Buffer {
  try {
    return Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8"))), "utf8");
  } catch {
    return rawBody;
  }
}
