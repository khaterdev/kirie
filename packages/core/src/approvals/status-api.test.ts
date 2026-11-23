import { describe, it, expect, vi, afterEach } from "vitest";
import { createApprovalsStatusApp } from "./status-api.js";
import { createApprovalsTools } from "../mcp/tools/approvals-tools.js";

describe("approvals status route", () => {
  const app = createApprovalsStatusApp({ enabled: true, mode: () => "ask", askScope: () => "all", pending: () => 3 });

  it("GET /status returns mode, scope and pending only", async () => {
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, mode: "ask", askScope: "all", pending: 3 });
  });

  it("has no route that changes anything", async () => {
    for (const [method, path] of [["POST", "/status"], ["POST", "/mode"], ["PUT", "/mode"], ["POST", "/allow"], ["POST", "/approve"], ["GET", "/lists"], ["DELETE", "/status"]] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("an error in a source is a 500, not a crash", async () => {
    const broken = createApprovalsStatusApp({ enabled: true, mode: () => { throw new Error("x"); }, askScope: () => "all", pending: () => 0 });
    expect((await broken.request("/status")).status).toBe(500);
  });
});

describe("approval_status MCP tool", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the only approvals tool, and the factory does no I/O", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tools = createApprovalsTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:1", env: {} });
    expect(Object.keys(tools)).toEqual(["approval_status"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies to the read-only route with GET and returns only the status fields", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ enabled: true, mode: "ask", askScope: "dangerous", pending: 1, extra: "dropped" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const tools = createApprovalsTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:18789", env: {} });
    const out = await tools.approval_status!.handler({});
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:18789/api/approvals/status", { method: "GET" });
    expect(out).toEqual({ enabled: true, mode: "ask", askScope: "dangerous", pending: 1 });
  });

  it("reports unavailable without a gateway or on failure", async () => {
    expect(await createApprovalsTools({ dbDir: "/tmp/x", env: {} }).approval_status!.handler({})).toHaveProperty("error");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await createApprovalsTools({ dbDir: "/tmp/x", gatewayUrl: "http://127.0.0.1:1", env: {} }).approval_status!.handler({})).toHaveProperty("error");
  });
});
