import { z } from "zod/v4";
import {
  tool as sdkTool,
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ChannelRegistry } from "../channels/registry.js";
import { MemoryStore, createMemoryToolHandlers, type MemoryManagerLike } from "./tools/memory.js";
import { ScheduleStore, createScheduleToolHandlers } from "./tools/schedule.js";
import { createAgentsToolHandlers } from "./tools/agents-tool.js";
import type { AgentRegistry } from "../engine/agent-registry.js";
export type { ScheduleFireEvent, ScheduleDeliveryMode, ScheduleEntry, WebhookEntry, WebhookFireEvent, ActiveHoursConfig } from "./tools/schedule.js";
export { isWithinActiveHours } from "./tools/schedule.js";
import { createMessagingToolHandlers } from "./tools/messaging.js";
import { ChatHistoryStore, createChatHistoryToolHandlers } from "./tools/chat-history.js";
import type { EmbeddingProvider } from "./tools/chat-history.js";
export { ChatHistoryStore } from "./tools/chat-history.js";
export type { ChatHistoryEntry, EmbeddingProvider } from "./tools/chat-history.js";
import { HeartbeatLogStore, createHeartbeatLogToolHandlers } from "./tools/heartbeat-logs.js";
export { HeartbeatLogStore } from "./tools/heartbeat-logs.js";
export type { HeartbeatLogEntry, HeartbeatLogInput, HeartbeatLogTier, HeartbeatLogLevel, HeartbeatLogMinLevels } from "./tools/heartbeat-logs.js";
import { createDailyNoteToolHandlers } from "./tools/daily-notes.js";
import { BackgroundTaskStore } from "../engine/background-task-store.js";
import { createBackgroundTaskToolHandlers } from "./tools/background-tasks.js";
import { createChannelActionToolHandlers } from "./tools/channel-actions.js";
import { createDiscordActionToolHandlers } from "./tools/discord-actions.js";
import { createTelegramActionToolHandlers } from "./tools/telegram-actions.js";
import { createSlackActionToolHandlers } from "./tools/slack-actions.js";
import { createWhatsAppActionToolHandlers } from "./tools/whatsapp-actions.js";
import { createGatewayToolHandlers } from "./tools/gateway-tool.js";
import { createSessionsSpawnToolHandlers } from "./tools/sessions-spawn.js";
import { createSessionsSendToolHandlers } from "./tools/sessions-send.js";
import { createA2APolicy, type A2AConfig } from "../engine/a2a-policy.js";
import type { SessionStore } from "../engine/session-store.js";
import { createBroadcastToolHandlers, createLabelToolHandlers } from "./tools/broadcast-labels.js";
import { LabelStore } from "../routing/labels.js";
import type { BroadcastTarget } from "../routing/broadcast.js";
import { createVoiceCallToolHandlers, type VoiceCallToolOptions } from "./tools/voice-call.js";
import { createNodesToolHandlers, type NodesToolOptions } from "./tools/nodes-tool.js";
import { createProactiveToolHandlers } from "./tools/proactive-tools.js";
import { createMcpServersToolHandlers } from "./tools/mcp-servers.js";
import { createTTSToolHandlers } from "./tools/tts-tool.js";
import type { ProactiveEngine } from "../engine/proactive.js";

