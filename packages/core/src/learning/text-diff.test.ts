import { describe, it, expect } from "vitest";
import { unifiedLineDiff } from "./text-diff.js";

describe("unifiedLineDiff", () => {
  it("shows changed lines with context", () => {
    expect(unifiedLineDiff("a\nb\nc", "a\nB\nc")).toBe(" a\n-b\n+B\n c");
  });

  // LEARN-B3: a review must never stop at "too large to diff": the owner gets the complete resulting text.
  it("falls back to the complete new content when the diff is too large to compute", () => {
    const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join("\n");
    const after = `${Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n")}\nTAIL-MARKER`;
    const out = unifiedLineDiff(before, after);
    expect(out).toMatch(/too large to diff/);
    expect(out).toContain("complete new content follows");
    expect(out.endsWith(after)).toBe(true);
  });
});
