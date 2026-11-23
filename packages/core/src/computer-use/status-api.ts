/**
 * Read-only loopback route for `computer_use_status` (PLAN B.9, B.13).
 * Mounted at `/api/computer-use`. Only GET /status exists, and it reads the
 * cached state: it runs no probe and no driver command. Nothing here can arm,
 * disarm, approve or change anything (the agent can reach this port with curl).
 */

import { Hono } from "hono";
import type { ComputerUseStatusSnapshot } from "./service.js";

export interface ComputerUseStatusSource {
  snapshot(): ComputerUseStatusSnapshot;
}

export function createComputerUseStatusApp(source: ComputerUseStatusSource): Hono {
  const app = new Hono();
  app.get("/status", (c) => {
    try {
      return c.json(source.snapshot());
    } catch {
      return c.json({ error: "computer use status unavailable" }, 500);
    }
  });
  return app;
}
