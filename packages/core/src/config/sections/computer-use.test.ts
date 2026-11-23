import { describe, it, expect } from "vitest";
import { ComputerUseConfigSchema } from "./computer-use.js";

describe("computerUse config", () => {
  it("ships off, per-app approval, window-only screenshots, 15/60 minute windows", () => {
    const cfg = ComputerUseConfigSchema.parse(undefined);
    expect(cfg).toMatchObject({
      enabled: false, approval: "per-app", screenshots: "window", armMinutes: 15, maxArmMinutes: 60,
      requireSignedDriver: true, driverPath: "~/.local/bin/cua-driver", allowedApps: [],
    });
    expect(cfg.deniedApps).toContain("com.1password.1password");
    expect(cfg.deniedApps).toContain("com.apple.systempreferences");
    expect(cfg.observeOnlyApps).toContain("com.apple.Safari");
    expect(cfg.noTypingApps).toContain("com.apple.Terminal");
    expect(cfg.blockedHotkeys).toContain("cmd+shift+q");
  });

  it("rejects unknown enum values", () => {
    expect(ComputerUseConfigSchema.safeParse({ approval: "never" }).success).toBe(false);
    expect(ComputerUseConfigSchema.safeParse({ screenshots: "full" }).success).toBe(false);
    expect(ComputerUseConfigSchema.safeParse({ armMinutes: 0 }).success).toBe(false);
  });
});
