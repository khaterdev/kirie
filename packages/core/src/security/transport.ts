import {
  createHmac,
  timingSafeEqual,
  verify as ed25519Verify,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HmacVerifyOptions {
  payload: string | Buffer;
  signature: string;
  secret: string;
  /** Signature encoding: "hex" (default) or "base64" */
  encoding?: "hex" | "base64";
  /** Expected prefix in the signature header, e.g. "sha256=" for GitHub/Slack */
  prefix?: string;
}

export interface Ed25519VerifyOptions {
  payload: string | Buffer;
  signature: string;
  publicKey: string;
  /** Timestamp string, concatenated with payload before verification (Discord-style) */
  timestamp?: string;
}

export interface RequestSignature {
  /** The HMAC-SHA256 signature to include in the request header */
  signature: string;
  /** ISO timestamp used in signing */
  timestamp: string;
}

export interface TlsCheckResult {
  secure: boolean;
  protocol: string;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TransportSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportSecurityError";
  }
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 Verification
// ---------------------------------------------------------------------------

/**
 * Verify an HMAC-SHA256 signature against a payload and secret.
 * Used for Slack request verification and Telegram webhook secret_token.
 *
 * @returns true if the signature is valid, false otherwise
 */
export function verifyHmacSha256(options: HmacVerifyOptions): boolean {
  const { payload, secret, encoding = "hex", prefix = "" } = options;

  if (!secret) {
    throw new TransportSecurityError("HMAC secret must not be empty");
  }

  const expectedRaw = createHmac("sha256", secret)
    .update(payload)
    .digest(encoding);
  const expected = prefix + expectedRaw;

  const sigBytes = Buffer.from(options.signature);
  const expBytes = Buffer.from(expected);

  if (sigBytes.length !== expBytes.length) {
    return false;
  }

  return timingSafeEqual(sigBytes, expBytes);
}

/**
 * Convenience wrapper: verify a Slack-style request signature.
 * Slack sends `v0=<hex_hmac>` in the `x-slack-signature` header,
 * computed over `v0:{timestamp}:{body}`.
 */
export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  const baseString = `v0:${timestamp}:${body}`;
  return verifyHmacSha256({
    payload: baseString,
    signature,
    secret: signingSecret,
    encoding: "hex",
    prefix: "v0=",
  });
}

// ---------------------------------------------------------------------------
// Ed25519 Verification (Discord)
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 signature.
 * Discord sends the public key in the application dashboard, the signature
 * in `X-Signature-Ed25519`, and the timestamp in `X-Signature-Timestamp`.
 * The signed message is `timestamp + body`.
 *
 * @returns true if the signature is valid, false otherwise
 */
export function verifyEd25519(options: Ed25519VerifyOptions): boolean {
  const { payload, signature, publicKey, timestamp } = options;

  if (!publicKey) {
    throw new TransportSecurityError("Ed25519 public key must not be empty");
  }

  try {
    const message =
      timestamp !== undefined
        ? Buffer.concat([
            Buffer.from(timestamp),
            Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
          ])
        : Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(payload);

    const sigBuffer = Buffer.from(signature, "hex");
    const keyBuffer = Buffer.from(publicKey, "hex");

    return ed25519Verify(
      undefined, // algorithm — null for Ed25519
      message,
      { key: keyBuffer, format: "der", type: "spki" },
      sigBuffer,
    );
  } catch {
    // Ed25519 verify can throw on malformed input — treat as invalid
    // We use the raw key approach below as a fallback for Discord's raw public key format
  }

  // Discord provides a raw 32-byte Ed25519 public key (hex-encoded).
  // Node.js crypto.verify needs it wrapped in DER/SPKI format.
  try {
    const rawPubKey = Buffer.from(publicKey, "hex");
    if (rawPubKey.length !== 32) {
      return false;
    }

    // DER-encode the raw Ed25519 public key into SPKI format
    // SPKI prefix for Ed25519: 302a300506032b6570032100 (12 bytes)
    const spkiFull = Buffer.from(
      "302a300506032b6570032100",
      "hex",
    );
    const spkiKey = Buffer.concat([spkiFull, rawPubKey]);

    const message =
      timestamp !== undefined
        ? Buffer.concat([
            Buffer.from(timestamp),
            Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
          ])
        : Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(payload);

    const sigBuffer = Buffer.from(signature, "hex");

    return ed25519Verify(
      undefined,
      message,
      { key: spkiKey, format: "der", type: "spki" },
      sigBuffer,
    );
  } catch {
    return false;
  }
}

