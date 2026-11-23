import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Unequal lengths compare the expected value
 * with itself first, so the time taken does not depend on where the inputs differ.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function hmacBase64(algorithm: "sha1" | "sha256", key: string, data: string): string {
  return createHmac(algorithm, Buffer.from(key, "utf8")).update(Buffer.from(data, "utf8")).digest("base64");
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}
