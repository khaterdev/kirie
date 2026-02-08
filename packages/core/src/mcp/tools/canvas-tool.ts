/**
 * MCP tool handler for canvas UI control.
 * Provides the `canvas` tool for presenting, hiding, navigating,
 * pushing data via A2UI, and taking snapshots.
 */

export interface CanvasToolOptions {
  /** Broadcast function to send messages to connected SSE/WS clients */
  broadcast?: (msg: unknown) => void;
}

export function createCanvasToolHandlers(options?: CanvasToolOptions) {
  const broadcast = options?.broadcast;

  return {
    canvas: {
      description:
        "Control the canvas display for rich UI output. Actions: present, hide, navigate, eval, snapshot, a2ui_push, a2ui_reset.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            description:
              "Action: present|hide|navigate|eval|snapshot|a2ui_push|a2ui_reset",
          },
          url: {
            type: "string",
            description: "URL for present/navigate actions",
          },
          code: {
            type: "string",
            description: "JavaScript code for eval action",
          },
          data: {
            type: "string",
            description: "JSON string of data for a2ui_push",
          },
          format: {
            type: "string",
            description: "Snapshot format: html|text (default: html)",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: {
        action: string;
        url?: string;
        code?: string;
        data?: string;
        format?: string;
      }) {
        switch (params.action) {
          case "present":
            return {
              status: "canvas_present",
              url: params.url ?? "http://localhost:18793",
            };
          case "hide":
            return { status: "canvas_hidden" };
          case "navigate":
            if (broadcast) {
              broadcast({ type: "navigate", url: params.url });
            }
            return { status: "navigated", url: params.url };
          case "a2ui_push": {
            let parsed: Record<string, unknown> = {};
            if (params.data) {
              try {
                parsed = JSON.parse(params.data);
              } catch {
                return { error: "Invalid JSON in data parameter" };
              }
            }
            if (broadcast) {
              broadcast({ type: "push", data: parsed });
            }
            return { status: "pushed", data: params.data };
          }
          case "a2ui_reset":
            if (broadcast) {
              broadcast({ type: "reset" });
            }
            return { status: "reset" };
          case "snapshot":
            if (broadcast) {
              broadcast({ type: "snapshot", format: params.format ?? "html" });
              return { status: "snapshot_requested", format: params.format ?? "html" };
            }
            return {
              status: "snapshot_unavailable",
              message: "Canvas snapshot requires active canvas host",
            };
          case "eval":
            if (broadcast) {
              broadcast({ type: "eval", code: params.code });
              return { status: "eval_sent" };
            }
            return {
              status: "eval_unavailable",
              message: "Canvas eval requires active canvas host",
            };
          default:
            return { error: `Unknown canvas action: ${params.action}` };
        }
      },
    },
  };
}
