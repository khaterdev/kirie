import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { createAccountVerifier } from "./account-verify.js";
import { SdkOptionsPipeline, type SdkCallContext } from "../engine/sdk-options.js";

function fakeQuery(info: Promise<Record<string, unknown>>) {
  const close = vi.fn();
  const calls: Array<{ options: Record<string, unknown> }> = [];
  const run = vi.fn(({ options }: { options: Record<string, unknown> }) => {
    calls.push({ options });
    const stream = (async function* () {})();
    return Object.assign(stream, { accountInfo: () => info, close });
  });
  return { run, close, calls };
}

describe("account verifier (accountInfo, zero quota)", () => {
  it("passes with an email: masked label and subscription; env is the account's, nothing persisted", async () => {
    const q = fakeQuery(Promise.resolve({ email: "someone@example.invalid", subscriptionType: "Claude Max", tokenSource: "keychain" }));
    const verify = createAccountVerifier({ cwd: "/tmp", query: q.run as never, baseEnv: () => ({ PATH: "/bin", ANTHROPIC_API_KEY: ["x", "y"].join("") }) });
    const res = await verify({ kind: "config_dir", configDir: "/home/test/.claude2" });
    expect(res).toEqual({ ok: true, label: "so***@example.invalid", subscription: "Claude Max" });
    const opts = q.calls[0]!.options as { env: Record<string, string>; settingSources: unknown[]; persistSession: boolean };
    expect(opts.env.CLAUDE_CONFIG_DIR).toBe("/home/test/.claude2");
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(opts.settingSources).toEqual([]);
    expect(opts.persistSession).toBe(false);
    expect(q.close).toHaveBeenCalled();
  });

  it("no email or tokenSource none means not logged in", async () => {
    const verify = createAccountVerifier({ cwd: "/tmp", query: fakeQuery(Promise.resolve({ tokenSource: "none" })).run as never });
    expect(await verify({ kind: "default", configDir: null })).toEqual({ ok: false, reason: "not_logged_in" });
  });

  it("a timeout means the login is not readable from the daemon", async () => {
    const q = fakeQuery(new Promise(() => {}));
    const verify = createAccountVerifier({ cwd: "/tmp", query: q.run as never, timeoutMs: 20 });
    expect(await verify({ kind: "default", configDir: null })).toEqual({ ok: false, reason: "timeout" });
    expect(q.close).toHaveBeenCalled();
  });

  it("runs through the SDK options seam as a utility call", async () => {
    const sdkOptions = new SdkOptionsPipeline();
    const seen: SdkCallContext[] = [];
    sdkOptions.registerContributor("account-env", (_o, c) => void seen.push(c), 20);
    const verify = createAccountVerifier({ cwd: "/tmp", sdkOptions, query: fakeQuery(Promise.resolve({ email: "a@b.invalid" })).run as never });
    await verify({ kind: "default", configDir: null });
    expect(seen.map((c) => c.kind)).toEqual(["utility"]);
  });
});
