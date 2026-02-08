import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyHmacSha256,
  verifySlackSignature,
  verifySecretToken,
  signRequest,
  verifyRequestSignature,
  checkTls,
  enforceTls,
  TransportSecurityError,
} from "./transport.js";

describe("verifyHmacSha256", () => {
  const secret = "test-secret";
  const payload = "hello world";

  it("returns true for valid signature", () => {
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      verifyHmacSha256({ payload, signature: expected, secret }),
    ).toBe(true);
  });

  it("returns false for invalid signature", () => {
    expect(
      verifyHmacSha256({ payload, signature: "invalid", secret }),
    ).toBe(false);
  });

  it("supports base64 encoding", () => {
    const expected = createHmac("sha256", secret).update(payload).digest("base64");
    expect(
      verifyHmacSha256({ payload, signature: expected, secret, encoding: "base64" }),
    ).toBe(true);
  });

  it("supports prefix in signature", () => {
    const raw = createHmac("sha256", secret).update(payload).digest("hex");
    const prefixed = `sha256=${raw}`;
    expect(
      verifyHmacSha256({ payload, signature: prefixed, secret, prefix: "sha256=" }),
    ).toBe(true);
  });

  it("throws for empty secret", () => {
    expect(() =>
      verifyHmacSha256({ payload, signature: "any", secret: "" }),
    ).toThrow(TransportSecurityError);
  });
});

describe("verifySlackSignature", () => {
  it("verifies a valid Slack-style signature", () => {
    const signingSecret = "slack-signing-secret";
    const timestamp = "1234567890";
    const body = '{"event":"test"}';
    const baseString = `v0:${timestamp}:${body}`;
    const hmac = createHmac("sha256", signingSecret).update(baseString).digest("hex");
    const signature = `v0=${hmac}`;

    expect(verifySlackSignature(body, timestamp, signature, signingSecret)).toBe(true);
  });

  it("rejects invalid Slack signature", () => {
    expect(
      verifySlackSignature("body", "timestamp", "v0=invalid", "secret"),
    ).toBe(false);
  });
});

describe("verifySecretToken", () => {
  it("returns true for matching token", () => {
    expect(verifySecretToken("my-secret", "my-secret")).toBe(true);
  });

  it("returns false for mismatched token", () => {
    expect(verifySecretToken("wrong", "expected")).toBe(false);
  });

  it("returns false for different length tokens", () => {
    expect(verifySecretToken("short", "much-longer-token")).toBe(false);
  });

  it("throws for empty expected token", () => {
    expect(() => verifySecretToken("any", "")).toThrow(TransportSecurityError);
  });
});

describe("signRequest / verifyRequestSignature", () => {
  const secret = "gateway-secret";

  it("produces a verifiable signature", () => {
    const { signature, timestamp } = signRequest("POST", "/api/status", '{"ok":true}', secret);

    expect(
      verifyRequestSignature("POST", "/api/status", '{"ok":true}', timestamp, signature, secret),
    ).toBe(true);
  });

  it("rejects tampered body", () => {
    const { signature, timestamp } = signRequest("POST", "/api/status", '{"ok":true}', secret);

    expect(
      verifyRequestSignature("POST", "/api/status", '{"ok":false}', timestamp, signature, secret),
    ).toBe(false);
  });

  it("rejects tampered path", () => {
    const { signature, timestamp } = signRequest("POST", "/api/status", "body", secret);

    expect(
      verifyRequestSignature("POST", "/api/other", "body", timestamp, signature, secret),
    ).toBe(false);
  });

  it("rejects different method", () => {
    const { signature, timestamp } = signRequest("POST", "/api/status", "body", secret);

    expect(
      verifyRequestSignature("GET", "/api/status", "body", timestamp, signature, secret),
    ).toBe(false);
  });

  it("rejects expired timestamp", () => {
    const oldTimestamp = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
    const message = `${oldTimestamp}\nPOST\n/api\nbody`;
    const signature = createHmac("sha256", secret).update(message).digest("hex");

    expect(
      verifyRequestSignature("POST", "/api", "body", oldTimestamp, signature, secret),
    ).toBe(false);
  });

  it("rejects invalid timestamp format", () => {
    expect(
      verifyRequestSignature("POST", "/api", "body", "not-a-date", "sig", secret),
    ).toBe(false);
  });

  it("normalizes method to uppercase", () => {
    const { signature, timestamp } = signRequest("post", "/api/status", "body", secret);
    expect(
      verifyRequestSignature("POST", "/api/status", "body", timestamp, signature, secret),
    ).toBe(true);
  });
});

describe("checkTls", () => {
  it("considers HTTPS secure", () => {
    const result = checkTls("https://example.com");
    expect(result.secure).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("considers WSS secure", () => {
    const result = checkTls("wss://example.com");
    expect(result.secure).toBe(true);
  });

  it("considers HTTP on localhost as secure", () => {
    const result = checkTls("http://localhost:8080");
    expect(result.secure).toBe(true);
  });

  it("considers HTTP on 127.0.0.1 as secure", () => {
    const result = checkTls("http://127.0.0.1:8080");
    expect(result.secure).toBe(true);
  });

  it("considers HTTP on non-loopback as insecure", () => {
    const result = checkTls("http://example.com");
    expect(result.secure).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("considers WS on non-loopback as insecure", () => {
    const result = checkTls("ws://example.com");
    expect(result.secure).toBe(false);
  });

  it("handles invalid URLs", () => {
    const result = checkTls("not-a-url");
    expect(result.secure).toBe(false);
    expect(result.issues).toContain("Invalid URL");
  });

  it("handles unsupported protocols", () => {
    const result = checkTls("ftp://example.com");
    expect(result.secure).toBe(false);
    expect(result.issues[0]).toContain("Unsupported protocol");
  });
});

describe("enforceTls", () => {
  it("does not throw for HTTPS URLs", () => {
    expect(() => enforceTls("https://example.com")).not.toThrow();
  });

  it("does not throw for localhost HTTP", () => {
    expect(() => enforceTls("http://localhost:8080")).not.toThrow();
  });

  it("throws for non-loopback HTTP", () => {
    expect(() => enforceTls("http://example.com")).toThrow(TransportSecurityError);
  });
});
