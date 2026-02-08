import type { SessionStore } from "../../engine/session-store.js";
import type { ChatHistoryStore } from "./chat-history.js";

export function createSessionToolHandlers(deps: {
  sessionStore: SessionStore;
  chatHistoryStore: ChatHistoryStore;
}) {
  return {
    session_list: {
      description:
        "List active sessions with their keys, ordered by most recently updated.",
      parameters: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number" as const,
            description: "Max sessions to return (default 20)",
          },
        },
        required: [] as const,
      },
      handler(params: { limit?: number }) {
        const keys = deps.sessionStore.listAll();
        const limit = params.limit ?? 20;
        return {
          sessions: keys.slice(0, limit).map((key) => ({
            sessionKey: key,
            sdkSessionId: deps.sessionStore.get(key),
          })),
          total: keys.length,
        };
      },
    },

    session_history: {
      description: "Get message history for a specific session.",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "Session key (e.g. telegram:dm:12345)",
          },
          limit: {
            type: "number" as const,
            description: "Max messages (default 50)",
          },
        },
        required: ["sessionKey"] as const,
      },
      handler(params: { sessionKey: string; limit?: number }) {
        return deps.chatHistoryStore.recent(params.sessionKey, params.limit ?? 50);
      },
    },

    session_status: {
      description:
        "Get status information for a session, including whether it exists and its SDK session ID.",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "Session key",
          },
        },
        required: ["sessionKey"] as const,
      },
      handler(params: { sessionKey: string }) {
        const sdkSessionId = deps.sessionStore.get(params.sessionKey);
        if (sdkSessionId) {
          return {
            found: true,
            sessionKey: params.sessionKey,
            sdkSessionId,
          };
        }
        return { found: false, sessionKey: params.sessionKey };
      },
    },
  };
}