/**
 * Convenience wrapper for Discord webhook/interaction verification.
 */
export function verifyDiscordSignature(
  body: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): boolean {
  return verifyEd25519({
    payload: body,
    signature,
    publicKey,
    timestamp,
  });
}

// ---------------------------------------------------------------------------
// Secret Token Verification (Telegram)
// ---------------------------------------------------------------------------

/**
 * Verify a Telegram webhook secret_token.
 * Telegram sends the token in the `X-Telegram-Bot-Api-Secret-Token` header.
 * This is a constant-time string comparison.
 */
export function verifySecretToken(token: string, expected: string): boolean {
  if (!expected) {
    throw new TransportSecurityError("Expected secret token must not be empty");
  }

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);

  if (tokenBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(tokenBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// Request Signing (Gateway API)
// ---------------------------------------------------------------------------

/**
 * Sign an outgoing request with HMAC-SHA256 for the gateway API.
 * The signed message is `${timestamp}\n${method}\n${path}\n${body}`.
 */
export function signRequest(
  method: string,
  path: string,
  body: string,
  secret: string,
): RequestSignature {
  const timestamp = new Date().toISOString();
  const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;

  const signature = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return { signature, timestamp };
}

/**
 * Verify a signed gateway API request.
 */
export function verifyRequestSignature(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  signature: string,
  secret: string,
  maxAgeMs: number = 300_000, // 5 minutes
): boolean {
  // Check timestamp freshness
  const requestTime = new Date(timestamp).getTime();
  if (isNaN(requestTime)) {
    return false;
  }

  const age = Math.abs(Date.now() - requestTime);
  if (age > maxAgeMs) {
    return false;
  }

  const message = `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;

  const expected = createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);

  if (sigBuf.length !== expBuf.length) {
    return false;
  }

  return timingSafeEqual(sigBuf, expBuf);
}

// ---------------------------------------------------------------------------
// TLS Enforcement
// ---------------------------------------------------------------------------

/**
 * Check if a URL uses TLS (HTTPS).
 * Returns a result object with security status and any issues found.
 */
export function checkTls(url: string): TlsCheckResult {
  const issues: string[] = [];
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      secure: false,
      protocol: "unknown",
      issues: ["Invalid URL"],
    };
  }

  const protocol = parsedUrl.protocol;

  if (protocol === "https:" || protocol === "wss:") {
    return { secure: true, protocol, issues: [] };
  }

  if (protocol === "http:" || protocol === "ws:") {
    // Allow localhost/loopback for development
    const hostname = parsedUrl.hostname;
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return {
        secure: true,
        protocol,
        issues: ["Using unencrypted protocol on loopback (acceptable for development)"],
      };
    }

    issues.push(
      `Insecure protocol "${protocol}" used for non-loopback host "${hostname}". Use HTTPS/WSS instead.`,
    );
    return { secure: false, protocol, issues };
  }

  // Other protocols (file:, ftp:, etc.)
  issues.push(`Unsupported protocol: "${protocol}"`);
  return { secure: false, protocol, issues };
}

/**
 * Enforce TLS on a URL. Throws if the URL is not secure.
 */
export function enforceTls(url: string): void {
  const result = checkTls(url);
  if (!result.secure) {
    throw new TransportSecurityError(
      `TLS enforcement failed: ${result.issues.join("; ")}`,
    );
  }
}
