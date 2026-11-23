/**
 * Read-only loopback route for `approval_status` (PLAN B.9, B.13).
 * Mounted at `/api/approvals`. Only GET /status exists: mode, scope and the
 * number of waiting prompts. No lists, no command text, nothing that changes
 * state (the agent can reach this port with curl).
 */

import { Hono } from "hono";

export interface ApprovalsStatusSource {
  enabled: boolean;
  mode(): "yolo" | "ask";
  askScope(): "dangerous" | "all";
  pending(): number;
}

export function createApprovalsStatusApp(source: ApprovalsStatusSource): Hono {
  const app = new Hono();
  app.get("/status", (c) => {
    try {
      return c.json({ enabled: source.enabled, mode: source.mode(), askScope: source.askScope(), pending: source.pending() });
    } catch {
      return c.json({ error: "approval status unavailable" }, 500);
    }
  });
  return app;
}
