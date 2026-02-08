/**
 * SSRF (Server-Side Request Forgery) protection guard.
 *
 * Validates URLs before fetching to prevent access to internal/private networks.
 * Blocks private IP ranges, localhost, link-local, metadata endpoints, and
 * configurable hostname patterns.
 */

import { isIPv4, isIPv6 } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

// ── Blocked IP ranges ───────────────────────────────────────────────────────

interface CIDRBlock {
  ip: number[];
  prefix: number;
}

/**
 * Parse an IPv4 address string into a 4-element number array.
 */
function parseIPv4(ip: string): number[] {
  return ip.split(".").map(Number);
}

/**
 * Check if an IPv4 address (as number[]) falls within a CIDR block.
 */
function ipv4InCIDR(ip: number[], block: CIDRBlock): boolean {
  const maskBits = block.prefix;
  // Convert to 32-bit integers
  const ipNum =
    ((ip[0]! << 24) | (ip[1]! << 16) | (ip[2]! << 8) | ip[3]!) >>> 0;
  const blockNum =
    ((block.ip[0]! << 24) |
      (block.ip[1]! << 16) |
      (block.ip[2]! << 8) |
      block.ip[3]!) >>>
    0;
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipNum & mask) === (blockNum & mask);
}

/** IPv4 CIDR blocks that are private/internal/reserved. */
const BLOCKED_IPV4_CIDRS: CIDRBlock[] = [
  { ip: [10, 0, 0, 0], prefix: 8 }, // 10.0.0.0/8 - Private
  { ip: [172, 16, 0, 0], prefix: 12 }, // 172.16.0.0/12 - Private
  { ip: [192, 168, 0, 0], prefix: 16 }, // 192.168.0.0/16 - Private
  { ip: [127, 0, 0, 0], prefix: 8 }, // 127.0.0.0/8 - Loopback
  { ip: [169, 254, 0, 0], prefix: 16 }, // 169.254.0.0/16 - Link-local
  { ip: [0, 0, 0, 0], prefix: 8 }, // 0.0.0.0/8 - Current network
  { ip: [100, 64, 0, 0], prefix: 10 }, // 100.64.0.0/10 - Carrier-grade NAT
  { ip: [192, 0, 0, 0], prefix: 24 }, // 192.0.0.0/24 - IETF Protocol
  { ip: [192, 0, 2, 0], prefix: 24 }, // 192.0.2.0/24 - Documentation
  { ip: [198, 18, 0, 0], prefix: 15 }, // 198.18.0.0/15 - Benchmark
  { ip: [198, 51, 100, 0], prefix: 24 }, // 198.51.100.0/24 - Documentation
  { ip: [203, 0, 113, 0], prefix: 24 }, // 203.0.113.0/24 - Documentation
  { ip: [224, 0, 0, 0], prefix: 4 }, // 224.0.0.0/4 - Multicast
  { ip: [240, 0, 0, 0], prefix: 4 }, // 240.0.0.0/4 - Reserved
];

/**
 * Check if an IPv4 address string is in a blocked range.
 */
function isBlockedIPv4(ip: string): boolean {
  const parsed = parseIPv4(ip);
  return BLOCKED_IPV4_CIDRS.some((block) => ipv4InCIDR(parsed, block));
}

/**
 * Parse an IPv6 address into a 16-byte Uint8Array.
 * Handles :: expansion and IPv4-mapped addresses.
 */
function parseIPv6(ip: string): Uint8Array {
  const bytes = new Uint8Array(16);

  // Handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  const v4Mapped = ip.match(
    /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
  );
  if (v4Mapped) {
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    const v4 = parseIPv4(v4Mapped[1]!);
    bytes[12] = v4[0]!;
    bytes[13] = v4[1]!;
    bytes[14] = v4[2]!;
    bytes[15] = v4[3]!;
    return bytes;
  }

  // Expand :: notation
  const halves = ip.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];

  let offset = 0;
  for (const group of left) {
    const val = parseInt(group, 16);
    bytes[offset++] = (val >> 8) & 0xff;
    bytes[offset++] = val & 0xff;
  }

  offset = 16 - right.length * 2;
  for (const group of right) {
    const val = parseInt(group, 16);
    bytes[offset++] = (val >> 8) & 0xff;
    bytes[offset++] = val & 0xff;
  }

  return bytes;
}

/**
 * Check if an IPv6 address matches a prefix.
 */
function ipv6MatchesPrefix(
  ip: Uint8Array,
  prefix: Uint8Array,
  bits: number,
): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ip[i] !== prefix[i]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits > 0) {
    const mask = 0xff << (8 - remainingBits);
    if ((ip[fullBytes]! & mask) !== (prefix[fullBytes]! & mask)) return false;
  }
  return true;
}

/** Blocked IPv6 prefix definitions. */
const BLOCKED_IPV6_PREFIXES: Array<{ prefix: Uint8Array; bits: number }> = [
  { prefix: parseIPv6("::1"), bits: 128 }, // Loopback
  { prefix: parseIPv6("fc00::"), bits: 7 }, // Unique local (ULA)
  { prefix: parseIPv6("fe80::"), bits: 10 }, // Link-local
  { prefix: parseIPv6("::ffff:10.0.0.0"), bits: 104 }, // IPv4-mapped 10.0.0.0/8
  { prefix: parseIPv6("::ffff:172.16.0.0"), bits: 108 }, // IPv4-mapped 172.16.0.0/12
  { prefix: parseIPv6("::ffff:192.168.0.0"), bits: 112 }, // IPv4-mapped 192.168.0.0/16
  { prefix: parseIPv6("::ffff:127.0.0.0"), bits: 104 }, // IPv4-mapped 127.0.0.0/8
  { prefix: parseIPv6("::ffff:169.254.0.0"), bits: 112 }, // IPv4-mapped link-local
  { prefix: parseIPv6("::"), bits: 128 }, // Unspecified
];

