import { describe, it, expect } from "vitest";
import { KirieConfigSchema } from "../config/schema.js";
import { collectAttackSurface, collectSandboxFindings } from "./audit.js";

function sandbox(s: Record<string, unknown>) {
  return KirieConfigSchema.parse({ sandbox: s }).sandbox;
}

describe("security audit: sandbox findings", () => {
  it("off is one info finding that points at /sandbox", () => {
    const f = collectSandboxFindings(sandbox({}));
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("info");
    expect(f[0]!.remediation).toMatch(/\/sandbox native/);
    expect(collectAttackSurface(KirieConfigSchema.parse({})).some((x) => x.message.startsWith("Sandbox disabled"))).toBe(true);
  });

  it("native is recognised; defaults raise nothing", () => {
    expect(collectSandboxFindings(sandbox({ mode: "native" }))).toEqual([]);
  });

  it("native escape hatches are flagged", () => {
    const f = collectSandboxFindings(sandbox({ mode: "native", native: { allowUnsandboxed: true, excludedCommands: ["kubectl *"], allowUnixSockets: ["/var/run/docker.sock"] } }));
    expect(f.filter((x) => x.severity === "warning")).toHaveLength(2);
    expect(f.some((x) => x.message.includes("excludedCommands"))).toBe(true);
  });

  it("docker defaults raise nothing; bridge and ignored weakening are info", () => {
    expect(collectSandboxFindings(sandbox({ mode: "docker" }))).toEqual([]);
    const f = collectSandboxFindings(sandbox({ mode: "docker", docker: { network: "bridge", readOnlyRoot: false } }));
    expect(f.map((x) => x.severity)).toEqual(["info", "info"]);
  });
});
