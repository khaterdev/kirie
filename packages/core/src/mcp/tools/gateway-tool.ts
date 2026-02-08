import type { ChannelRegistry } from "../../channels/registry.js";
import type { SessionStore } from "../../engine/session-store.js";

export function createGatewayToolHandlers(deps: {
  channelRegistry: ChannelRegistry;
  sessionStore: SessionStore;
  configReload: () => Promise<boolean>;
  onRestart?: () => void;
}) {
  return {
    gateway_status: {
      description:
        "Get gateway/system health status including channel states and session count.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler() {
        const channels: Record<string, unknown> = {};
        for (const [id, adapter] of deps.channelRegistry.getAll()) {
          channels[id] = {
            running: deps.channelRegistry.isRunning(id),
            ...adapter.getStatus(),
          };
        }
        return {
          channels,
          sessionCount: deps.sessionStore.count(),
          uptime: process.uptime(),
        };
      },
    },

    gateway_config_reload: {
      description: "Hot-reload the configuration file.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      async handler() {
        const success = await deps.configReload();
        return { reloaded: success };
      },
    },

    gateway_restart: {
      description:
        "Restart the entire Kirie daemon — tears down all subsystems (channels, pipeline, MCP tools, gateway) " +
        "and re-initializes everything from scratch. Reloads config, reconnects channels, re-registers tools, " +
        "and reruns all startup checks. Use after making changes to config, skills, SOUL.md, or code. " +
        "The process stays alive — only the daemon subsystems restart.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler() {
        if (!deps.onRestart) return { error: "Restart not available" };
        setImmediate(() => deps.onRestart!());
        return { restarting: true };
      },
    },
  };
}
