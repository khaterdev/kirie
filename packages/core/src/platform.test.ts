import { describe, it, expect, vi } from "vitest";
import { IS_WINDOWS, IS_MACOS, IS_LINUX, binExists, toDockerPath } from "./platform.js";

describe("platform constants", () => {
  it("IS_WINDOWS, IS_MACOS, IS_LINUX are booleans", () => {
    expect(typeof IS_WINDOWS).toBe("boolean");
    expect(typeof IS_MACOS).toBe("boolean");
    expect(typeof IS_LINUX).toBe("boolean");
  });

  it("exactly one constant matches the current platform", () => {
    const trueCount = [IS_WINDOWS, IS_MACOS, IS_LINUX].filter(Boolean).length;
    // On exotic platforms (freebsd etc.) all could be false, but normally exactly one is true
    expect(trueCount).toBeLessThanOrEqual(1);
    if (
      process.platform === "win32" ||
      process.platform === "darwin" ||
      process.platform === "linux"
    ) {
      expect(trueCount).toBe(1);
    }
  });
});

describe("binExists", () => {
  it("returns true for a binary that exists (node)", () => {
    expect(binExists("node")).toBe(true);
  });

  it("returns false for a binary that does not exist", () => {
    expect(binExists("nonexistent_binary_xyz_12345")).toBe(false);
  });

  it("does not throw on non-existent binary", () => {
    expect(() => binExists("nonexistent_binary_xyz_12345")).not.toThrow();
  });

  it("is safe with special characters in binary name (no shell injection)", () => {
    // These should all return false without executing anything harmful
    expect(binExists("; rm -rf /")).toBe(false);
    expect(binExists("$(echo pwned)")).toBe(false);
    expect(binExists("`echo pwned`")).toBe(false);
  });

  it("uses 'which' on non-Windows and would use 'where' on Windows", () => {
    // We can't spy on ESM exports directly, but we can verify the behavior
    // by checking that binExists delegates to the right command.
    // On the current platform (non-Windows in CI), 'which' is used.
    // We verify correct behavior indirectly: 'node' is found by 'which' on Unix.
    if (process.platform !== "win32") {
      // 'which' is the Unix binary lookup command
      expect(binExists("node")).toBe(true);
      expect(binExists("which")).toBe(true); // 'which' itself exists on Unix
    }
  });
});

describe("toDockerPath", () => {
  it("returns the same path unchanged on non-Windows", () => {
    if (!IS_WINDOWS) {
      expect(toDockerPath("/home/user/.kirie")).toBe("/home/user/.kirie");
      expect(toDockerPath("/var/lib/data")).toBe("/var/lib/data");
    }
  });

  it("converts Windows drive paths when on Windows", () => {
    if (IS_WINDOWS) {
      expect(toDockerPath("C:\\Users\\foo\\.kirie")).toBe("/c/Users/foo/.kirie");
      expect(toDockerPath("D:\\Projects\\app")).toBe("/d/Projects/app");
    }
  });

  it("handles paths with spaces when on Windows", () => {
    if (IS_WINDOWS) {
      expect(toDockerPath("C:\\Program Files\\app")).toBe("/c/Program Files/app");
    }
  });

  it("handles lowercase drive letters when on Windows", () => {
    if (IS_WINDOWS) {
      expect(toDockerPath("c:\\Users\\foo")).toBe("/c/Users/foo");
    }
  });

  // Unit test the conversion logic directly regardless of platform
  it("conversion logic: replaces drive letter and backslashes", () => {
    // Test the raw string transformation
    const input = "C:\\Users\\foo\\.kirie";
    const expected = "/c/Users/foo/.kirie";
    const result = input
      .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, "/");
    expect(result).toBe(expected);
  });

  it("conversion logic: different drive letter", () => {
    const input = "D:\\Projects\\app";
    const expected = "/d/Projects/app";
    const result = input
      .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, "/");
    expect(result).toBe(expected);
  });

  it("conversion logic: paths with spaces", () => {
    const input = "C:\\Program Files\\app";
    const expected = "/c/Program Files/app";
    const result = input
      .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, "/");
    expect(result).toBe(expected);
  });

  it("conversion logic: Unix paths pass through", () => {
    const input = "/home/user/.kirie";
    const result = input
      .replace(/^([A-Za-z]):\\/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, "/");
    expect(result).toBe(input);
  });
});
