import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Approval gate tools (PLAN B.13, W2-APR).
 * Tools: approval_status (read-only: mode, scope, pending count).
 *
 * There is deliberately no tool that changes the mode or the lists, requests
 * an approval or answers one. The factory is pure; the handler proxies to the
 * daemon's read-only `/api/approvals/status` route.
 */
export const createApprovalsTools: FeatureToolFactory = (ctx) => ({
  approval_status: {
    description:
      "Show the approval gate's current mode (yolo or ask), its ask scope and how many approval requests are waiting for the owner. " +
      "Read-only. Use it to explain why an action is waiting or was denied.",
    parameters: { type: "object", properties: {}, required: [] },
    async handler() {
      if (!ctx.gatewayUrl) return { error: "approval status is unavailable (no gateway)" };
      try {
        const res = await fetch(`${ctx.gatewayUrl}/api/approvals/status`, { method: "GET" });
        if (!res.ok) return { error: `approval status is unavailable (HTTP ${res.status})` };
        const body = (await res.json()) as Record<string, unknown>;
        return {
          enabled: body.enabled === true,
          mode: body.mode === "ask" ? "ask" : "yolo",
          askScope: body.askScope === "all" ? "all" : "dangerous",
          pending: typeof body.pending === "number" ? body.pending : 0,
        };
      } catch {
        return { error: "approval status is unavailable" };
      }
    },
  },
});
