/**
 * Agent-to-Agent (A2A) policy enforcement.
 * Controls which agents can spawn subagents or send messages to other sessions.
 */

export interface A2AConfig {
  enabled: boolean;
  allow: string[];
  maxPingPongTurns?: number;
}

export interface A2APolicy {
  readonly enabled: boolean;
  matchesAllow(agentId: string): boolean;
  isAllowed(requester: string, target: string): boolean;
  readonly maxPingPongTurns: number;
}

export function createA2APolicy(config?: Partial<A2AConfig>): A2APolicy {
  const enabled = config?.enabled ?? true;
  const patterns = config?.allow ?? ["*"];
  const maxPingPongTurns = config?.maxPingPongTurns ?? 5;

  function matchesPattern(agentId: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) {
      return agentId.startsWith(pattern.slice(0, -1));
    }
    return agentId === pattern;
  }

  function matchesAllow(agentId: string): boolean {
    return patterns.some((p) => matchesPattern(agentId, p));
  }

  return {
    enabled,
    matchesAllow,
    isAllowed(requester: string, target: string): boolean {
      if (!enabled) return false;
      return matchesAllow(requester) && matchesAllow(target);
    },
    maxPingPongTurns,
  };
}
