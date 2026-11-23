import { describe, it, expect } from "vitest";
import { parsePluginManifest, PluginManifestError } from "./manifest.js";

const ok = (over: Record<string, unknown> = {}, kirie: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo", version: "1.2.3", kirie: { events: ["afterMessage"], ...kirie }, ...over });

describe("parsePluginManifest", () => {
  it("parses a minimal manifest with defaults", () => {
    expect(parsePluginManifest(ok(), "demo")).toEqual({
      name: "demo", version: "1.2.3", entry: "index.js", events: ["afterMessage"], capabilities: ["hooks:observe"],
    });
  });

  it("always includes hooks:observe and dedupes", () => {
    const m = parsePluginManifest(ok({}, { events: ["beforeMessage", "beforeMessage"], capabilities: ["hooks:transform-message"] }), "demo");
    expect(m.capabilities).toEqual(["hooks:observe", "hooks:transform-message"]);
    expect(m.events).toEqual(["beforeMessage"]);
  });

  it("strips a leading ./ from the entry", () => {
    expect(parsePluginManifest(ok({}, { entry: "./dist/main.mjs" }), "demo").entry).toBe("dist/main.mjs");
  });

  it.each([
    ["not JSON", "{", /not valid JSON/],
    ["name mismatch", ok({ name: "other" }), /does not match the directory/],
    ["invalid name", ok({ name: "Demo" }), /not a valid plugin name/],
    ["missing kirie block", JSON.stringify({ name: "demo", version: "1.0.0" }), /kirie/],
    ["missing events", JSON.stringify({ name: "demo", version: "1.0.0", kirie: {} }), /events/],
    ["empty events", ok({}, { events: [] }), /events/],
    ["unknown event", ok({}, { events: ["onBoot"] }), /events/],
    ["unknown capability", ok({}, { capabilities: ["hooks:tool-intercept"] }), /capabilities/],
    ["absolute entry", ok({}, { entry: "/etc/x.js" }), /relative/],
    ["traversal entry", ok({}, { entry: "../x.js" }), /inside/],
    ["non-js entry", ok({}, { entry: "index.ts" }), /\.js/],
    ["entry with query", ok({}, { entry: "x?.js" }), /plain file path/],
    ["bad version", ok({ version: "1.0 beta" }), /version/],
    ["transform without beforeMessage", ok({}, { capabilities: ["hooks:transform-message"] }), /needs beforeMessage/],
  ])("rejects %s", (_label, raw, re) => {
    expect(() => parsePluginManifest(raw as string, "demo")).toThrow(PluginManifestError);
    expect(() => parsePluginManifest(raw as string, "demo")).toThrow(re);
  });

  it("rejects an oversized manifest", () => {
    expect(() => parsePluginManifest(ok({ description: "x".repeat(70_000) }), "demo")).toThrow(/64 KB/);
  });
});
