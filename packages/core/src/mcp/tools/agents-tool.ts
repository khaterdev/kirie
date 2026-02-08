/**
 * MCP tool handlers for multi-agent management.
 * Provides agents_list, agents_status, and agents_swap tools.
 */

import type { AgentRegistry } from "../../engine/agent-registry.js";

export function createAgentsToolHandlers(registry: AgentRegistry) {
  return {
    agents_list: {
      description: "List all configured agents and their bindings.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler() {
        return {
          agents: registry.list().map((a) => ({
            id: a.id,
            name: a.name,
            model: a.model,
            bindings: a.bindings,
            sessionScope: a.sessionScope,
            skills: a.skills,
            workspace: a.workspace,
          })),
        };
      },
    },

    agents_status: {
      description: "Get status and runtime state for agents.",
      parameters: {
        type: "object" as const,
        properties: {
          agentId: {
            type: "string",
            description: "Optional agent ID to get status for",
          },
        },
        required: [] as const,
      },
      handler(params: { agentId?: string }) {
        if (params.agentId) {
          const agent = registry.get(params.agentId);
          if (!agent) return { found: false, agentId: params.agentId };
          const state = registry.getState(params.agentId);
          return {
            found: true,
            agent: {
              id: agent.id,
              name: agent.name,
              model: agent.model,
              bindings: agent.bindings,
              workspace: agent.workspace,
            },
            runtime: state ?? null,
          };
        }
        return {
          count: registry.list().length,
          agents: registry.list().map((a) => {
            const state = registry.getState(a.id);
            return {
              id: a.id,
              name: a.name,
              busy: state?.busy ?? false,
              executionCount: state?.executionCount ?? 0,
              totalCostUsd: state?.totalCostUsd ?? 0,
            };
          }),
        };
      },
    },

    agents_swap: {
      description:
        "Swap the active agent for a session at runtime. The specified agent will handle all future messages for this session until cleared.",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string",
            description: "The session key to apply the override to",
          },
          agentId: {
            type: "string",
            description:
              "The agent ID to assign. Use 'clear' to remove the override and return to normal binding resolution.",
          },
        },
        required: ["sessionKey", "agentId"] as const,
      },
      handler(params: { sessionKey: string; agentId: string }) {
        if (params.agentId === "clear") {
          registry.clearSessionOverride(params.sessionKey);
          return {
            status: "cleared",
            sessionKey: params.sessionKey,
            message: "Session override cleared; normal binding resolution will be used.",
          };
        }

        const agent = registry.get(params.agentId);
        if (!agent) {
          return {
            status: "error",
            message: `Agent "${params.agentId}" not found. Use agents_list to see available agents.`,
          };
        }

        const ok = registry.setSessionOverride(params.sessionKey, params.agentId);
        if (!ok) {
          return {
            status: "error",
            message: `Failed to set override for agent "${params.agentId}".`,
          };
        }

        return {
          status: "swapped",
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          agentName: agent.name,
          message: `Session now routed to agent "${agent.name}" (${agent.id}).`,
        };
      },
    },
  };
}
