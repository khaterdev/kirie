import { describe, it, expect } from "vitest";
import { LearningConfigSchema } from "./learning.js";

describe("learning config section", () => {
  it("reflection is off, memory writes stay direct, the skill guard enforces", () => {
    const cfg = LearningConfigSchema.parse(undefined);
    expect(cfg.enabled).toBe(false);
    expect(cfg.memoryPolicy).toBe("direct");
    expect(cfg.skillWriteGuard).toBe("enforce");
    expect(cfg.allowUntrustedSkillProposals).toBe(false);
    expect(cfg.maxPending).toBe(20);
    expect(cfg.expiryDays).toBe(14);
    expect(cfg.model).toBeUndefined();
  });

  it("has no key that could auto-approve anything", () => {
    const keys = Object.keys(LearningConfigSchema.parse({}));
    expect(keys.filter((k) => /approv|auto|apply/i.test(k))).toEqual([]);
  });
});
