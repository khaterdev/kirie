/**
 * Multi-agent registry for managing agent definitions and resolving
 * which agent should handle a given message based on binding rules.
 *
 * Resolution priority: runtime override > peer > group > channel > default
 */

export interface AgentBinding {
  /** Binding type: which scope does this bind to */
  scope: "peer" | "group" | "channel" | "default";
  /** Channel name for channel/peer/group bindings */
  channel?: string;
  /** Peer ID for peer bindings */
  peerId?: string;
  /** Group/chat ID for group bindings */
  groupId?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  skills?: string[];
  bindings: AgentBinding[];
  sessionScope?: "main" | "per-peer" | "per-channel-peer";
  maxTurns?: number;
  /** Isolated workspace directory for this agent (resolved at runtime) */
  workspace?: string;
}

/** Runtime state tracked per agent instance */
export interface AgentRuntimeState {
  /** Number of executions completed */
  executionCount: number;
  /** Last execution timestamp (ISO string) */
  lastExecutedAt?: string;
  /** Whether this agent is currently executing a query */
  busy: boolean;
  /** Total cost accumulated by this agent */
  totalCostUsd: number;
}

export class AgentRegistry {
  private agents = new Map<string, AgentDefinition>();
  private defaultAgentId: string | null = null;
  /** Runtime state per agent ID */
  private runtimeState = new Map<string, AgentRuntimeState>();
  /** Runtime session-to-agent overrides (sessionKey -> agentId) */
  private sessionOverrides = new Map<string, string>();

  register(agent: AgentDefinition): void {
    this.agents.set(agent.id, agent);
    // Initialize runtime state for new agents
    if (!this.runtimeState.has(agent.id)) {
      this.runtimeState.set(agent.id, {
        executionCount: 0,
        busy: false,
        totalCostUsd: 0,
      });
    }
    // If this agent has a "default" binding, set as default
    if (agent.bindings.some((b) => b.scope === "default")) {
      this.defaultAgentId = agent.id;
    }
  }

  get(id: string): AgentDefinition | undefined {
    return this.agents.get(id);
  }

  getDefault(): AgentDefinition | undefined {
    return this.defaultAgentId
      ? this.agents.get(this.defaultAgentId)
      : undefined;
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Get runtime state for an agent */
  getState(agentId: string): AgentRuntimeState | undefined {
    return this.runtimeState.get(agentId);
  }

  /** Update runtime state after an execution */
  recordExecution(agentId: string, costUsd: number): void {
    const state = this.runtimeState.get(agentId);
    if (state) {
      state.executionCount++;
      state.lastExecutedAt = new Date().toISOString();
      state.totalCostUsd += costUsd;
    }
  }

  /** Mark an agent as busy or idle */
  setBusy(agentId: string, busy: boolean): void {
    const state = this.runtimeState.get(agentId);
    if (state) {
      state.busy = busy;
    }
  }

  /**
   * Set a runtime override so a specific session uses a specific agent.
   * This takes highest priority in resolve().
   */
  setSessionOverride(sessionKey: string, agentId: string): boolean {
    if (!this.agents.has(agentId)) return false;
    this.sessionOverrides.set(sessionKey, agentId);
    return true;
  }

  /** Clear a session override, returning to normal binding resolution */
  clearSessionOverride(sessionKey: string): void {
    this.sessionOverrides.delete(sessionKey);
  }

  /** Get the current session override agent ID, if any */
  getSessionOverride(sessionKey: string): string | undefined {
    return this.sessionOverrides.get(sessionKey);
  }

  /** Resolve which agent should handle a given message context */
  resolve(
    channel: string,
    _chatType: string,
    chatId: string,
    senderId: string,
    sessionKey?: string,
  ): AgentDefinition | undefined {
    // Highest priority: runtime session override
    if (sessionKey) {
      const overrideId = this.sessionOverrides.get(sessionKey);
      if (overrideId) {
        const agent = this.agents.get(overrideId);
        if (agent) return agent;
      }
    }

    // Priority: peer > group > channel > default
    for (const agent of this.agents.values()) {
      for (const binding of agent.bindings) {
        if (
          binding.scope === "peer" &&
          binding.channel === channel &&
          binding.peerId === senderId
        ) {
          return agent;
        }
      }
    }
    for (const agent of this.agents.values()) {
      for (const binding of agent.bindings) {
        if (
          binding.scope === "group" &&
          binding.channel === channel &&
          binding.groupId === chatId
        ) {
          return agent;
        }
      }
    }
    for (const agent of this.agents.values()) {
      for (const binding of agent.bindings) {
        if (binding.scope === "channel" && binding.channel === channel) {
          return agent;
        }
      }
    }
    return this.getDefault();
  }

  clear(): void {
    this.agents.clear();
    this.runtimeState.clear();
    this.sessionOverrides.clear();
    this.defaultAgentId = null;
  }
}
