import { describe, it, expect } from "vitest";
import { KirieConfigSchema } from "../config/schema.js";
import { collectAttackSurface } from "./audit.js";

function config(approvals: Record<string, unknown>) {
  return KirieConfigSchema.parse({ approvals });
}

describe("security audit: approval gate findings", () => {
  it("yolo mode is an info finding", () => {
    const f = collectAttackSurface(config({})).filter((x) => x.message.includes("Approval gate"));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.message).toContain("yolo");
  });

  it("ask mode with hardline on has no approval finding", () => {
    expect(collectAttackSurface(config({ mode: "ask" })).filter((x) => x.message.toLowerCase().includes("approval"))).toEqual([]);
  });

  it("hardline off and the gate disabled are warnings", () => {
    expect(collectAttackSurface(config({ mode: "ask", hardline: false })).some((x) => x.severity === "warning" && x.message.includes("hardline"))).toBe(true);
    expect(collectAttackSurface(config({ enabled: false })).some((x) => x.severity === "warning" && x.message.includes("disabled"))).toBe(true);
  });
});
