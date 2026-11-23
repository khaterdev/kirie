import { describe, it, expect } from "vitest";
import { isValidModelId, parseModelList, remedyFor, resolveFallbackChain, sdkFallbackArg } from "./model-chain.js";

describe("model chain", () => {
  it("de-duplicates, drops the primary and invalid ids, and caps at four", () => {
    expect(resolveFallbackChain("opus", ["sonnet", "opus", "sonnet", "bad id", "haiku", "a", "b", "c"])).toEqual(["sonnet", "haiku", "a", "b"]);
  });

  it("sdkFallbackArg is undefined for an empty chain and never contains the primary", () => {
    expect(sdkFallbackArg("opus", [])).toBeUndefined();
    expect(sdkFallbackArg("opus", ["opus"])).toBeUndefined();
    expect(sdkFallbackArg("claude-opus-5-5[1m]", ["claude-opus-5-5[1m]", "claude-sonnet-5-5", "claude-haiku-5-5"])).toBe(
      "claude-sonnet-5-5,claude-haiku-5-5",
    );
  });

  it("validates model ids", () => {
    expect(isValidModelId("claude-opus-5-5[1m]")).toBe(true);
    expect(isValidModelId("us.anthropic.claude:1")).toBe(true);
    expect(isValidModelId("x; rm -rf /")).toBe(false);
    expect(isValidModelId("a".repeat(65))).toBe(false);
  });

  it("parses comma or space separated lists", () => {
    expect(parseModelList("sonnet, haiku haiku")).toEqual({ models: ["sonnet", "haiku"], invalid: [] });
    expect(parseModelList("sonnet,$(x)")).toEqual({ models: ["sonnet"], invalid: ["$(x)"] });
  });

  it("maps failure classes to the pointer they move (DECISIONS 11)", () => {
    expect(remedyFor("usage_limit_account")).toBe("next_account");
    expect(remedyFor("auth")).toBe("next_account");
    expect(remedyFor("usage_limit_model")).toBe("next_account_then_model");
    expect(remedyFor("model_unavailable")).toBe("next_model");
    expect(remedyFor("overloaded")).toBe("next_model");
    expect(remedyFor("prompt_too_long")).toBe("stop");
    expect(remedyFor("network")).toBe("stop");
    expect(remedyFor("unknown")).toBe("stop");
  });
});
