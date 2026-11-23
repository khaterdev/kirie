import { describe, it, expect } from "vitest";
import { isLegacyPluginsConfig, PluginsConfigSchema } from "./plugins.js";

describe("plugins config section", () => {
  it("is off by default with the hash pin on", () => {
    expect(PluginsConfigSchema.parse(undefined)).toEqual({
      enabled: false,
      dir: "~/.kirie/plugins",
      allow: [],
      config: {},
      hookTimeoutMs: 2000,
      loadTimeoutMs: 10_000,
      maxConsecutiveFailures: 5,
      maxQueuedEventsPerPlugin: 100,
      scrubEventPayloads: true,
      requireHashPin: true,
    });
  });

  it("neutralises the legacy array form to enabled: false", () => {
    const legacy = [{ package: "some-npm-package", enabled: true, config: {} }];
    expect(isLegacyPluginsConfig(legacy)).toBe(true);
    expect(PluginsConfigSchema.parse(legacy)).toMatchObject({ enabled: false, allow: [] });
  });

  it("rejects invalid names in allow", () => {
    expect(() => PluginsConfigSchema.parse({ allow: ["../x"] })).toThrow();
    expect(() => PluginsConfigSchema.parse({ allow: ["Upper"] })).toThrow();
    expect(PluginsConfigSchema.parse({ allow: ["reply-timer"] })).toMatchObject({ allow: ["reply-timer"] });
  });
});
