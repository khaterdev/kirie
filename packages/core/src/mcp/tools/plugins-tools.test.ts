import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPluginsTools } from "./plugins-tools.js";
import { PluginApprovalStore, pluginApprovalsPath } from "../../plugins/approvals.js";
import { inspectPluginTree } from "../../plugins/integrity.js";
import { makePluginSandbox, writePlugin, type PluginSandbox } from "../../plugins/fixture.test-util.js";

let sb: PluginSandbox;
beforeEach(() => { sb = makePluginSandbox(); });
afterEach(() => sb.cleanup());

describe("plugins_list", () => {
  it("exists as the only plugin tool, takes no parameters, and the factory touches nothing", () => {
    const tools = createPluginsTools({ dbDir: "/nonexistent-kirie-dir", env: {} });
    expect(Object.keys(tools)).toEqual(["plugins_list"]);
    expect(tools.plugins_list!.parameters.properties).toEqual({});
  });

  it("lists approved, enabled and changed state without importing anything", async () => {
    const dir = writePlugin(sb.pluginsDir, "a", {
      code: `globalThis.__kirieToolImported = true; export default () => ({ name: "a", version: "1.0.0" });`,
    });
    writePlugin(sb.pluginsDir, "b", { version: "2.0.0" });
    const store = new PluginApprovalStore(pluginApprovalsPath(sb.dataDir));
    store.upsert({
      name: "a", version: "1.0.0", sha256: inspectPluginTree(sb.pluginsDir, "a").sha256, capabilities: ["hooks:observe"],
      events: ["afterMessage"], enabled: true, approvedAt: "2026-11-23T00:00:00.000Z", approvedBy: "owner:telegram:1",
    });
    const tool = createPluginsTools({ dbDir: sb.dataDir, env: {} }).plugins_list!;
    const out = (await tool.handler({})) as { plugins: Array<Record<string, unknown>> };
    expect(out.plugins).toEqual([
      expect.objectContaining({ name: "a", approved: true, enabled: true, changed: false, version: "1.0.0" }),
      expect.objectContaining({ name: "b", approved: false, enabled: false, version: "2.0.0" }),
    ]);
    writeFileSync(join(dir, "index.js"), "// edited\n");
    const again = (await tool.handler({})) as { plugins: Array<Record<string, unknown>> };
    expect(again.plugins[0]).toMatchObject({ name: "a", changed: true });
    expect((globalThis as { __kirieToolImported?: boolean }).__kirieToolImported).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/sha256|approvedBy/);
  });

  it("honours KIRIE_PLUGINS_DIR and never writes the approvals file", async () => {
    const other = join(sb.dataDir, "elsewhere");
    writePlugin(other, "c");
    const tool = createPluginsTools({ dbDir: sb.dataDir, env: { KIRIE_PLUGINS_DIR: other } }).plugins_list!;
    const out = (await tool.handler({})) as { pluginsDir: string; plugins: Array<{ name: string }> };
    expect(out.pluginsDir).toBe(other);
    expect(out.plugins.map((p) => p.name)).toEqual(["c"]);
    expect(new PluginApprovalStore(pluginApprovalsPath(sb.dataDir)).list()).toEqual([]);
  });
});
