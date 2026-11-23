import { describe, it, expect } from "vitest";
import { KirieConfigSchema } from "../schema.js";
import { UserModelConfigSchema } from "./usermodel.js";

describe("userModel config", () => {
  it("is off by default, with no per-fact approval and no remote embeddings", () => {
    const cfg = UserModelConfigSchema.parse(undefined);
    expect(cfg).toMatchObject({
      enabled: false,
      inject: true,
      injectBackground: false,
      requireApproval: false,
      allowRemoteEmbeddings: false,
      promptBudgetChars: 1500,
    });
    expect(cfg.model).toBeUndefined();
    expect(cfg.excludeCategories).toEqual(expect.arrayContaining(["health", "finances", "credentials", "home_address", "third_party_private"]));
  });

  it("an empty root config yields the same defaults", () => {
    expect(KirieConfigSchema.parse({}).userModel.enabled).toBe(false);
  });

  it("has no key that skips the sensitive filter or approves facts automatically", () => {
    const keys = Object.keys(UserModelConfigSchema.parse({}));
    expect(keys.filter((k) => /auto.?approve|skip|unsafe|allowSensitive/i.test(k))).toEqual([]);
  });
});
