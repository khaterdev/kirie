/**
 * MCP tool handlers for voice call management.
 * Provides tools to initiate, monitor, and manage phone calls via Twilio.
 */
import { CallManager } from "@kirie/voice";
import type { CallRecord } from "@kirie/voice";
import { randomUUID } from "node:crypto";

export interface VoiceCallToolOptions {
  callManager: CallManager;
  initiateCall?: (opts: { to: string; callId: string }) => Promise<{ callSid: string; status: string }>;
  hangupCall?: (callSid: string) => Promise<void>;
}

export function createVoiceCallToolHandlers(options: VoiceCallToolOptions) {
  const { callManager } = options;

  return {
    voice_call_initiate: {
      description:
        "Initiate an outbound voice call. Requires a phone number in E.164 format (e.g. +1234567890). " +
        "Returns a call ID that can be used to check status or hang up.",
      parameters: {
        type: "object" as const,
        properties: {
          to: {
            type: "string",
            description: "Phone number to call in E.164 format (e.g. +1234567890)",
          },
          message: {
            type: "string",
            description: "Optional message to speak when the call is answered",
          },
        },
        required: ["to"] as const,
      },
      handler: async (params: Record<string, unknown>) => {
        const to = params.to as string;
        if (!to || !to.startsWith("+")) {
          throw new Error("Phone number must be in E.164 format (starting with +)");
        }

        const callId = randomUUID();

        if (!options.initiateCall) {
          throw new Error("Voice calling is not configured. Enable voice in config and provide Twilio credentials.");
        }

        const result = await options.initiateCall({ to, callId });

        const record = callManager.createCall({
          callId,
          callSid: result.callSid,
          to,
          from: "configured",
          sessionKey: params.session_key as string | undefined,
        });

        return {
          callId: record.callId,
          callSid: result.callSid,
          status: result.status,
          to: record.to,
          startedAt: record.startedAt,
        };
      },
    },

    voice_call_status: {
      description: "Get the current status of a voice call by its call ID.",
      parameters: {
        type: "object" as const,
        properties: {
          callId: {
            type: "string",
            description: "The call ID returned from voice_call_initiate",
          },
        },
        required: ["callId"] as const,
      },
      handler: async (params: Record<string, unknown>) => {
        const callId = params.callId as string;
        const record = callManager.getCall(callId);

        if (!record) {
          return { error: `No active call found with ID ${callId}` };
        }

        return {
          callId: record.callId,
          callSid: record.callSid,
          to: record.to,
          from: record.from,
          state: record.state,
          startedAt: record.startedAt,
          answeredAt: record.answeredAt,
          endedAt: record.endedAt,
          duration: record.duration,
        };
      },
    },

    voice_call_list: {
      description: "List all currently active voice calls.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler: async (_params: Record<string, unknown>) => {
        const calls = callManager.listActive();
        return {
          count: calls.length,
          calls: calls.map((c: CallRecord) => ({
            callId: c.callId,
            to: c.to,
            state: c.state,
            startedAt: c.startedAt,
            duration: c.duration,
          })),
        };
      },
    },

    voice_call_hangup: {
      description: "End an active voice call by its call ID.",
      parameters: {
        type: "object" as const,
        properties: {
          callId: {
            type: "string",
            description: "The call ID of the call to hang up",
          },
        },
        required: ["callId"] as const,
      },
      handler: async (params: Record<string, unknown>) => {
        const callId = params.callId as string;
        const record = callManager.getCall(callId);

        if (!record) {
          return { error: `No active call found with ID ${callId}` };
        }

        if (record.callSid && options.hangupCall) {
          await options.hangupCall(record.callSid);
        }

        const updated = callManager.updateState(callId, "ended");
        return {
          callId,
          status: "ended",
          duration: updated?.duration,
        };
      },
    },
  };
}
