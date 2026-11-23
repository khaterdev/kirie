import type { FeatureToolFactory } from "../feature-tools.js";

/**
 * Computer use tools (PLAN B.13, W3-CU).
 * Tools: computer_use_status (read-only).
 *
 * There is deliberately no tool that arms, disarms or approves computer use:
 * arming is the owner's `/computer on` command only. The factory is pure; the
 * handler proxies to the daemon's read-only `/api/computer-use/status` route,
 * which reads cached state and runs nothing.
 */
export const createComputerUseTools: FeatureToolFactory = (ctx) => ({
  computer_use_status: {
    description:
      "Show whether desktop control (the mcp__cua-driver__* tools) is enabled, installed and armed, how many minutes are left, " +
      "which apps the window covers, and any setup problem. Read-only. You cannot arm it: tell the owner to send /computer on.",
    parameters: { type: "object", properties: {}, required: [] },
    async handler() {
      if (!ctx.gatewayUrl) return { error: "computer use status is unavailable (no gateway)" };
      try {
        const res = await fetch(`${ctx.gatewayUrl}/api/computer-use/status`, { method: "GET" });
        if (!res.ok) return { error: `computer use status is unavailable (HTTP ${res.status})` };
        const body = (await res.json()) as Record<string, unknown>;
        const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 20) : []);
        return {
          enabled: body.enabled === true,
          installed: typeof body.installed === "boolean" ? body.installed : null,
          healthy: typeof body.healthy === "boolean" ? body.healthy : null,
          armed: body.armed === true,
          minutesLeft: typeof body.minutesLeft === "number" ? body.minutesLeft : 0,
          apps: strings(body.apps),
          approval: typeof body.approval === "string" ? body.approval : "per-app",
          screenshots: typeof body.screenshots === "string" ? body.screenshots : "window",
          problems: strings(body.problems),
          ...(body.armed === true ? {} : { hint: "Desktop control is not armed. The owner can arm it with /computer on [minutes] [apps]." }),
        };
      } catch {
        return { error: "computer use status is unavailable" };
      }
    },
  },
});