/**
 * Check if an IPv6 address string is in a blocked range.
 */
function isBlockedIPv6(ip: string): boolean {
  const parsed = parseIPv6(ip);
  return BLOCKED_IPV6_PREFIXES.some((block) =>
    ipv6MatchesPrefix(parsed, block.prefix, block.bits),
  );
}

// ── Blocked hostname patterns ───────────────────────────────────────────────

/** Hostname patterns that should always be blocked. */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.localhost$/i,
  /\.corp$/i,
  /\.home$/i,
  /\.lan$/i,
];

/** Specific hostnames that are known metadata endpoints. */
const BLOCKED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
]);

// ── SSRFGuard class ─────────────────────────────────────────────────────────

export interface SSRFGuardOptions {
  /** Hosts to always allow (bypass all checks). */
  allowedHosts?: string[];
  /** Additional hosts to block beyond the defaults. */
  blockedHosts?: string[];
}

export class SSRFGuard {
  private readonly allowedHosts: Set<string>;
  private readonly extraBlockedHosts: Set<string>;

  constructor(options?: SSRFGuardOptions) {
    this.allowedHosts = new Set(
      (options?.allowedHosts ?? []).map((h) => h.toLowerCase()),
    );
    this.extraBlockedHosts = new Set(
      (options?.blockedHosts ?? []).map((h) => h.toLowerCase()),
    );
  }

  /**
   * Validate a URL is safe to fetch (synchronous).
   * Checks URL scheme, hostname patterns, and IP ranges.
   * Does NOT perform DNS resolution — use validateAsync for that.
   * @throws Error if the URL is blocked.
   */
  validate(url: string): void {
    const parsed = this.parseAndCheck(url);
    if (parsed) throw new Error(parsed);
  }

  /**
   * Check if a URL is safe without throwing (synchronous).
   */
  isSafe(url: string): boolean {
    return this.parseAndCheck(url) === null;
  }

  /**
   * Validate a URL including DNS resolution checks (async).
   * This resolves the hostname and checks if any resolved IPs are blocked.
   * @throws Error if the URL or any resolved IP is blocked.
   */
  async validateAsync(url: string): Promise<void> {
    // First, do synchronous checks
    const syncError = this.parseAndCheck(url);
    if (syncError) throw new Error(syncError);

    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

    // Skip DNS check if hostname is already an IP
    if (isIPv4(hostname) || isIPv6(hostname)) return;

    // Skip DNS for allowlisted hosts
    if (this.allowedHosts.has(hostname.toLowerCase())) return;

    // Resolve and check IPs
    const ipResults: string[] = [];

    try {
      const v4 = await resolve4(hostname);
      ipResults.push(...v4);
    } catch {
      // No A records
    }

    try {
      const v6 = await resolve6(hostname);
      ipResults.push(...v6);
    } catch {
      // No AAAA records
    }

    for (const ip of ipResults) {
      if (isIPv4(ip) && isBlockedIPv4(ip)) {
        throw new Error(
          `SSRF blocked: hostname "${hostname}" resolves to private IP ${ip}`,
        );
      }
      if (isIPv6(ip) && isBlockedIPv6(ip)) {
        throw new Error(
          `SSRF blocked: hostname "${hostname}" resolves to private IPv6 ${ip}`,
        );
      }
    }
  }

  /**
   * Internal: parse URL and check hostname/IP synchronously.
   * Returns error message string or null if safe.
   */
  private parseAndCheck(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `SSRF blocked: invalid URL "${url}"`;
    }

    // Only allow http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `SSRF blocked: protocol "${parsed.protocol}" not allowed`;
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();

    if (!hostname) {
      return "SSRF blocked: empty hostname";
    }

    // Check allowlist first
    if (this.allowedHosts.has(hostname)) {
      return null;
    }

    // Check extra blocked hosts
    if (this.extraBlockedHosts.has(hostname)) {
      return `SSRF blocked: host "${hostname}" is blocked`;
    }

    // Check blocked hostnames (metadata endpoints, etc.)
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return `SSRF blocked: host "${hostname}" is a known internal/metadata endpoint`;
    }

    // Check blocked hostname patterns
    for (const pattern of BLOCKED_HOST_PATTERNS) {
      if (pattern.test(hostname)) {
        return `SSRF blocked: host "${hostname}" matches blocked pattern`;
      }
    }

    // If hostname is an IPv4 address, check IP ranges
    if (isIPv4(hostname)) {
      if (isBlockedIPv4(hostname)) {
        return `SSRF blocked: IPv4 address "${hostname}" is in a private/reserved range`;
      }
    }

    // If hostname is an IPv6 address, check ranges
    if (isIPv6(hostname)) {
      if (isBlockedIPv6(hostname)) {
        return `SSRF blocked: IPv6 address "${hostname}" is in a private/reserved range`;
      }
    }

    return null;
  }
}
