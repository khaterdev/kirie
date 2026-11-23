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

/** Factories whose stub has been replaced; each is covered by its own test file. */
const FILLED_FACTORIES = new Set(["createAccountsTools", "createGoalsTools", "createLearningTools", "createLoopsTools", "createPluginsTools", "createSecretsTools", "createWebhooksTools"]);

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

  it("the stubs register nothing and do no I/O when called", () => {
    const stubs = FEATURE_TOOL_FACTORIES.filter((f) => !FILLED_FACTORIES.has(f.name));
    for (const factory of stubs) {
      expect(factory(ctx), factory.name).toEqual({});
    }
    // Filled factories are tested in their own files; here: they too do no I/O when called.
    for (const factory of FEATURE_TOOL_FACTORIES) factory(ctx);
    const filled = FEATURE_TOOL_FACTORIES.filter((f) => FILLED_FACTORIES.has(f.name)).flatMap((f) => Object.keys(f(ctx)));
    expect(featureToolNames(ctx)).toEqual(filled);
    let registered = 0;
    registerFeatureTools((h) => { registered += Object.keys(h).length; }, ctx);
    expect(registered).toBe(filled.length);
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
