import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";
import { WebhookStore } from "../../webhooks/store.js";

/**
 * Webhook tools (PLAN B.13, W2-HOOK): `webhook_list`, `webhook_deliveries`.
 *
 * Read-only views of `~/.kirie/webhooks.db`, opened read-only on first use.
 * They never return a secret or a secret reference. There is deliberately no
 * tool to add, edit, enable, rotate or reveal a hook: the agent tells the
 * owner which `/webhook` command to send instead.
 */
export const createWebhooksTools: FeatureToolFactory = (ctx) => {
  const dbPath = join(ctx.dbDir, "webhooks.db");
  let store: WebhookStore | null = null;
  const open = (): WebhookStore | null => {
    if (store) return store;
    if (!existsSync(dbPath)) return null;
    store = new WebhookStore(dbPath, { readonly: true });
    return store;
  };

  const tools: Record<string, McpToolDefinition> = {
    webhook_list: {
      description:
        "List the owner's webhook triggers (id, source, enabled, action, tool profile, events, verified, last delivery). Read-only and never shows secrets. Hooks are created and changed only by the owner with the /webhook command.",
      parameters: { type: "object", properties: {}, required: [] },
      handler() {
        const s = open();
        if (!s) return { hooks: [] };
        return {
          hooks: s.listHooks().map((h) => ({
            id: h.id,
            name: h.name,
            source: h.source,
            enabled: h.enabled,
            action: h.action,
            toolProfile: h.toolProfile,
            events: h.events,
            verified: h.verifiedAt !== null,
            lastDelivery: s.lastDeliveryAt(h.id),
          })),
        };
      },
    },
    webhook_deliveries: {
      description: "Recent webhook deliveries (time, hook, event, status, task id). Read-only; payloads are not stored.",
      parameters: {
        type: "object",
        properties: {
          hookId: { type: "string", description: "Only this hook's deliveries" },
          limit: { type: "number", description: "Rows to return, 1 to 50 (default 10)" },
        },
        required: [],
      },
      handler(params) {
        const s = open();
        if (!s) return { deliveries: [] };
        const hookId = typeof params.hookId === "string" && params.hookId.length > 0 ? params.hookId : undefined;
        const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(50, Math.floor(params.limit))) : 10;
        return {
          deliveries: s.recentDeliveries({ hookId, limit }).map((d) => ({
            id: d.id,
            hookId: d.hookId,
            event: d.event,
            status: d.status,
            taskId: d.taskId,
            note: d.note,
            receivedAt: d.receivedAt,
          })),
        };
      },
    },
  };
  return tools;
};
