import type { IncomingMessage } from "../engine/agent-engine.js";
import type { SessionStore } from "../engine/session-store.js";
import { makeSessionKey } from "./session-key.js";

/**
 * A resolved route containing the session key, existing SDK session ID,
 * and the message ready for the AgentEngine.
 */
export interface ResolvedRoute {
  /** The session key (channel:chatType:chatId) */
  sessionKey: string;
  /** Existing Agent SDK session ID if a conversation exists, null otherwise */
  sdkSessionId: string | null;
  /** The original message */
  message: IncomingMessage;
}

/**
 * Resolves routing information for an incoming message.
 *
 * This function:
 * 1. Computes the session key from the message's channel, chat type, and chat ID
 * 2. Looks up any existing Agent SDK session for that key
 *
 * The caller (e.g. the end-to-end message pipeline) uses the returned
 * session key for the LaneQueue and the SDK session ID for conversation
 * continuity.
 *
 * @param message - The incoming unified message
 * @param sessionStore - The session store for looking up existing sessions
 * @returns The resolved route with session key and optional SDK session ID
 */
export function resolveRoute(
  message: IncomingMessage,
  sessionStore: SessionStore,
): ResolvedRoute {
  const sessionKey = makeSessionKey({
    channel: message.channel,
    chatType: message.chatType,
    chatId: message.chatId,
  });

  const sdkSessionId = sessionStore.get(sessionKey);

  return {
    sessionKey,
    sdkSessionId,
    message,
  };
}
