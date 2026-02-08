import { describe, it, expect } from "vitest";
import { makeSenderId, makeDisplayName } from "./auth.js";

describe("Slack auth", () => {
  describe("makeSenderId", () => {
    it("returns the user ID as-is", () => {
      expect(makeSenderId("U12345")).toBe("U12345");
    });
  });

  describe("makeDisplayName", () => {
    it("prefers displayName over realName and username", () => {
      expect(makeDisplayName("Real Name", "Display Name", "username")).toBe("Display Name");
    });

    it("falls back to realName when displayName is absent", () => {
      expect(makeDisplayName("Real Name", undefined, "username")).toBe("Real Name");
    });

    it("falls back to username when both are absent", () => {
      expect(makeDisplayName(undefined, undefined, "username")).toBe("username");
    });

    it("returns 'Unknown' when all fields are absent", () => {
      expect(makeDisplayName(undefined, undefined, undefined)).toBe("Unknown");
    });

    it("prefers displayName even when it is empty string (falsy)", () => {
      // empty string is falsy, so falls through
      expect(makeDisplayName("Real", "", "user")).toBe("Real");
    });
  });
});
