/**
 * MCP tool handlers for broadcast messaging and session labels.
 */

import type { ChannelRegistry } from "../../channels/registry.js";
import { broadcastMessage, type BroadcastGroup, type BroadcastTarget } from "../../routing/broadcast.js";
import { LabelStore } from "../../routing/labels.js";

export function createBroadcastToolHandlers(
  channelRegistry: ChannelRegistry,
  broadcastGroups: Record<string, { targets: BroadcastTarget[] }>,
) {
  return {
    schedule_broadcast: {
      description: "Send a message to all targets in a named broadcast group. Groups are defined in config under routing.broadcastGroups.",
      parameters: {
        type: "object" as const,
        properties: {
          groupName: { type: "string" as const, description: "Name of the broadcast group (defined in config)" },
          message: { type: "string" as const, description: "Message text to broadcast" },
        },
        required: ["groupName", "message"] as const,
      },
      async handler(params: { groupName: string; message: string }) {
        const groupConfig = broadcastGroups[params.groupName];
        if (!groupConfig) {
          return { error: `Broadcast group "${params.groupName}" not found`, availableGroups: Object.keys(broadcastGroups) };
        }
        const group: BroadcastGroup = {
          name: params.groupName,
          targets: groupConfig.targets,
        };
        const results = await broadcastMessage(group, params.message, channelRegistry);
        const succeeded = results.filter((r) => r.success).length;
        return {
          groupName: params.groupName,
          totalTargets: results.length,
          succeeded,
          failed: results.length - succeeded,
          results,
        };
      },
    },
  };
}

export function createLabelToolHandlers(labelStore: LabelStore) {
  return {
    session_label: {
      description: "Set, get, or list labels on conversation sessions. Labels are human-readable names for session keys.",
      parameters: {
        type: "object" as const,
        properties: {
          action: { type: "string" as const, description: 'Action: "set", "get", "list", "delete", "find"' },
          sessionKey: { type: "string" as const, description: "Session key (required for set, get, delete)" },
          label: { type: "string" as const, description: "Label text (required for set, find)" },
        },
        required: ["action"] as const,
      },
      handler(params: { action: string; sessionKey?: string; label?: string }) {
        switch (params.action) {
          case "set": {
            if (!params.sessionKey || !params.label) {
              return { error: "sessionKey and label are required for set" };
            }
            labelStore.setLabel(params.sessionKey, params.label);
            return { set: true, sessionKey: params.sessionKey, label: params.label };
          }
          case "get": {
            if (!params.sessionKey) {
              return { error: "sessionKey is required for get" };
            }
            const label = labelStore.getLabel(params.sessionKey);
            return { sessionKey: params.sessionKey, label };
          }
          case "find": {
            if (!params.label) {
              return { error: "label is required for find" };
            }
            const sessionKey = labelStore.getByLabel(params.label);
            return { label: params.label, sessionKey };
          }
          case "list": {
            return { labels: labelStore.listLabels() };
          }
          case "delete": {
            if (!params.sessionKey) {
              return { error: "sessionKey is required for delete" };
            }
            const deleted = labelStore.deleteLabel(params.sessionKey);
            return { deleted, sessionKey: params.sessionKey };
          }
          default:
            return { error: `Unknown action "${params.action}". Use set, get, find, list, or delete.` };
        }
      },
    },
  };
}
