/**
 * X-Twilio-Signature (https://www.twilio.com/docs/usage/webhooks/webhooks-security):
 * base64(HMAC-SHA1(auth token, url + every POST param name and value
 * concatenated, params sorted by name)). Array values: deduplicated and sorted,
 * each written as name + value, as twilio-node does.
 */

import { hmacBase64, safeEqual } from "../crypto-util.js";

export type FormParams = Record<string, string | string[]>;

export function twilioSignatureBase(url: string, params: FormParams): string {
  let data = url;
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (Array.isArray(value)) {
      for (const v of [...new Set(value)].sort()) data += name + v;
    } else if (value !== undefined) {
      data += name + value;
    }
  }
  return data;
}

export function computeTwilioSignature(authToken: string, url: string, params: FormParams): string {
  return hmacBase64("sha1", authToken, twilioSignatureBase(url, params));
}

const URL_PARTS_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?$/i;

/**
 * The URL as given plus the variants Twilio may have signed: with and without
 * the default port (Twilio signs the URL as configured) and with and without a
 * trailing slash on the path.
 */
export function twilioUrlVariants(url: string): string[] {
  const m = URL_PARTS_RE.exec(url);
  if (!m) return [url];
  const scheme = m[1]!.toLowerCase();
  const authority = m[2]!;
  const path = m[3] ?? "";
  const query = m[4] ?? "";
  const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : null;

  const authorities = new Set<string>([authority]);
  const portMatch = /^(.*):(\d+)$/.exec(authority);
  if (portMatch && portMatch[2] === defaultPort) authorities.add(portMatch[1]!);
  if (!portMatch && defaultPort) authorities.add(`${authority}:${defaultPort}`);

  const paths = new Set<string>([path]);
  if (path.length > 1 && path.endsWith("/")) paths.add(path.slice(0, -1));
  else if (path.length > 0 && !path.endsWith("/")) paths.add(`${path}/`);

  const out = new Set<string>([url]);
  for (const a of authorities) for (const p of paths) out.add(`${m[1]}://${a}${p}${query}`);
  return [...out];
}

/** Constant-time per candidate. False for a missing signature or token. Never throws. */
export function validateTwilioSignature(opts: {
  authToken: string;
  signature: string | undefined;
  url: string;
  params: FormParams;
}): boolean {
  try {
    if (!opts.authToken || !opts.signature) return false;
    let ok = false;
    for (const candidate of twilioUrlVariants(opts.url)) {
      // No early exit: every variant is checked.
      if (safeEqual(computeTwilioSignature(opts.authToken, candidate, opts.params), opts.signature)) ok = true;
    }
    return ok;
  } catch {
    return false;
  }
}
