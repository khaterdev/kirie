import { randomUUID } from "node:crypto";
import type { SessionStore } from "../../engine/session-store.js";
import type { A2APolicy } from "../../engine/a2a-policy.js";

export function createSessionsSpawnToolHandlers(
  sessionStore: SessionStore,
  a2aPolicy: A2APolicy,
) {
  return {
    sessions_spawn: {
      description:
        "Spawn a new child session (subagent). Creates a session entry that can receive messages via sessions_send. " +
        "The child session runs independently with its own conversation context.",
      parameters: {
        type: "object" as const,
        properties: {
          task: {
            type: "string" as const,
            description: "Description of the task for the child session",
          },
          label: {
            type: "string" as const,
            description:
              "Optional human-readable label for the session (e.g. 'research-agent'). Must be unique.",
          },
          agentId: {
            type: "string" as const,
            description: "Agent definition ID to use for the child session",
          },
          model: {
            type: "string" as const,
            description: "Model to use for the child session (overrides agent default)",
          },
          parentSessionKey: {
            type: "string" as const,
            description: "Session key of the parent (caller) session",
          },
        },
        required: ["task", "parentSessionKey"] as const,
      },
      async handler(params: {
        task: string;
        label?: string;
        agentId?: string;
        model?: string;
        parentSessionKey: string;
      }) {
        if (!a2aPolicy.enabled) {
          return { error: "Agent-to-agent communication is disabled" };
        }

        // Validate the parent session is not already a subagent (prevent deep nesting)
        if (params.parentSessionKey.includes(":subagent:")) {
          return { error: "Subagents cannot spawn further subagents" };
        }

        const agentId = params.agentId ?? "default";

        if (!a2aPolicy.matchesAllow(agentId)) {
          return { error: `Agent "${agentId}" is not allowed by A2A policy` };
        }

        // Generate child session key
        const childSessionKey = `agent:${agentId}:subagent:${randomUUID()}`;

        // Create the session entry
        sessionStore.createSession(childSessionKey, {
          model: params.model,
          agentId,
        });

        // Set label if provided
        if (params.label) {
          try {
            sessionStore.setLabel(childSessionKey, params.label);
          } catch {
            // Label may conflict with existing label — non-fatal
            return {
              status: "accepted",
              childSessionKey,
              warning: `Session created but label "${params.label}" is already in use`,
            };
          }
        }

        return {
          status: "accepted",
          childSessionKey,
          label: params.label,
          agentId,
          task: params.task,
        };
      },
    },
  };
}
