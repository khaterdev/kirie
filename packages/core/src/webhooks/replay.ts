/**
 * Replay protection (PLAN C.6): the dedupe key stored in `deliveries`.
 *
 * Body-signed sources (github, sentry) and bearer sources use
 * `sha256(hookId + ":" + sha256(rawBody))`: the delivery-id headers are not
 * signed, so an attacker who swaps them still hits the same key, and a
 * provider redelivery of the same body is a duplicate. The generic scheme
 * signs a timestamp too; its key is the verified signature, so the same body
 * re-signed at a later time is a new delivery while a captured request is
 * refused both by the timestamp window and by this key.
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

function canonicalJson(rawBody: Buffer): Buffer {
  try {
    return Buffer.from(JSON.stringify(JSON.parse(rawBody.toString("utf8"))), "utf8");
  } catch {
    return rawBody;
  }
}
