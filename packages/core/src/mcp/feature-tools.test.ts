import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FEATURE_TOOL_FACTORIES,
  collectFeatureTools,
  featureToolNames,
  registerFeatureTools,
  type FeatureToolContext,
  type FeatureToolFactory,
} from "./feature-tools.js";
import type { McpToolDefinition } from "./server.js";

const ctx: FeatureToolContext = {
  dbDir: join(tmpdir(), `kirie-feature-tools-never-created-${process.pid}`),
  gatewayUrl: "http://127.0.0.1:1",
  env: {},
};

function tool(description: string): McpToolDefinition {
  return { description, parameters: { type: "object", properties: {} }, handler: () => ({ ok: true }) };
}

describe("feature tool seam", () => {
  it("has one factory per feature that has tools", () => {
    expect(FEATURE_TOOL_FACTORIES.map((f) => f.name)).toEqual([
      "createAccountsTools", "createLearningTools", "createCuratorTools", "createUserModelTools",
      "createGoalsTools", "createLoopsTools", "createWebhooksTools", "createApprovalsTools",
      "createSecretsTools", "createSandboxTools", "createPluginsTools", "createComputerUseTools",
      "createVoiceTools",
    ]);
  });

  it("the stubs register nothing, filled factories only their own tools, and none do I/O when called", () => {
    // Factories already filled in by their workstreams, and the tools they define.
    const filled: Record<string, string[]> = { createPluginsTools: ["plugins_list"] };
    for (const factory of FEATURE_TOOL_FACTORIES) {
      expect(Object.keys(factory(ctx)), factory.name).toEqual(filled[factory.name] ?? []);
    }
    expect(featureToolNames(ctx)).toEqual(Object.values(filled).flat());
    const registered: string[] = [];
    registerFeatureTools((h) => { registered.push(...Object.keys(h)); }, ctx);
    expect(registered).toEqual(Object.values(filled).flat());
    expect(existsSync(ctx.dbDir)).toBe(false);
  });

  it("collects tools, skips a throwing factory, invalid names and duplicates", () => {
    const a: FeatureToolFactory = () => ({ demo_status: tool("a"), "Bad-Name": tool("bad") });
    const boom: FeatureToolFactory = () => { throw new Error("boom"); };
    const b: FeatureToolFactory = () => ({ demo_status: tool("b"), demo_list: tool("c") });
    const out = collectFeatureTools(ctx, [a, boom, b]);
    expect(Object.keys(out)).toEqual(["demo_status", "demo_list"]);
    expect(out.demo_status!.description).toBe("a");
    expect(featureToolNames(ctx, [a, boom, b])).toEqual(["demo_status", "demo_list"]);
  });

  it("factories see the env flags so a tool can exist only when its feature is on", () => {
    const sandbox: FeatureToolFactory = (c) => {
      const out: Record<string, McpToolDefinition> = {};
      if (c.env.KIRIE_SANDBOX_MODE === "docker") out.sandbox_bash = tool("x");
      return out;
    };
    expect(featureToolNames(ctx, [sandbox])).toEqual([]);
    expect(featureToolNames({ ...ctx, env: { KIRIE_SANDBOX_MODE: "docker" } }, [sandbox])).toEqual(["sandbox_bash"]);
  });
});