export interface McpToolDefinition {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

export interface McpServerOptions {
  channelRegistry: ChannelRegistry;
  sessionStore?: SessionStore;
  configReload?: () => Promise<boolean>;
  memoryDbPath?: string;
  scheduleDbPath?: string;
  chatHistoryDbPath?: string;
  backgroundTasksDbPath?: string;
  /** Optional agent registry for agent management tools */
  agentRegistry?: AgentRegistry;
  /** Optional MemoryManager for hybrid FTS5 + vector search */
  memoryManager?: MemoryManagerLike;
  /** Optional A2A (agent-to-agent) configuration */
  a2aConfig?: Partial<A2AConfig>;
  /** Optional broadcast groups from routing config */
  broadcastGroups?: Record<string, { targets: BroadcastTarget[] }>;
  /** Optional label store database (shares scheduleDbPath by default) */
  labelDbPath?: string;
  /** Optional voice call tool options */
  voiceCallOptions?: VoiceCallToolOptions;
  /** Optional nodes tool options (gateway URL + token for companion device nodes) */
  nodesOptions?: NodesToolOptions;
  /** Optional embedding provider for chat history semantic search */
  embeddingProvider?: EmbeddingProvider;
  /** Optional callback to trigger a full daemon restart */
  onRestart?: () => void;
  /** Optional ProactiveEngine instance for proactive intelligence tools */
  proactiveEngine?: ProactiveEngine | null;
  /** Optional heartbeat log database path */
  heartbeatLogDbPath?: string;
  /** Optional per-tier minimum log levels for heartbeat logging */
  heartbeatLogLevels?: { tier1?: string; tier2?: string; tier3?: string; heartbeat?: string };
  /** Optional per-tier retention in days for heartbeat log pruning */
  heartbeatLogRetention?: { tier1?: number; tier2?: number; tier3?: number; heartbeat?: number };
  /** Optional pre-created HeartbeatLogStore (avoids creating a duplicate) */
  heartbeatLogStore?: HeartbeatLogStore;
}

/**
 * Creates the MCP server tool registry containing all built-in Kirie tools.
 * Returns a map of tool name -> definition for integration with the Agent SDK.
 */
export function createMcpToolRegistry(options: McpServerOptions): {
  tools: Map<string, McpToolDefinition>;
  memoryStore: MemoryStore;
  scheduleStore: ScheduleStore;
  chatHistoryStore: ChatHistoryStore;
  backgroundTaskStore: BackgroundTaskStore;
  heartbeatLogStore: HeartbeatLogStore;
  shutdown: () => void;
} {
  const memoryStore = new MemoryStore(options.memoryDbPath);
  const scheduleStore = new ScheduleStore(options.scheduleDbPath);
  const chatHistoryStore = new ChatHistoryStore(options.chatHistoryDbPath, options.embeddingProvider);
  const backgroundTaskStore = new BackgroundTaskStore(options.backgroundTasksDbPath);
  const heartbeatLogStore = options.heartbeatLogStore ?? new HeartbeatLogStore(
    options.heartbeatLogDbPath,
    options.embeddingProvider,
    options.heartbeatLogLevels as import("./tools/heartbeat-logs.js").HeartbeatLogMinLevels | undefined,
  );

  // Wire background task store into schedule store for auto-cancel on delete
  scheduleStore.setBackgroundTaskStore(backgroundTaskStore);

  // Load persisted schedules
  scheduleStore.loadAll();

  const memoryHandlers = createMemoryToolHandlers(memoryStore, options.memoryManager);
  const scheduleHandlers = createScheduleToolHandlers(scheduleStore);
  const messagingHandlers = createMessagingToolHandlers(options.channelRegistry);
  const chatHistoryHandlers = createChatHistoryToolHandlers(chatHistoryStore);
  const backgroundTaskHandlers = createBackgroundTaskToolHandlers(backgroundTaskStore);

  const tools = new Map<string, McpToolDefinition>();

  // Register memory tools
  for (const [name, def] of Object.entries(memoryHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register schedule tools
  for (const [name, def] of Object.entries(scheduleHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register messaging tools
  for (const [name, def] of Object.entries(messagingHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register chat history tools
  for (const [name, def] of Object.entries(chatHistoryHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register daily note tools
  const dailyNoteHandlers = createDailyNoteToolHandlers(memoryStore, options.memoryManager);
  for (const [name, def] of Object.entries(dailyNoteHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register background task tools
  for (const [name, def] of Object.entries(backgroundTaskHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register channel action tools (need ChannelRegistry, daemon-only)
  const channelActionHandlers = createChannelActionToolHandlers(options.channelRegistry);
  for (const [name, def] of Object.entries(channelActionHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register channel-specific action tools
  const discordActionHandlers = createDiscordActionToolHandlers(options.channelRegistry);
  for (const [name, def] of Object.entries(discordActionHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  const telegramActionHandlers = createTelegramActionToolHandlers(options.channelRegistry);
  for (const [name, def] of Object.entries(telegramActionHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  const slackActionHandlers = createSlackActionToolHandlers(options.channelRegistry);
  for (const [name, def] of Object.entries(slackActionHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  const whatsappActionHandlers = createWhatsAppActionToolHandlers(options.channelRegistry);
  for (const [name, def] of Object.entries(whatsappActionHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register agents tools (need AgentRegistry)
  if (options.agentRegistry) {
    const agentsHandlers = createAgentsToolHandlers(options.agentRegistry);
    for (const [name, def] of Object.entries(agentsHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register gateway tools (need ChannelRegistry + SessionStore, daemon-only)
  if (options.sessionStore) {
    const gatewayHandlers = createGatewayToolHandlers({
      channelRegistry: options.channelRegistry,
      sessionStore: options.sessionStore,
      configReload: options.configReload ?? (async () => false),
      onRestart: options.onRestart,
    });
    for (const [name, def] of Object.entries(gatewayHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register sessions spawn/send tools (need SessionStore + A2A policy)
  if (options.sessionStore) {
    const a2aPolicy = createA2APolicy(options.a2aConfig);
    const spawnHandlers = createSessionsSpawnToolHandlers(options.sessionStore, a2aPolicy);
    for (const [name, def] of Object.entries(spawnHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
    const sendHandlers = createSessionsSendToolHandlers(options.sessionStore, a2aPolicy, chatHistoryStore);
    for (const [name, def] of Object.entries(sendHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register broadcast tools (need ChannelRegistry + broadcast groups from config)
  if (options.broadcastGroups) {
    const broadcastHandlers = createBroadcastToolHandlers(options.channelRegistry, options.broadcastGroups);
    for (const [name, def] of Object.entries(broadcastHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register label tools (shares the schedule store's database)
  const labelStore = new LabelStore(scheduleStore.getDb());
  const labelHandlers = createLabelToolHandlers(labelStore);
  for (const [name, def] of Object.entries(labelHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register voice call tools (optional, depends on voice config)
  if (options.voiceCallOptions) {
    const voiceCallHandlers = createVoiceCallToolHandlers(options.voiceCallOptions);
    for (const [name, def] of Object.entries(voiceCallHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register nodes tool (need gateway URL for companion device nodes)
  if (options.nodesOptions) {
    const nodesHandlers = createNodesToolHandlers(options.nodesOptions);
    for (const [name, def] of Object.entries(nodesHandlers)) {
      tools.set(name, def as unknown as McpToolDefinition);
    }
  }

  // Register proactive intelligence tools
  const proactiveHandlers = createProactiveToolHandlers(options.proactiveEngine ?? null);
  for (const [name, def] of Object.entries(proactiveHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register heartbeat log tools
  const heartbeatLogHandlers = createHeartbeatLogToolHandlers(heartbeatLogStore);
  for (const [name, def] of Object.entries(heartbeatLogHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register MCP server management tools (list/add/remove external servers)
  const mcpServersHandlers = createMcpServersToolHandlers();
  for (const [name, def] of Object.entries(mcpServersHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Register TTS tools (text-to-speech)
  const ttsHandlers = createTTSToolHandlers();
  for (const [name, def] of Object.entries(ttsHandlers)) {
    tools.set(name, def as unknown as McpToolDefinition);
  }

  // Auto-reindex: backfill vector embeddings for any records missing them
  if (options.memoryManager) {
    void (options.memoryManager as unknown as { reindex(): Promise<unknown> })
      .reindex()
      .catch(() => {});
  }
  void chatHistoryStore.reindex().catch(() => {});
  void heartbeatLogStore.reindex().catch(() => {});

  const shutdown = () => {
    scheduleStore.close();
    memoryStore.close();
    chatHistoryStore.close();
    backgroundTaskStore.close();
    heartbeatLogStore.close();
  };

  return { tools, memoryStore, scheduleStore, chatHistoryStore, backgroundTaskStore, heartbeatLogStore, shutdown };
}

/**
 * Convert the tool registry into the format expected by the Agent SDK's
 * `tools` parameter (array of tool definitions with JSON schema).
 */
export function toAgentSdkTools(
  tools: Map<string, McpToolDefinition>,
): Array<{
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
}> {
  return [...tools.entries()].map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: {
      type: "object" as const,
      properties: def.parameters.properties,
      required: def.parameters.required,
    },
  }));
}

/**
 * Execute a tool by name with the given parameters.
 * Returns the serializable result or throws if the tool doesn't exist.
 */
export async function executeTool(
  tools: Map<string, McpToolDefinition>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return tool.handler(params);
}

/**
 * Creates an in-process MCP server using the Agent SDK's createSdkMcpServer().
 * This wraps our tool definitions into SDK-compatible tool() calls with Zod schemas,
 * producing a McpSdkServerConfigWithInstance that can be passed to query()'s mcpServers option.
 */
export function createSdkMcpServerFromTools(
  tools: Map<string, McpToolDefinition>,
): McpSdkServerConfigWithInstance {
  const sdkTools = [...tools.entries()].map(([name, def]) => {
    // Convert plain JSON schema properties to Zod schemas.
    // Built as a mutable record because z.ZodRawShape is Readonly; the SDK's
    // tool() requires zod v4 shapes, which is why this file imports zod/v4
    // while the rest of the repo is still on zod/v3.
    const zodShape: Record<string, z.ZodType> = {};
    const props = def.parameters.properties;
    const required = new Set(def.parameters.required ?? []);

    for (const [key, schema] of Object.entries(props)) {
      const s = schema as { type?: string; description?: string };
      let zodType: z.ZodType;

      switch (s.type) {
        case "number":
        case "integer":
          zodType = z.number().describe(s.description ?? "");
          break;
        case "boolean":
          zodType = z.boolean().describe(s.description ?? "");
          break;
        case "array":
          zodType = z.array(z.string()).describe(s.description ?? "");
          break;
        default:
          zodType = z.string().describe(s.description ?? "");
          break;
      }

      zodShape[key] = required.has(key) ? zodType : zodType.optional();
    }

    return sdkTool(
      name,
      def.description,
      zodShape,
      async (args) => {
        try {
          const result = await def.handler(args as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    );
  });

  return createSdkMcpServer({
    name: "kirie-tools",
    version: "0.1.0",
    tools: sdkTools,
  });
}
