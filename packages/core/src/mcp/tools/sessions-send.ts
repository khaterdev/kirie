import type { SessionStore } from "../../engine/session-store.js";
import type { A2APolicy } from "../../engine/a2a-policy.js";
import type { ChatHistoryStore } from "./chat-history.js";

export function createSessionsSendToolHandlers(
  sessionStore: SessionStore,
  a2aPolicy: A2APolicy,
  chatHistoryStore?: ChatHistoryStore,
) {
  return {
    sessions_send: {
      description:
        "Send a message to another session (by key or label). " +
        "The message is stored in the target session's chat history so the agent " +
        "will see it on its next turn.",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "Target session key (use this or label, not both)",
          },
          label: {
            type: "string" as const,
            description: "Target session label (use this or sessionKey, not both)",
          },
          message: {
            type: "string" as const,
            description: "Message text to deliver to the target session",
          },
          senderSessionKey: {
            type: "string" as const,
            description: "Session key of the sender (for A2A policy validation)",
          },
        },
        required: ["message"] as const,
      },
      async handler(params: {
        sessionKey?: string;
        label?: string;
        message: string;
        senderSessionKey?: string;
      }) {
        if (!a2aPolicy.enabled) {
          return { error: "Agent-to-agent communication is disabled" };
        }

        // Resolve target session
        let targetKey = params.sessionKey;
        if (!targetKey && params.label) {
          targetKey = sessionStore.resolveByLabel(params.label) ?? undefined;
          if (!targetKey) {
            return { error: `No session found with label "${params.label}"` };
          }
        }

        if (!targetKey) {
          return { error: "Either sessionKey or label must be provided" };
        }

        // Verify target session exists
        if (!sessionStore.has(targetKey)) {
          return { error: `Session "${targetKey}" does not exist` };
        }

        // Store the message in the target session's chat history
        if (chatHistoryStore) {
          chatHistoryStore.append(targetKey, "user", params.message, {
            senderName: params.senderSessionKey ?? "agent",
            channel: "a2a",
          });
        }

        return {
          status: "delivered",
          sessionKey: targetKey,
          message: params.message,
        };
      },
    },
  };
}
