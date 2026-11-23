import { describe, it, expect } from "vitest";
import { ApprovalsConfigSchema } from "./approvals.js";

describe("approvals config section", () => {
  it("defaults: on, yolo, dangerous scope, hardline on, 5-minute timeout, ask when unattended", () => {
    expect(ApprovalsConfigSchema.parse(undefined)).toEqual({
      enabled: true, mode: "yolo", askScope: "dangerous", hardline: true, allow: [], deny: [], timeoutSeconds: 300,
      unattended: "ask", inlineCode: "ask", maxPending: 5, redenyWindowSeconds: 600, maxDenialsPerTurn: 3, mcpAsk: [],
      protectedWritePaths: [], protectedReadPaths: [], disabledRules: [],
    });
  });

  it("hardline can be turned off to restore exact current behaviour", () => {
    expect(ApprovalsConfigSchema.parse({ hardline: false }).hardline).toBe(false);
  });

  it("rejects unknown modes and out-of-range timeouts", () => {
    expect(() => ApprovalsConfigSchema.parse({ mode: "off" })).toThrow();
    expect(() => ApprovalsConfigSchema.parse({ timeoutSeconds: 5 })).toThrow();
    expect(() => ApprovalsConfigSchema.parse({ allow: ["x".repeat(201)] })).toThrow();
  });
});
