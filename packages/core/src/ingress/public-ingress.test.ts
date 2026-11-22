import { describe, it, expect, afterEach } from "vitest";
import { createServer, request as httpRequest } from "node:http";
import { Hono } from "hono";
import { PublicIngress } from "./public-ingress.js";

const ingresses: PublicIngress[] = [];

function makeIngress(port = 0, publicBaseUrl?: string): PublicIngress {
  const ingress = new PublicIngress({ port, trustedIpHeader: "cf-connecting-ip", ...(publicBaseUrl ? { publicBaseUrl } : {}) });
  ingresses.push(ingress);
  return ingress;
}

function call(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: body ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A port nobody listens on right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function isPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(true));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(false)));
  });
}

afterEach(async () => {
  for (const i of ingresses.splice(0)) await i.stop();
});

describe("PublicIngress", () => {
  it("does not bind when nothing is mounted", async () => {
    const port = await freePort();
    const ingress = makeIngress(port);
    await ingress.ensureStarted();
    expect(ingress.isListening()).toBe(false);
    expect(await isPortBound(port)).toBe(false);
  });

  it("serves a mounted app under its prefix with the raw body and query intact", async () => {
    const ingress = makeIngress();
    const seen: Array<{ path: string; query: string; body: string }> = [];
    const app = new Hono().basePath("/hooks");
    app.post("/:id", async (c) => {
      const url = new URL(c.req.url);
      seen.push({ path: url.pathname, query: url.search, body: await c.req.text() });
      return c.text("accepted", 202);
    });
    ingress.mount("/hooks", app);
    await ingress.ensureStarted();
    const port = ingress.port!;
    const raw = "a=1&b=%20two&sig=abc+def";
    const res = await call(port, "POST", "/hooks/h-123?x=1&y=%2F", raw);
    expect(res.status).toBe(202);
    expect(seen).toEqual([{ path: "/hooks/h-123", query: "?x=1&y=%2F", body: raw }]);
    expect(ingress.lastRequestAt("/hooks")).not.toBeNull();
  });

  it("answers /healthz and 404 with an empty body for everything else, including control-plane paths", async () => {
    const ingress = makeIngress();
    ingress.mount("/hooks", new Hono().basePath("/hooks"));
    await ingress.ensureStarted();
    const port = ingress.port!;
    const health = await call(port, "GET", "/healthz");
    expect(health).toEqual({ status: 200, body: "ok" });
    for (const path of ["/", "/status", "/restart", "/api/channel-action", "/hooksx", "/voice/twilio/inbound"]) {
      const res = await call(port, path === "/restart" ? "POST" : "GET", path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toBe("");
    }
  });

  it("binds 127.0.0.1 only", async () => {
    const ingress = makeIngress();
    ingress.mount("/voice/twilio", new Hono().basePath("/voice/twilio"));
    await ingress.ensureStarted();
    const addr = (ingress as unknown as { server: { address(): { address: string } } }).server.address();
    expect(addr.address).toBe("127.0.0.1");
  });

  it("stopIfIdle releases the port once the last prefix is unmounted; stop is idempotent", async () => {
    const port = await freePort();
    const ingress = makeIngress(port);
    ingress.mount("/hooks", new Hono().basePath("/hooks"));
    await ingress.ensureStarted();
    await ingress.ensureStarted();
    expect(await isPortBound(port)).toBe(true);
    await ingress.stopIfIdle();
    expect(ingress.isListening()).toBe(true);
    ingress.unmount("/hooks");
    await ingress.stopIfIdle();
    expect(ingress.isListening()).toBe(false);
    expect(await isPortBound(port)).toBe(false);
    await ingress.stop();
  });

  it("validates prefixes and refuses duplicates and overlaps", () => {
    const ingress = makeIngress();
    ingress.mount("/voice/twilio", new Hono());
    expect(() => ingress.mount("/voice/twilio", new Hono())).toThrow(/already mounted/);
    expect(() => ingress.mount("/voice", new Hono())).toThrow(/overlaps/);
    expect(() => ingress.mount("/voice/twilio/x", new Hono())).toThrow(/overlaps/);
    expect(() => ingress.mount("hooks", new Hono())).toThrow(/Invalid/);
    expect(() => ingress.mount("/Hooks", new Hono())).toThrow(/Invalid/);
    expect(() => ingress.mount("/healthz", new Hono())).toThrow(/reserved/);
    ingress.mount("/voice/plivo", new Hono());
    expect(ingress.mountedPrefixes()).toEqual(["/voice/twilio", "/voice/plivo"]);
  });

  it("publicBaseUrl drops a trailing slash and is null when unset", () => {
    expect(makeIngress(0, "https://hooks.example.com/").publicBaseUrl).toBe("https://hooks.example.com");
    expect(makeIngress().publicBaseUrl).toBeNull();
  });

  it("a throwing sub-app gives an empty 500", async () => {
    const ingress = makeIngress();
    ingress.mount("/hooks", { fetch: () => { throw new Error("boom"); } });
    const res = await ingress.handle(new Request("http://127.0.0.1/hooks/x", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
  });
});
