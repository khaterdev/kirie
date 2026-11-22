import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { GatewayServer, gatewayAllowedHosts } from "./server.js";
import { InternalApi } from "./internal-api.js";
import { ChannelRegistry } from "../channels/registry.js";
import { SessionStore } from "../engine/session-store.js";
import type { GatewayConfig } from "../config/schema.js";

interface RawResponse { status: number; body: string }

/** fetch() cannot set Host, so tests talk HTTP directly. */
function raw(port: number, opts: { method?: string; path: string; host?: string | null; body?: string; headers?: Record<string, string> }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(opts.body));
    }
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      method: opts.method ?? "GET",
      path: opts.path,
      headers,
      setHost: false,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    if (opts.host !== null) req.setHeader("host", opts.host ?? `127.0.0.1:${port}`);
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("GatewayServer Host allowlist and InternalApi", () => {
  let dir: string;
  let sessionStore: SessionStore;
  let gateway: GatewayServer;
  let port: number;

  async function startGateway(config: Partial<GatewayConfig> = {}, internalApi?: InternalApi): Promise<void> {
    gateway = new GatewayServer({
      config: { port: 0, bind: "loopback", extraAllowedHosts: [], ...config },
      deps: {
        channelRegistry: new ChannelRegistry(),
        sessionStore,
        onConfigReload: async () => {},
        onShutdown: () => {},
        onRestart: () => {},
      },
      internalApi,
    });
    port = await gateway.start();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-gw-"));
    sessionStore = new SessionStore(join(dir, "sessions.db"));
  });

  afterEach(async () => {
    await gateway?.stop();
    sessionStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts 127.0.0.1:<port>, localhost:<port> and [::1]:<port>", async () => {
    await startGateway();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await raw(port, { path: "/status", host });
      expect(res.status, host).toBe(200);
    }
  });

  it("refuses a foreign Host with 403 (DNS rebinding)", async () => {
    await startGateway();
    const res = await raw(port, { path: "/status", host: `evil.example:${port}` });
    expect(res.status).toBe(403);
    const post = await raw(port, {
      method: "POST",
      path: "/restart",
      host: `evil.example:${port}`,
      headers: { origin: `http://evil.example:${port}` },
      body: "{}",
    });
    expect(post.status).toBe(403);
  });

  it("refuses the right name on the wrong port, and a missing Host", async () => {
    await startGateway();
    expect((await raw(port, { path: "/status", host: "127.0.0.1:1" })).status).toBe(403);
    expect((await raw(port, { path: "/status", host: "127.0.0.1" })).status).toBe(403);
    // Node's HTTP parser already answers 400 to an HTTP/1.1 request with no Host.
    expect([400, 403]).toContain((await raw(port, { path: "/status", host: null })).status);
  });

  it("keeps the notify one-liner working: POST /api/channel-action with Host 127.0.0.1:<port> and no Origin", async () => {
    await startGateway();
    const res = await raw(port, {
      method: "POST",
      path: "/api/channel-action",
      host: `127.0.0.1:${port}`,
      headers: { "user-agent": "Python-urllib/3.12" },
      body: JSON.stringify({ channel: "telegram", action: "send_text", chatId: "1", text: "hi" }),
    });
    // The channel is not registered here, so the route answers with its own
    // error; what matters is that the Host check let it through.
    expect(res.status).not.toBe(403);
    expect(res.body).not.toContain("Host not allowed");
  });

  it("accepts gateway.extraAllowedHosts entries", async () => {
    await startGateway({ extraAllowedHosts: ["kirie.local:18789"] });
    expect((await raw(port, { path: "/status", host: "kirie.local:18789" })).status).toBe(200);
  });

  it("does not apply the Host allowlist when bind is all", async () => {
    await startGateway({ bind: "all" });
    expect((await raw(port, { path: "/status", host: "anything.example" })).status).toBe(200);
  });

  it("mounts InternalApi apps under /api/<name> and seals the registry", async () => {
    const api = new InternalApi();
    const app = new Hono();
    app.get("/status", (c) => c.json({ ok: true, feature: "demo" }));
    api.mount("demo", app);
    await startGateway({}, api);
    const res = await raw(port, { path: "/api/demo/status" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, feature: "demo" });
    expect(api.isSealed).toBe(true);
    expect(() => api.mount("late", new Hono())).toThrow(/after the gateway/);
    // Mounted apps sit behind the Host allowlist too.
    expect((await raw(port, { path: "/api/demo/status", host: "evil.example" })).status).toBe(403);
  });
});

describe("InternalApi", () => {
  it("validates names and refuses duplicates and gateway paths", () => {
    const api = new InternalApi();
    api.mount("accounts", new Hono());
    expect(() => api.mount("accounts", new Hono())).toThrow(/already mounted/);
    expect(() => api.mount("Bad", new Hono())).toThrow(/Invalid/);
    expect(() => api.mount("usage", new Hono())).toThrow(/reserved/);
    expect(() => api.mount("channel-action", new Hono())).toThrow(/reserved/);
    expect(api.apps().map((a) => a.name)).toEqual(["accounts"]);
  });
});

describe("gatewayAllowedHosts", () => {
  it("lists the loopback names with the port plus normalised extras", () => {
    expect([...gatewayAllowedHosts(18789, [" Kirie.Local:18789 ", ""])]).toEqual([
      "127.0.0.1:18789", "localhost:18789", "[::1]:18789", "kirie.local:18789",
    ]);
  });
});
