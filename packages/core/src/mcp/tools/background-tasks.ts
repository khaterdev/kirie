import type {
  BackgroundTaskStore,
  BackgroundTask,
  BackgroundTaskStatus,
  BackgroundTaskCommandAction,
} from "../../engine/background-task-store.js";

/**
 * Creates MCP tool handlers for background task management.
 * These tools allow the agent to create, list, and query background tasks.
 *
 * In the stdio MCP server context, background_task_create writes to the DB
 * with status "pending". The daemon's BackgroundTaskManager polls for
 * pending tasks and starts V2 sessions for them.
 */
export function createBackgroundTaskToolHandlers(store: BackgroundTaskStore) {
  return {
    background_task_create: {
      description:
        "Create a background task that runs asynchronously in a separate session. Use this for long-running operations like research, analysis, or data processing. The result will be delivered proactively to the chat when complete, and can also be retrieved via background_task_result. IMPORTANT: Use the exact session_key from the <session_context> tag in the current message.",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "The session key from <session_context> (e.g., 'telegram:dm:12345'). Must match exactly.",
          },
          description: {
            type: "string" as const,
            description: "Short human-readable description of the task",
          },
          prompt: {
            type: "string" as const,
            description: "The full prompt/instructions for the background task to execute",
          },
        },
        required: ["sessionKey", "description", "prompt"] as const,
      },
      handler(params: {
        sessionKey: string;
        description: string;
        prompt: string;
      }): BackgroundTask {
        return store.create(params.sessionKey, params.description, params.prompt);
      },
    },

    background_task_list: {
      description:
        "List background tasks for a session. Optionally filter by status (pending, running, completed, failed, cancelled).",
      parameters: {
        type: "object" as const,
        properties: {
          sessionKey: {
            type: "string" as const,
            description: "Session key to list tasks for",
          },
          status: {
            type: "string" as const,
            description: "Optional status filter: pending, running, completed, failed, cancelled",
          },
        },
        required: ["sessionKey"] as const,
      },
      handler(params: {
        sessionKey: string;
        status?: string;
      }): BackgroundTask[] {
        const validStatuses: BackgroundTaskStatus[] = [
          "pending", "running", "completed", "failed", "cancelled",
        ];
        const status = params.status && validStatuses.includes(params.status as BackgroundTaskStatus)
          ? (params.status as BackgroundTaskStatus)
          : undefined;
        return store.list(params.sessionKey, status);
      },
    },

    background_task_result: {
      description:
        "Get the full result of a background task by its ID. Returns the task with its current status, result text, error info, cost, and turn count.",
      parameters: {
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "The background task ID",
          },
        },
        required: ["id"] as const,
      },
      handler(params: { id: string }): BackgroundTask | { error: string } {
        const task = store.get(params.id);
        if (!task) {
          return { error: `Background task "${params.id}" not found` };
        }
        return task;
      },
    },

    background_task_cancel: {
      description:
        "Cancel (kill) a running background task. The task's subprocess will be terminated immediately.",
      parameters: {
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "The background task ID to cancel",
          },
        },
        required: ["id"] as const,
      },
      handler(params: { id: string }): { status: string } | { error: string } {
        const task = store.get(params.id);
        if (!task) {
          return { error: `Background task "${params.id}" not found` };
        }
        if (task.status !== "running" && task.status !== "pending") {
          return { error: `Background task "${params.id}" is not running (status: ${task.status})` };
        }
        store.addCommand(params.id, "kill" as BackgroundTaskCommandAction);
        return { status: `Cancel command sent for task "${params.id}"` };
      },
    },

    background_task_send_message: {
      description:
        "Send a message to a running background task. Optionally interrupt the task's current work before delivering the message. Use interrupt=true to stop what the task is currently doing and redirect it with new instructions.",
      parameters: {
        type: "object" as const,
        properties: {
          id: {
            type: "string" as const,
            description: "The background task ID to send a message to",
          },
          message: {
            type: "string" as const,
            description: "The message to send to the background task",
          },
          interrupt: {
            type: "boolean" as const,
            description:
              "If true, interrupt the task's current work before delivering the message. If false (default), the message is queued for after current work completes.",
          },
        },
        required: ["id", "message"] as const,
      },
      handler(params: {
        id: string;
        message: string;
        interrupt?: boolean;
      }): { status: string } | { error: string } {
        const task = store.get(params.id);
        if (!task) {
          return { error: `Background task "${params.id}" not found` };
        }
        if (task.status !== "running") {
          return { error: `Background task "${params.id}" is not running (status: ${task.status})` };
        }
        store.addCommand(
          params.id,
          "send_message" as BackgroundTaskCommandAction,
          params.message,
          params.interrupt,
        );
        const action = params.interrupt ? "Interrupt + message" : "Message";
        return { status: `${action} command sent for task "${params.id}"` };
      },
    },
  };
}
