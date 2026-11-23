/**
 * Read-only loopback route for `sandbox_status` (PLAN B.9, B.13): mounted at
 * `/api/sandbox`, it answers `GET /status` and nothing else. No route here can
 * change the mode, the write list or the container.
 */

import { Hono } from "hono";

export interface SandboxStatusSource {
  statusSnapshot(): Record<string, unknown>;
}

export function createSandboxStatusApp(source: SandboxStatusSource): Hono {
  const app = new Hono();
  app.get("/status", (c) => c.json(source.statusSnapshot()));
  return app;
}
