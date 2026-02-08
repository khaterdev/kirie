import { detectMimeType } from "./mime.js";
import { DEFAULT_SIZE_CAPS } from "./size-caps.js";
import type { MediaKind } from "./types.js";

export interface FetchMediaOptions {
  /** Maximum allowed download size in bytes (default: 100MB) */
  maxBytes?: number;
  /** Per-kind size caps (overrides defaults) */
  sizeCaps?: Partial<Record<MediaKind, number>>;
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
}

/** CIDR ranges that are blocked to prevent SSRF */
const PRIVATE_RANGES = [
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16
];

function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) return 0;
  return (
    ((Number(parts[0]) & 0xff) << 24) |
    ((Number(parts[1]) & 0xff) << 16) |
    ((Number(parts[2]) & 0xff) << 8) |
    (Number(parts[3]) & 0xff)
  ) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  const num = ipToInt(ip);
  return PRIVATE_RANGES.some(
    (range) => (num & range.mask) >>> 0 === range.prefix >>> 0,
  );
}

/**
 * Resolve a hostname to its IP address and check for SSRF.
 * Throws if the resolved IP is in a private range.
 */
async function guardSsrf(hostname: string): Promise<void> {
  const { resolve4 } = await import("node:dns/promises");

  // Direct IP check
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error(`SSRF blocked: private IP ${hostname}`);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolve4(hostname);
  } catch {
    throw new Error(`SSRF check failed: cannot resolve ${hostname}`);
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(`SSRF blocked: ${hostname} resolves to private IP ${addr}`);
    }
  }
}

/**
 * Fetch remote media with SSRF protection, size caps, and timeout.
 */
export async function fetchMedia(
  url: string,
  opts?: FetchMediaOptions,
): Promise<{ buffer: Buffer; mimeType: string; filename?: string }> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_SIZE_CAPS.document;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  // Parse URL and guard against SSRF
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  await guardSsrf(parsed.hostname);

  // Fetch with timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  // Check content-length header early if available
  const contentLength = res.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(
      `Media too large: ${contentLength} bytes exceeds ${maxBytes} byte limit`,
    );
  }

  // Stream body with size enforcement
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    totalSize += value.byteLength;
    if (totalSize > maxBytes) {
      reader.cancel();
      throw new Error(
        `Media too large: exceeded ${maxBytes} byte limit during download`,
      );
    }

    chunks.push(value);
  }

  const buffer = Buffer.concat(chunks);

  // Derive filename from URL path
  const pathSegments = parsed.pathname.split("/");
  const lastSegment = pathSegments[pathSegments.length - 1];
  const filename = lastSegment && lastSegment.includes(".") ? decodeURIComponent(lastSegment) : undefined;

  // Detect MIME type
  const { mime } = await detectMimeType(buffer, filename);

  return { buffer, mimeType: mime, filename };
}
