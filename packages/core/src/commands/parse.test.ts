import { describe, it, expect } from "vitest";
import {
  formatDuration,
  parseCommandText,
  parseDuration,
  parseIntInRange,
  parseOnOff,
  splitCommandArgs,
} from "./parse.js";

describe("parseCommandText", () => {
  it("parses a bare command", () => {
    expect(parseCommandText("/help")).toEqual({ name: "help", args: "" });
  });

  it("lowercases the name and trims args", () => {
    expect(parseCommandText("/Goal   start  now  ")).toEqual({ name: "goal", args: "start  now" });
  });

  it("captures the @mention", () => {
    expect(parseCommandText("/status@Kirie_bot all")).toEqual({ name: "status", mention: "Kirie_bot", args: "all" });
  });

  it("accepts leading whitespace and multi-line args", () => {
    expect(parseCommandText("  /loop every 5m\ncheck the build\nand report")).toEqual({
      name: "loop",
      args: "every 5m\ncheck the build\nand report",
    });
  });

  it("rejects names over 32 chars", () => {
    expect(parseCommandText(`/${"a".repeat(33)}`)).toBeNull();
    expect(parseCommandText(`/${"a".repeat(32)}`)).not.toBeNull();
  });

  it("is null for plain text, a lone slash, or a path", () => {
    expect(parseCommandText("hello /help")).toBeNull();
    expect(parseCommandText("/")).toBeNull();
    expect(parseCommandText("/usr/bin/env")).toBeNull();
    expect(parseCommandText("")).toBeNull();
  });
});

describe("splitCommandArgs", () => {
  it("splits on whitespace", () => {
    expect(splitCommandArgs("a  b\tc\nd")).toEqual(["a", "b", "c", "d"]);
  });

  it("groups double and single quotes", () => {
    expect(splitCommandArgs(`add "fix the build" 'and test it' end`)).toEqual([
      "add",
      "fix the build",
      "and test it",
      "end",
    ]);
  });

  it("handles escapes and empty quotes", () => {
    expect(splitCommandArgs(`a\\ b "say \\"hi\\"" ''`)).toEqual(["a b", 'say "hi"', ""]);
  });

  it("runs an unterminated quote to the end", () => {
    expect(splitCommandArgs(`x "open ended`)).toEqual(["x", "open ended"]);
  });

  it("is empty for empty input", () => {
    expect(splitCommandArgs("   ")).toEqual([]);
  });
});

describe("parseDuration", () => {
  it.each([
    ["90s", 90_000],
    ["5m", 300_000],
    ["1h30m", 5_400_000],
    ["2d", 172_800_000],
    ["1w", 604_800_000],
    ["1H5M", 3_900_000],
  ])("parses %s", (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });

  it.each(["0", "0s", "0m0s", "-5m", "5", "abc", "5x", "m", "", "1.5h", "5m 3s"])("rejects %j", (text) => {
    expect(parseDuration(text)).toBeNull();
  });

  it("enforces min and max", () => {
    expect(parseDuration("30s", { minMs: 60_000 })).toBeNull();
    expect(parseDuration("2h", { maxMs: 3_600_000 })).toBeNull();
    expect(parseDuration("1h", { minMs: 60_000, maxMs: 3_600_000 })).toBe(3_600_000);
  });

  it("rejects absurd values", () => {
    expect(parseDuration(`${"9".repeat(30)}s`)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats compound durations", () => {
    expect(formatDuration(5_400_000)).toBe("1h30m");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("parseIntInRange", () => {
  it("accepts integers in range", () => {
    expect(parseIntInRange("5", 1, 10)).toBe(5);
    expect(parseIntInRange(" 10 ", 1, 10)).toBe(10);
    expect(parseIntInRange("-3", -5, 0)).toBe(-3);
  });

  it("rejects out of range, decimals and garbage", () => {
    expect(parseIntInRange("11", 1, 10)).toBeNull();
    expect(parseIntInRange("0", 1, 10)).toBeNull();
    expect(parseIntInRange("2.5", 1, 10)).toBeNull();
    expect(parseIntInRange("1e3", 1, 10_000)).toBeNull();
    expect(parseIntInRange("five", 1, 10)).toBeNull();
    expect(parseIntInRange("", 1, 10)).toBeNull();
  });
});

describe("parseOnOff", () => {
  it("maps the usual words", () => {
    expect(parseOnOff("on")).toBe(true);
    expect(parseOnOff("ENABLE")).toBe(true);
    expect(parseOnOff("off")).toBe(false);
    expect(parseOnOff("no")).toBe(false);
    expect(parseOnOff("maybe")).toBeNull();
  });
});
