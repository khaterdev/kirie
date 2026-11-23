import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "./routes.js";
import { ChannelRegistry } from "../channels/registry.js";
import { SessionStore } from "../engine/session-store.js";

// The old Twilio routes lived on the unauthenticated control plane with no
// signature check (PLAN C.14). Voice webhooks are served only by the public
// ingress now; the control plane must not answer them.
describe("control plane has no voice webhook routes", () => {
  let dir: string;
  let sessionStore: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-routes-voice-"));
    sessionStore = new SessionStore(join(dir, "sessions.db"));
  });
  afterEach(() => {
    sessionStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["/voice/twilio/webhook", "/voice/twilio/twiml/abc", "/voice/twilio/inbound", "/voice/plivo/inbound"])("POST %s is 404", async (path) => {
    const app = createRoutes({
      channelRegistry: new ChannelRegistry(),
      sessionStore,
      onConfigReload: vi.fn(async () => {}),
      onShutdown: vi.fn(),
      onRestart: vi.fn(),
    });
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "CallSid=CA1&CallStatus=completed",
    });
    expect(res.status).toBe(404);
  });
});
