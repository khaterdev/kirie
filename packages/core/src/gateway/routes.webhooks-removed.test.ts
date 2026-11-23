import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRoutes } from "./routes.js";
import { ChannelRegistry } from "../channels/registry.js";
import { SessionStore } from "../engine/session-store.js";

// W2-HOOK: the old unauthenticated `ALL /webhooks/:path` route is gone from the
// control plane. Webhooks live only on the public ingress (`POST /hooks/:id`).
describe("control plane without the old webhook route", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("answers 404 for /webhooks/* on every method", async () => {
    dir = mkdtempSync(join(tmpdir(), "kirie-routes-hooks-"));
    const sessionStore = new SessionStore(join(dir, "sessions.db"));
    const app = createRoutes({
      channelRegistry: new ChannelRegistry(),
      sessionStore,
      onConfigReload: async () => {},
      onShutdown: () => {},
      onRestart: () => {},
    });
    for (const method of ["GET", "POST", "PUT"]) {
      const res = await app.request(`/webhooks/deploy-notify`, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(res.status, method).toBe(404);
    }
    expect((await app.request("/hooks/abc-12345678", { method: "POST", body: "{}" })).status).toBe(404);
    sessionStore.close();
  });
});
