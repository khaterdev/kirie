import { Hono } from "hono";
import pino from "pino";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SessionStore } from "../engine/session-store.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { UsageDashboard } from "../logging/usage-dashboard.js";
import type { ScheduleStore, WebhookFireEvent } from "../mcp/tools/schedule.js";
import type { ProactiveEngine } from "../engine/proactive.js";

const log = pino({ name: "gateway-routes" });

/**
 * Dependencies injected into the gateway routes.
 */
export interface GatewayDeps {
  /** Channel adapter registry for lifecycle management */
  channelRegistry: ChannelRegistry;
  /** Session store for listing active sessions */
  sessionStore: SessionStore;
  /** Callback to trigger config reload from disk */
  onConfigReload: () => Promise<void>;
  /** Callback to initiate graceful shutdown */
  onShutdown: () => void;
  /** Callback to initiate graceful restart (stop + start without process exit) */
  onRestart: () => void;
  /** Optional callback for Twilio voice status webhook events */
  onVoiceStatusCallback?: (callSid: string, callStatus: string) => void;
  /** Optional function to generate TwiML for a call stream */
  generateTwiml?: (callId: string) => string | null;
  /** SSE clients connected to the canvas events endpoint */
  canvasSseClients?: Set<{ write: (data: string) => void; close: () => void }>;
  /** Broadcast a message to all connected canvas SSE clients */
  canvasBroadcast?: (msg: unknown) => void;
  /** Path to canvas client static files directory */
  canvasClientDir?: string;
  /** Usage dashboard for token analytics */
  usageDashboard?: UsageDashboard;
  /** Optional schedule store for webhook lookup */
  scheduleStore?: ScheduleStore;
  /** Optional callback when a webhook fires */
  onWebhookFire?: (event: WebhookFireEvent) => void;
  /** Optional ProactiveEngine for proactive status/trigger API */
  proactiveEngine?: ProactiveEngine | null;
}

/**
 * Creates the Hono router with all gateway routes.
 *
 * Routes:
 *   GET  /status              - Health of all channels + agent
 *   POST /config/reload       - Hot-reload config from disk
 *   POST /channels/:id/start  - Start a specific channel
 *   POST /channels/:id/stop   - Stop a specific channel
 *   POST /shutdown            - Graceful shutdown
 *   GET  /sessions            - List active sessions
 */
