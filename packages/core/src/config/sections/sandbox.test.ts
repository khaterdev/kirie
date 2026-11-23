import { describe, it, expect } from "vitest";
import { SandboxConfigSchema } from "./sandbox.js";
import { KirieConfigSchema } from "../schema.js";

describe("sandbox config section", () => {
  it("defaults to off with the hardened docker defaults", () => {
    const s = KirieConfigSchema.parse({}).sandbox;
    expect(s.mode).toBe("off");
    expect(s.scope).toBe("shared");
    expect(s.native).toEqual({ allowWrite: [], allowedDomains: [], allowUnixSockets: [], excludedCommands: [], allowUnsandboxed: false });
    expect(s.docker).toMatchObject({
      image: "kirie-sandbox:latest",
      workspaceDir: "~/.kirie/sandbox-workspace",
      network: "none",
      readOnlyRoot: true,
      capDrop: ["ALL"],
      pidsLimit: 256,
      execTimeoutSeconds: 120,
      stopOnShutdown: true,
    });
    expect(s.docker.binary).toBeUndefined();
  });

  it("rejects network host and out-of-range limits", () => {
    expect(() => SandboxConfigSchema.parse({ docker: { network: "host" } })).toThrow();
    expect(() => SandboxConfigSchema.parse({ docker: { execTimeoutSeconds: 601 } })).toThrow();
    expect(() => SandboxConfigSchema.parse({ mode: "vm" })).toThrow();
  });

  it("drops the old keys", () => {
    const s = SandboxConfigSchema.parse({ workspaceAccess: "rw", prune: { idleHours: 1 } }) as Record<string, unknown>;
    expect("workspaceAccess" in s).toBe(false);
    expect("prune" in s).toBe(false);
  });
});
