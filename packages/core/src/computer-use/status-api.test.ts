import { describe, it, expect, vi, afterEach } from "vitest";
import { ComputerUseConfigSchema } from "../config/sections/computer-use.js";
import { createComputerUseTools } from "../mcp/tools/computer-use-tools.js";
import { computerUsePromptAddendum, COMPUTER_USE_PROMPT_ADDENDUM } from "./prompt.js";
import { ComputerUseService } from "./service.js";
import { createComputerUseStatusApp } from "./status-api.js";

function service(enabled = true): { svc: ComputerUseService; execs: string[] } {
  const execs: string[] = [];
  const svc = new ComputerUseService({
    config: ComputerUseConfigSchema.parse({ enabled }),
    driver: { exec: async (f, a) => { execs.push(`${f} ${a.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; }, isExecutable: () => true, homeDir: "/Users/tester" },
    originOf: () => "owner_message",
    isDangerousText: () => false,
  });
  return { svc, execs };
}

describe("computer-use status route", () => {
  it("GET /status returns the cached state and runs no driver command", async () => {
    const { svc, execs } = service();
    const res = await createComputerUseStatusApp(svc).request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true, installed: null, healthy: null, armed: false, minutesLeft: 0, apps: [], approval: "per-app", screenshots: "window", problems: [],
    });
    expect(execs).toEqual([]);
  });

  it("has no route that arms, disarms or approves anything", async () => {
    const { svc } = service();
    const app = createComputerUseStatusApp(svc);
    for (const [method, path] of [["POST", "/status"], ["POST", "/on"], ["POST", "/arm"], ["GET", "/arm"], ["POST", "/off"], ["POST", "/approve"], ["PUT", "/grants"], ["DELETE", "/status"]] as const) {
      expect((await app.request(path, { method })).status, `${method} ${path}`).toBe(404);
    }
    expect(svc.arming.isArmed()).toBe(false);
  });

  it("an error in the source is a 500", async () => {
    const broken = createComputerUseStatusApp({ snapshot: () => { throw new Error("x"); } });
    expect((await broken.request("/status")).status).toBe(500);
  });
});

describe("computer_use_status MCP tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the only computer-use tool, nothing arms, and the factory does no I/O", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = createComputerUseTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:1", env: {} });
    expect(Object.keys(tools)).toEqual(["computer_use_status"]);
    expect(tools.computer_use_status!.parameters.properties).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies GET to the read-only route and returns only the status fields plus a hint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      enabled: true, installed: true, healthy: false, armed: false, minutesLeft: 0, apps: [], approval: "per-app", screenshots: "window", problems: ["Accessibility is not granted"], extra: "dropped",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await createComputerUseTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:18789", env: {} }).computer_use_status!.handler({});
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18789/api/computer-use/status", { method: "GET" });
    expect(out).toMatchObject({ enabled: true, installed: true, healthy: false, armed: false, problems: ["Accessibility is not granted"] });
    expect(out).not.toHaveProperty("extra");
    expect((out as { hint: string }).hint).toMatch(/\/computer on/);
  });

  it("reports unavailable without a gateway or on failure", async () => {
    expect(await createComputerUseTools({ dbDir: "/tmp/x", env: {} }).computer_use_status!.handler({})).toHaveProperty("error");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await createComputerUseTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:1", env: {} }).computer_use_status!.handler({})).toHaveProperty("error");
  });
});

describe("computer-use prompt addendum", () => {
  it("only for the owner's DM chat while the feature is enabled, never voice or background", () => {
    expect(computerUsePromptAddendum(true, { kind: "chat", channel: "telegram", chatType: "dm", ownerDm: true })).toBe(COMPUTER_USE_PROMPT_ADDENDUM);
    expect(computerUsePromptAddendum(false, { kind: "chat", channel: "telegram", chatType: "dm", ownerDm: true })).toBeNull();
    expect(computerUsePromptAddendum(true, { kind: "chat", channel: "telegram", chatType: "group", ownerDm: false })).toBeNull();
    expect(computerUsePromptAddendum(true, { kind: "chat", channel: "voice", chatType: "dm", ownerDm: true })).toBeNull();
    expect(computerUsePromptAddendum(true, { kind: "background", ownerDm: false })).toBeNull();
  });

  it("tells the agent the rules that do not depend on it behaving", () => {
    expect(COMPUTER_USE_PROMPT_ADDENDUM).toMatch(/accessibility tree/);
    expect(COMPUTER_USE_PROMPT_ADDENDUM).toMatch(/untrusted data/);
    expect(COMPUTER_USE_PROMPT_ADDENDUM).toMatch(/passwords, 2FA codes or card numbers/);
    expect(COMPUTER_USE_PROMPT_ADDENDUM).toMatch(/security dialogs/);
    expect(COMPUTER_USE_PROMPT_ADDENDUM).toMatch(/cannot arm it yourself/);
  });
});