export function createRoutes(deps: GatewayDeps): Hono {
  const app = new Hono();

  // GET /status - overall system health
  app.get("/status", (c) => {
    const adapters = deps.channelRegistry.getAll();
    const channels: Record<string, unknown> = {};

    for (const [id, adapter] of adapters) {
      const status = adapter.getStatus();
      channels[id] = {
        state: status.state,
        failureCount: status.failureCount,
        connectedAt: status.connectedAt ?? null,
        lastError: status.lastError ?? null,
        running: deps.channelRegistry.isRunning(id),
      };
    }

    return c.json({
      status: "ok",
      uptime: process.uptime(),
      channels,
      sessions: deps.sessionStore.count(),
    });
  });

  // POST /config/reload - trigger config reload
  app.post("/config/reload", async (c) => {
    try {
      await deps.onConfigReload();
      return c.json({ status: "ok", message: "Configuration reloaded" });
    } catch (err) {
      log.error({ err }, "config reload failed");
      return c.json({ status: "error", message: "An internal error occurred" }, 500);
    }
  });

  // POST /channels/:id/start - start a channel adapter
  app.post("/channels/:id/start", async (c) => {
    const id = c.req.param("id") as ChannelName;

    try {
      await deps.channelRegistry.start(id);
      return c.json({ status: "ok", channel: id, message: `Channel "${id}" started` });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";
      const isNotFound = errMsg.includes("not registered");
      if (!isNotFound) log.error({ channel: id, err }, "channel start failed");
      return c.json(
        { status: "error", channel: id, message: isNotFound ? `Channel "${id}" not found` : "An internal error occurred" },
        isNotFound ? 404 : 500,
      );
    }
  });

  // POST /channels/:id/stop - stop a channel adapter
  app.post("/channels/:id/stop", async (c) => {
    const id = c.req.param("id") as ChannelName;

    try {
      await deps.channelRegistry.stop(id);
      return c.json({ status: "ok", channel: id, message: `Channel "${id}" stopped` });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "";
      const isNotFound = errMsg.includes("not registered");
      if (!isNotFound) log.error({ channel: id, err }, "channel stop failed");
      return c.json(
        { status: "error", channel: id, message: isNotFound ? `Channel "${id}" not found` : "An internal error occurred" },
        isNotFound ? 404 : 500,
      );
    }
  });

  // POST /shutdown - graceful shutdown
  app.post("/shutdown", (c) => {
    // Respond before triggering shutdown
    const response = c.json({ status: "ok", message: "Shutdown initiated" });
    // Schedule shutdown on next tick so the response is sent first
    setImmediate(() => deps.onShutdown());
    return response;
  });

  // POST /restart - graceful restart (stop + start without process exit)
  app.post("/restart", (c) => {
    const response = c.json({ status: "ok", message: "Restart initiated" });
    setImmediate(() => deps.onRestart());
    return response;
  });

  // GET /sessions - list active sessions
  app.get("/sessions", (c) => {
    const adapters = deps.channelRegistry.getAll();
    const sessionsByChannel: Record<string, string[]> = {};

    for (const [id] of adapters) {
      sessionsByChannel[id] = deps.sessionStore.listByChannel(id);
    }

    return c.json({
      total: deps.sessionStore.count(),
      byChannel: sessionsByChannel,
    });
  });

  // ── Canvas routes ───────────────────────────────────────────────────────

  // Initialize SSE client tracking if not provided
  if (!deps.canvasSseClients) {
    deps.canvasSseClients = new Set();
  }
  if (!deps.canvasBroadcast) {
    const clients = deps.canvasSseClients;
    deps.canvasBroadcast = (msg: unknown) => {
      const data = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of clients) {
        try { client.write(data); } catch { /* client disconnected */ }
      }
    };
  }

  // GET /__kirie__/canvas - serve index.html
  app.get("/__kirie__/canvas", (c) => {
    const clientDir = deps.canvasClientDir ?? join(__dirname, "../../canvas/src/client");
    try {
      const html = readFileSync(join(clientDir, "index.html"), "utf-8");
      return c.html(html);
    } catch {
      return c.text("Canvas client not found", 404);
    }
  });

  // GET /__kirie__/canvas/canvas.js - serve client JS
  app.get("/__kirie__/canvas/canvas.js", (c) => {
    const clientDir = deps.canvasClientDir ?? join(__dirname, "../../canvas/src/client");
    try {
      const js = readFileSync(join(clientDir, "canvas.js"), "utf-8");
      c.header("Content-Type", "application/javascript");
      return c.body(js);
    } catch {
      return c.text("Canvas client JS not found", 404);
    }
  });

  // GET /__kirie__/canvas/events - SSE endpoint for real-time A2UI updates
  app.get("/__kirie__/canvas/events", (c) => {
    const sseClients = deps.canvasSseClients!;

    return c.body(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const client = {
            write(data: string) {
              try { controller.enqueue(encoder.encode(data)); } catch { /* stream closed */ }
            },
            close() {
              try { controller.close(); } catch { /* already closed */ }
            },
          };
          sseClients.add(client);

          // Send initial connection event
          client.write("data: {\"type\":\"connected\"}\n\n");

          // Clean up on abort
          c.req.raw.signal.addEventListener("abort", () => {
            sseClients.delete(client);
          });
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  });

  // POST /__kirie__/canvas/action - receive user actions from the canvas client
  app.post("/__kirie__/canvas/action", async (c) => {
    try {
      const body = await c.req.json();
      log.debug({ action: body }, "canvas action received");
      return c.json({ status: "ok", received: body });
    } catch {
      return c.json({ status: "error", message: "Invalid JSON" }, 400);
    }
  });

  // ── Usage dashboard API routes ──────────────────────────────────────────

  // GET /api/usage/summary?period=day|week|month
  app.get("/api/usage/summary", (c) => {
    if (!deps.usageDashboard) {
      return c.json({ status: "error", message: "Usage dashboard not configured" }, 503);
    }
    const period = (c.req.query("period") ?? "day") as "day" | "week" | "month";
    if (!["day", "week", "month"].includes(period)) {
      return c.json({ status: "error", message: "Invalid period. Use day, week, or month." }, 400);
    }
    return c.json(deps.usageDashboard.getSummary(period));
  });

  // GET /api/usage/sessions?period=week&limit=10
  app.get("/api/usage/sessions", (c) => {
    if (!deps.usageDashboard) {
      return c.json({ status: "error", message: "Usage dashboard not configured" }, 503);
    }
    const period = (c.req.query("period") ?? "week") as "day" | "week" | "month";
    const limit = parseInt(c.req.query("limit") ?? "10", 10);
    if (!["day", "week", "month"].includes(period)) {
      return c.json({ status: "error", message: "Invalid period. Use day, week, or month." }, 400);
    }
    return c.json(deps.usageDashboard.getTopSessions(limit, period));
  });

  // GET /api/usage/export?period=month - CSV export
  app.get("/api/usage/export", (c) => {
    if (!deps.usageDashboard) {
      return c.json({ status: "error", message: "Usage dashboard not configured" }, 503);
    }
    const period = (c.req.query("period") ?? "month") as "day" | "week" | "month";
    if (!["day", "week", "month"].includes(period)) {
      return c.json({ status: "error", message: "Invalid period. Use day, week, or month." }, 400);
    }
    const csv = deps.usageDashboard.exportCsv(period);
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename="kirie-usage-${period}.csv"`);
    return c.body(csv);
  });

  // ── Webhook routes ────────────────────────────────────────────────────

  app.all("/webhooks/:path", async (c) => {
    const webhookPath = c.req.param("path");

    if (!deps.scheduleStore) {
      return c.json({ status: "error", message: "Webhooks not configured" }, 503);
    }

    const webhook = deps.scheduleStore.getWebhook(webhookPath);
    if (!webhook) {
      return c.json({ status: "error", message: `Webhook "${webhookPath}" not found` }, 404);
    }

    // Check HTTP method
    if (webhook.method !== "GET" && webhook.method !== "POST") {
      // Fallback: accept any method
    } else if (c.req.method !== webhook.method && webhook.method !== "GET") {
      return c.json(
        { status: "error", message: `Expected ${webhook.method} request` },
        405,
      );
    }

    // Parse request body for POST requests
    let requestBody: unknown;
    if (c.req.method === "POST") {
      try {
        requestBody = await c.req.json();
      } catch {
        requestBody = await c.req.text();
      }
    }

    // Extract headers
    const requestHeaders: Record<string, string> = {};
    for (const [key, value] of c.req.raw.headers.entries()) {
      requestHeaders[key] = value;
    }

    const event: WebhookFireEvent = {
      name: webhook.name,
      path: webhook.path,
      handlerMessage: webhook.handler_message,
      channel: webhook.channel,
      chatId: webhook.chat_id,
      requestBody,
      requestHeaders,
    };

    if (deps.onWebhookFire) {
      deps.onWebhookFire(event);
    }

    log.info({ webhook: webhook.name, path: webhookPath }, "webhook fired");

    return c.json({ status: "ok", webhook: webhook.name, message: "Webhook triggered" });
  });

  // ── Voice webhook routes ──────────────────────────────────────────────

  // POST /voice/twilio/webhook - handle Twilio call status callbacks
  app.post("/voice/twilio/webhook", async (c) => {
    try {
      const formData = await c.req.parseBody();
      const callSid = formData.CallSid as string | undefined;
      const callStatus = formData.CallStatus as string | undefined;

      if (!callSid || !callStatus) {
        return c.json({ status: "error", message: "Missing CallSid or CallStatus" }, 400);
      }

      log.info({ callSid, callStatus }, "Twilio voice status callback");

      if (deps.onVoiceStatusCallback) {
        deps.onVoiceStatusCallback(callSid, callStatus);
      }

      return c.json({ status: "ok" });
    } catch (err) {
      log.error({ err }, "voice webhook error");
      return c.json({ status: "error", message: "An internal error occurred" }, 500);
    }
  });

  // POST /voice/twilio/twiml/:callId - serve TwiML for streaming
  app.post("/voice/twilio/twiml/:callId", (c) => {
    const callId = c.req.param("callId");

    if (!deps.generateTwiml) {
      return c.text("Voice not configured", 503);
    }

    const twiml = deps.generateTwiml(callId);
    if (!twiml) {
      return c.text("Call not found", 404);
    }

    c.header("Content-Type", "application/xml");
    return c.body(twiml);
  });

  // ── Proactive intelligence API (used by stdio MCP subprocess) ────────

  // GET /api/proactive/status - get proactive engine status
  app.get("/api/proactive/status", (c) => {
    const engine = deps.proactiveEngine;
    if (!engine) {
      return c.json({
        enabled: false,
        running: false,
        signalQueueSize: 0,
        lastTriageAt: 0,
        nextTriageAt: 0,
        digestQueueSize: 0,
        dedupCacheSize: 0,
      });
    }

    return c.json({
      enabled: true,
      running: engine.isRunning,
      signalQueueSize: engine.signalQueueSize,
      lastTriageAt: engine.lastTriageTimestamp,
      nextTriageAt: engine.nextTriageAt,
      digestQueueSize: engine.notifications.digestQueueSize,
      dedupCacheSize: engine.dedupCacheSize,
    });
  });

  // POST /api/proactive/trigger - force immediate triage cycle
  app.post("/api/proactive/trigger", async (c) => {
    const engine = deps.proactiveEngine;
    if (!engine) {
      return c.json({ triggered: false, error: "Proactive engine is not enabled" });
    }

    if (!engine.isRunning) {
      return c.json({ triggered: false, error: "Proactive engine is not running" });
    }

    try {
      const result = await engine.runTriage();
      return c.json({
        triggered: true,
        signalsProcessed: result.signalsProcessed,
        decisions: result.decisions.length,
      });
    } catch (err) {
      log.error({ err }, "proactive trigger failed");
      return c.json({ triggered: false, error: "Triage failed" }, 500);
    }
  });

  // ── Channel action API (used by stdio MCP subprocess) ────────────────

  // POST /api/channel-action - execute a channel action (react, send, edit, etc.)
  // This bridges the gap between the stdio subprocess (which has no ChannelRegistry)
  // and the daemon process (which does).
  app.post("/api/channel-action", async (c) => {
    try {
      const params = await c.req.json() as {
        channel: string;
        action: string;
        chatId: string;
        messageId?: string;
        text?: string;
        emoji?: string;
        threadId?: string;
        replyToId?: string;
      };

      if (!params.channel || !params.action || !params.chatId) {
        return c.json({ status: "error", message: "channel, action, and chatId are required" }, 400);
      }

      const adapter = deps.channelRegistry.getById(params.channel as ChannelName);
      if (!adapter) {
        return c.json({ status: "error", message: `Channel "${params.channel}" not found` }, 404);
      }

      const ctx = {
        chatId: params.chatId,
        threadId: params.threadId,
        replyToId: params.replyToId,
      };

      switch (params.action) {
        case "send_text": {
          if (!params.text) return c.json({ status: "error", message: "text is required" }, 400);
          const sent = await adapter.sendText({ ctx, text: params.text });
          return c.json({ status: "ok", sent });
        }
        case "send_reaction": {
          if (!params.messageId || !params.emoji) {
            return c.json({ status: "error", message: "messageId and emoji are required" }, 400);
          }
          if (!adapter.sendReaction) {
            return c.json({ status: "error", message: `Channel "${params.channel}" does not support reactions` }, 400);
          }
          await adapter.sendReaction({ ctx, messageId: params.messageId, emoji: params.emoji });
          return c.json({ status: "ok" });
        }
        case "edit_message": {
          if (!params.messageId || !params.text) {
            return c.json({ status: "error", message: "messageId and text are required" }, 400);
          }
          if (!adapter.editMessage) {
            return c.json({ status: "error", message: `Channel "${params.channel}" does not support editing` }, 400);
          }
          await adapter.editMessage({ ctx, messageId: params.messageId, text: params.text });
          return c.json({ status: "ok" });
        }
        case "send_typing": {
          await adapter.sendTyping({ ctx });
          return c.json({ status: "ok" });
        }
        default:
          return c.json({ status: "error", message: `Unknown action "${params.action}"` }, 400);
      }
    } catch (err) {
      log.error({ err }, "channel action failed");
      const message = err instanceof Error ? err.message : "An internal error occurred";
      return c.json({ status: "error", message }, 500);
    }
  });

  return app;
}
