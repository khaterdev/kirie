/**
 * Agent router that maps incoming messages to agent definitions
 * and computes the appropriate session key based on agent scope.
 */

import type {
  AgentRegistry,
  AgentDefinition,
} from "../engine/agent-registry.js";
import type { UnifiedMessage } from "../channels/normalizer.js";

export interface AgentRouteResult {
  agent: AgentDefinition;
  sessionKey: string; // may be modified based on agent's sessionScope
}

export class AgentRouter {
  constructor(private registry: AgentRegistry) {}

  /** Route a message to the appropriate agent */
  route(
    message: UnifiedMessage,
    baseSessionKey: string,
  ): AgentRouteResult | null {
    const agent = this.registry.resolve(
      message.channel,
      message.chatType,
      message.chatId,
      message.senderId,
    );

    if (!agent) return null;

    // Modify session key based on agent's sessionScope
    let sessionKey = baseSessionKey;
    if (agent.sessionScope === "per-peer") {
      sessionKey = `${agent.id}:${message.channel}:peer:${message.senderId}`;
    } else if (agent.sessionScope === "per-channel-peer") {
      sessionKey = `${agent.id}:${baseSessionKey}`;
    } else {
      // "main" scope - uses the base session key but prefixed with agent id
      sessionKey = `${agent.id}:${baseSessionKey}`;
    }

    return { agent, sessionKey };
  }
}
