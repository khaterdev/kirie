import { describe, it, expect } from "vitest";
import { isTransientNetworkError } from "./network-errors.js";

describe("isTransientNetworkError", () => {
  it("returns true for ETIMEDOUT error code", () => {
    const err = new Error("connect ETIMEDOUT");
    (err as NodeJS.ErrnoException).code = "ETIMEDOUT";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNREFUSED error code", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:443");
    (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ECONNRESET error code", () => {
    const err = new Error("socket hang up");
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ENOTFOUND error code", () => {
    const err = new Error("getaddrinfo ENOTFOUND api.telegram.org");
    (err as NodeJS.ErrnoException).code = "ENOTFOUND";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for EPIPE error code", () => {
    const err = new Error("write EPIPE");
    (err as NodeJS.ErrnoException).code = "EPIPE";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for EAI_AGAIN error code", () => {
    const err = new Error("getaddrinfo EAI_AGAIN");
    (err as NodeJS.ErrnoException).code = "EAI_AGAIN";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for EHOSTUNREACH error code", () => {
    const err = new Error("connect EHOSTUNREACH");
    (err as NodeJS.ErrnoException).code = "EHOSTUNREACH";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for ENETUNREACH error code", () => {
    const err = new Error("connect ENETUNREACH");
    (err as NodeJS.ErrnoException).code = "ENETUNREACH";
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("returns true for message containing 'etimedout' without error code", () => {
    expect(isTransientNetworkError(new Error("request failed: ETIMEDOUT"))).toBe(true);
  });

  it("returns true for message containing 'econnrefused' without error code", () => {
    expect(isTransientNetworkError(new Error("connect ECONNREFUSED 149.154.167.220:443"))).toBe(true);
  });

  it("returns true for message containing 'network'", () => {
    expect(isTransientNetworkError(new Error("Network request failed"))).toBe(true);
  });

  it("returns true for message containing 'socket hang up'", () => {
    expect(isTransientNetworkError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for message containing 'fetch failed'", () => {
    expect(isTransientNetworkError(new Error("fetch failed"))).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isTransientNetworkError("string error")).toBe(false);
    expect(isTransientNetworkError(42)).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientNetworkError(new Error("Bad Request: message to reply not found"))).toBe(false);
    expect(isTransientNetworkError(new Error("Forbidden: bot was blocked by the user"))).toBe(false);
    expect(isTransientNetworkError(new Error("TypeError: Cannot read property 'x'"))).toBe(false);
  });

  it("returns false for application-level errors", () => {
    expect(isTransientNetworkError(new Error("Unauthorized"))).toBe(false);
    expect(isTransientNetworkError(new Error("Rate limited"))).toBe(false);
    expect(isTransientNetworkError(new Error("Invalid token"))).toBe(false);
  });
});
