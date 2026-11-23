import { describe, it, expect, vi, afterEach } from "vitest";
import { ACCOUNTS_AGENT_TOOLS_ENV, createAccountsTools } from "./accounts-tools.js";

const ctx = (mode?: string) => ({
  dbDir: "/nonexistent",
  gatewayUrl: "http://127.0.0.1:1",
  env: mode ? { [ACCOUNTS_AGENT_TOOLS_ENV]: mode } : {},
});

describe("accounts MCP tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers nothing without the feature's env flag, with 'off', or without a gateway", () => {
    expect(createAccountsTools(ctx())).toEqual({});
    expect(createAccountsTools(ctx("off"))).toEqual({});
    expect(createAccountsTools({ dbDir: "/nonexistent", env: { [ACCOUNTS_AGENT_TOOLS_ENV]: "manage" } })).toEqual({});
  });

  it("'read' exposes list and discover; 'manage' adds the bounded writes and import", () => {
    expect(Object.keys(createAccountsTools(ctx("read")))).toEqual(["accounts_list", "accounts_discover"]);
    expect(Object.keys(createAccountsTools(ctx("manage"))).sort()).toEqual([
      "accounts_discover", "accounts_import", "accounts_list", "accounts_reset", "accounts_set_enabled", "accounts_set_rotation", "accounts_use",
    ]);
  });

  it("the factory is pure and no tool removes an account or changes the fallback chain", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const tools = createAccountsTools(ctx("manage"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Object.keys(tools).some((n) => /remove|fallback|delete/.test(n))).toBe(false);
  });

  it("handlers proxy to /api/accounts with the session key", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const tools = createAccountsTools(ctx("manage"));
    await tools.accounts_list!.handler({});
    await tools.accounts_use!.handler({ id: "claude2", session_key: "telegram:dm:1" });
    await tools.accounts_import!.handler({ config_dir: "~/.claude3" });
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map((c) => [c[1].method, c[0]])).toEqual([
      ["GET", "http://127.0.0.1:1/api/accounts/"],
      ["POST", "http://127.0.0.1:1/api/accounts/claude2/use"],
      ["POST", "http://127.0.0.1:1/api/accounts/import"],
    ]);
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ session_key: "telegram:dm:1" });
  });

  it("a daemon that does not answer gives an error object, not a throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const out = await createAccountsTools(ctx("read")).accounts_list!.handler({});
    expect(out).toMatchObject({ error: expect.stringContaining("did not answer") });
  });
});
