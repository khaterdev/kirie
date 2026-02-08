import { describe, it, expect } from "vitest";
import { makeSenderId, makeDisplayName } from "./auth.js";

describe("Telegram auth", () => {
  describe("makeSenderId", () => {
    it("converts numeric user ID to string", () => {
      expect(makeSenderId(123456789)).toBe("123456789");
    });

    it("handles zero", () => {
      expect(makeSenderId(0)).toBe("0");
    });
  });

  describe("makeDisplayName", () => {
    it("returns first + last name when both are present", () => {
      expect(makeDisplayName("John", "Doe", "johndoe")).toBe("John Doe");
    });

    it("returns first name only when last name is absent", () => {
      expect(makeDisplayName("John", undefined, "johndoe")).toBe("John");
    });

    it("returns @username when first name is empty string", () => {
      expect(makeDisplayName("", undefined, "johndoe")).toBe("@johndoe");
    });

    it("returns 'Unknown' when all fields are absent", () => {
      expect(makeDisplayName("", undefined, undefined)).toBe("Unknown");
    });

    it("prefers first+last over username", () => {
      expect(makeDisplayName("Alice", "Smith", "asmith")).toBe("Alice Smith");
    });

    it("prefers first name over username when last name is missing", () => {
      expect(makeDisplayName("Alice", undefined, "asmith")).toBe("Alice");
    });
  });
});
