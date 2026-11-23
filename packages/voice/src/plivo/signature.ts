/**
 * X-Plivo-Signature-V3, as implemented by Plivo's own SDKs (plivo-node
 * dist/utils/v3Security.js, plivo-python plivo/utils/signature_v3.py) and
 * Plivo's signature-validation doc (PLAN C.14):
 *
 *   1. base = scheme + "://" + host (+ ":" + port when present) + path, without the query.
 *   2. POST with body params: append "?" plus the URL's own query params sorted by name as
 *      k=v joined with "&" (the "?" is appended even when there are none); when that query
 *      part is non-empty append "."; then every body param sorted by name as name + value with
 *      no separators (multi-valued: values sorted). POST without body params: append "?" + the
 *      sorted query only when the URL has one.
 *   3. Append "." and the nonce from X-Plivo-Signature-V3-Nonce.
 *   4. HMAC-SHA256 keyed with the auth token, standard base64.
 *   5. The header may hold several comma-separated signatures; any match is valid. Kirie
 *      compares each in constant time.
 *
 * The URL query is decoded like Node's querystring.parse, which is what the SDK uses.
 * Only POST webhooks are configured and accepted; this module refuses anything else.
 */

import { parse as parseQuery } from "node:querystring";
import { hmacBase64, safeEqual } from "../crypto-util.js";

export type FormParams = Record<string, string | string[]>;

const URL_PARTS_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i;

function toList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? [...v] : [v];
}

function sortedQueryString(rawQuery: string): string {
  const parsed = parseQuery(rawQuery);
  const out: string[] = [];
  for (const key of Object.keys(parsed).sort()) {
    for (const value of toList(parsed[key]).sort()) out.push(`${key}=${value}`);
  }
  return out.join("&");
}

function sortedParamsString(params: FormParams): string {
  let out = "";
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (Array.isArray(v)) {
      for (const value of [...v].sort()) out += key + value;
    } else if (v !== undefined) {
      out += key + v;
    }
  }
  return out;
}

/** The string that is signed, before ".<nonce>" is appended. POST only. */
export function plivoV3Base(url: string, params: FormParams): string {
  const m = URL_PARTS_RE.exec(url);
  if (!m) throw new Error("not an absolute URL");
  const base = `${m[1]}://${m[2]}${m[3] ?? ""}`;
  const query = sortedQueryString(m[4] ?? "");
  const hasBody = Object.keys(params).length > 0;
  let out = base;
  if (query.length > 0 || hasBody) out += `?${query}`;
  if (query.length > 0 && hasBody) out += ".";
  return out + sortedParamsString(params);
}

export function computePlivoV3Signature(authToken: string, url: string, params: FormParams, nonce: string): string {
  return hmacBase64("sha256", authToken, `${plivoV3Base(url, params)}.${nonce}`);
}

/**
 * True when one of the comma-separated signatures in `signatureHeader` matches.
 * False for a missing header, nonce or token, a non-POST method, or a malformed URL. Never throws.
 */
export function validatePlivoV3Signature(opts: {
  method: string;
  authToken: string;
  url: string;
  params: FormParams;
  nonce: string | undefined;
  signatureHeader: string | undefined;
}): boolean {
  try {
    if (opts.method.toUpperCase() !== "POST") return false;
    if (!opts.authToken || !opts.nonce || !opts.signatureHeader) return false;
    const expected = computePlivoV3Signature(opts.authToken, opts.url, opts.params, opts.nonce);
    let ok = false;
    for (const candidate of opts.signatureHeader.split(",")) {
      const c = candidate.trim();
      if (c.length === 0) continue;
      // No early exit: every candidate is compared.
      if (safeEqual(expected, c)) ok = true;
    }
    return ok;
  } catch {
    return false;
  }
}
