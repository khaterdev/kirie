import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import { runSandboxNativeProbe } from "./native-probe.js";
import { SdkOptionsPipeline, type SdkCallContext } from "../engine/sdk-options.js";

/** Extract the touch targets from the probe command. */
function targets(prompt: string): string[] {
  return [...prompt.matchAll(/touch '([^']+)'/g)].map((m) => m[1]!);
}

type Behaviour = "sandboxed" | "leaky" | "nothing" | "error";

function fakeQuery(behaviour: Behaviour, seen: { options?: Options; prompt?: string }) {
  return vi.fn(({ prompt, options }: { prompt: string; options: Options }) => {
    seen.options = options;
    seen.prompt = prompt;
    const t = targets(prompt);
    async function* gen() {
      if (behaviour === "sandboxed") writeFileSync(t[0]!, ""); // only the write inside the cwd succeeds
      if (behaviour === "leaky") {
        for (const f of t) {
          try {
            mkdirSync(dirname(f), { recursive: true });
            writeFileSync(f, "");
          } catch {
            // case variant on a case-insensitive disk lands in the existing folder
          }
        }
      }
      yield behaviour === "error"
        ? { type: "result", subtype: "error_during_execution", is_error: true, result: "sandbox unavailable: missing dependency" }
        : { type: "result", subtype: "success", is_error: false, result: "DONE" };
    }
    const it = gen();
    return Object.assign(it, { close: vi.fn() }) as unknown as Query;
  });
}

describe("native self-test", () => {
  let dataDir: string;
  const build = vi.fn((cwd: string, extra: readonly string[]) => ({ enabled: true, failIfUnavailable: true, filesystem: { allowWrite: ["/tmp"], denyWrite: [...extra], denyRead: [] }, cwd }));

  beforeEach(() => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), "kirie-sbx-probe-")));
    build.mockClear();
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("passes when only the write inside succeeds; reads the disk, not the reply", async () => {
    const seen: { options?: Options; prompt?: string } = {};
    const r = await runSandboxNativeProbe({ dataDir, model: "claude-haiku-4-5", buildSettings: build, query: fakeQuery("sandboxed", seen) });
    expect(r).toEqual({ ok: true, observed: { inside: true, outside: false, denied: false, caseVariant: false, symlink: false } });
    const o = seen.options!;
    expect(o.tools).toEqual(["Bash"]);
    expect(o.mcpServers).toEqual({});
    expect(o.strictMcpConfig).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.persistSession).toBe(false);
    expect(o.maxBudgetUsd).toBe(0.05);
    expect(o.model).toBe("claude-haiku-4-5");
    expect(o.cwd!.startsWith(join(dataDir, "tmp", "sandbox-probe"))).toBe(true);
    expect(build).toHaveBeenCalledWith(o.cwd, [join(o.cwd!, "protected")]);
    expect(o.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    // Everything the probe touches is inside its own folder, which is removed afterwards.
    for (const t of targets(seen.prompt!)) expect(t.startsWith(join(dataDir, "tmp", "sandbox-probe"))).toBe(true);
    expect(existsSync(dirname(o.cwd!))).toBe(false);
  });

  it("refuses when any write that should fail succeeded", async () => {
    const r = await runSandboxNativeProbe({ dataDir, model: "m", buildSettings: build, query: fakeQuery("leaky", {}) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/outside the allowed folders/);
    expect(r.reason).toMatch(/protected folder/);
    expect(r.reason).toMatch(/symlink/);
  });

  it("refuses when the command did not run, with the SDK's reason", async () => {
    const r = await runSandboxNativeProbe({ dataDir, model: "m", buildSettings: build, query: fakeQuery("error", {}) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/did not run.*sandbox unavailable/);
    const r2 = await runSandboxNativeProbe({ dataDir, model: "m", buildSettings: build, query: fakeQuery("nothing", {}) });
    expect(r2.reason).toMatch(/did not run/);
  });

  it("refuses on a timeout and closes the query", async () => {
    const close = vi.fn();
    const query = vi.fn(() => {
      async function* gen() {
        await new Promise(() => {});
      }
      return Object.assign(gen(), { close }) as unknown as Query;
    });
    const r = await runSandboxNativeProbe({ dataDir, model: "m", buildSettings: build, query, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, reason: "the self-test turn did not finish in time" });
    expect(close).toHaveBeenCalled();
  });

  it("goes through the options pipeline as a utility call", async () => {
    const pipeline = new SdkOptionsPipeline();
    const kinds: string[] = [];
    pipeline.registerContributor("account-env", (_o, c: SdkCallContext) => { kinds.push(c.kind); }, 20);
    const seen: { options?: Options } = {};
    await runSandboxNativeProbe({ dataDir, model: "m", buildSettings: build, query: fakeQuery("sandboxed", seen), sdkOptions: pipeline });
    expect(kinds).toEqual(["utility"]);
    expect(seen.options!.hooks?.PreToolUse).toHaveLength(1);
  });
});
