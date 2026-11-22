/**
 * Opt-in live checks of the SDK options seam against the real Agent SDK.
 *
 * Skipped unless KIRIE_SDK_PROBE=1. Spends a few tiny model turns on the
 * default account (model: KIRIE_SDK_PROBE_MODEL, default claude-haiku-4-5).
 * Runs in a fresh temp directory with no settings sources and no persisted
 * transcript; the only command the model is asked to run is `touch <marker>`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline, installCanUseToolWarningFilter, type SdkCallContext } from "./sdk-options.js";

const enabled = process.env.KIRIE_SDK_PROBE === "1";
const model = process.env.KIRIE_SDK_PROBE_MODEL ?? "claude-haiku-4-5";

async function run(prompt: string, options: Options): Promise<void> {
  for await (const msg of query({ prompt, options })) {
    if (msg.type === "result") break;
  }
}

describe.skipIf(!enabled)("SdkOptionsPipeline against the live SDK (KIRIE_SDK_PROBE=1)", () => {
  let cwd: string;
  let ctx: SdkCallContext;

  beforeEach(() => {
    installCanUseToolWarningFilter();
    cwd = mkdtempSync(join(tmpdir(), "kirie-sdk-probe-"));
    ctx = { kind: "chat", ownerDm: true, interactive: true, label: "probe", cwd };
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function baseOptions(): Options {
    return {
      model,
      cwd,
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash"],
      settingSources: [],
      persistSession: false,
      maxTurns: 4,
      maxBudgetUsd: 0.05,
    };
  }

  const ask = (marker: string) => `Run exactly this shell command with your Bash tool, then reply DONE: touch ${marker}`;

  it("with only the built-in gates the tool call runs unchanged", async () => {
    const pipeline = new SdkOptionsPipeline();
    await run(ask("allowed_marker"), pipeline.apply(baseOptions(), ctx));
    expect(existsSync(join(cwd, "allowed_marker"))).toBe(true);
  }, 120_000);

  it("a deny from a gate blocks the call under bypassPermissions", async () => {
    const pipeline = new SdkOptionsPipeline();
    pipeline.registerGate({ name: "approvals", order: 900, check: (c) => (c.tool === "Bash" ? { decision: "deny", reason: "blocked by probe" } : { decision: "pass" }) });
    await run(ask("denied_marker"), pipeline.apply(baseOptions(), ctx));
    expect(existsSync(join(cwd, "denied_marker"))).toBe(false);
  }, 120_000);

  it("an ask reaches canUseTool with a string prompt, and a refusal blocks the call", async () => {
    const pipeline = new SdkOptionsPipeline();
    let resolved = 0;
    pipeline.registerGate({
      name: "approvals",
      order: 900,
      check: (c) =>
        c.tool === "Bash"
          ? {
              decision: "ask",
              summary: "probe asks",
              resolve: async () => {
                resolved += 1;
                return { approved: false, reason: "refused by probe" };
              },
            }
          : { decision: "pass" },
    });
    await run(ask("asked_marker"), pipeline.apply(baseOptions(), ctx));
    expect(resolved).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "asked_marker"))).toBe(false);
  }, 120_000);
});
