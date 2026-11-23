/**
 * Loopback routes under /api/voice on the control plane (PLAN B.9, B.13), the
 * backend of the voice_call_* tools. Any local process can reach them (the
 * agent can curl them), so every rule is enforced here by the service: a call
 * placed through this API is always "agent-tool", follows
 * outbound.agentCalls (default: the owner approves each call), goes only to
 * configured aliases, and respects the caps. Nothing here can approve,
 * answer a prompt, change the provider, or reveal a credential.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { VoiceService } from "./service.js";

export function createVoiceInternalApi(service: VoiceService): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));

  app.post("/calls", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const to = typeof b.to === "string" ? b.to : "";
    const message = typeof b.message === "string" ? b.message : "";
    const mode = b.mode === "talk" ? "talk" : "say";
    if (!to.trim()) return c.json({ error: "to is required" }, 400);
    const res = await service.placeCall({ alias: to, text: message, mode, requestedBy: "agent-tool", actor: "agent" });
    if (!res.ok) return c.json({ error: res.reason }, 403);
    return c.json({ callId: res.callId, status: res.status, provider: res.provider });
  });

  app.get("/calls", (c) => c.json(service.listCalls()));

  app.get("/calls/:id", (c) => {
    const view = service.getCall(c.req.param("id"));
    return view ? c.json(view) : c.json({ error: "no such call" }, 404);
  });

  app.post("/calls/:id/hangup", async (c) => {
    const r = await service.hangup(c.req.param("id"), "agent");
    return r.ok ? c.json({ ok: true, message: r.message }) : c.json({ error: r.message }, 404);
  });

  return app;
}
