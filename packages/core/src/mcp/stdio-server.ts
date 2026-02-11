#!/usr/bin/env node

/**
 * Standalone stdio MCP server entry point.
 *
 * Claude Code V2 subprocesses spawn this script as an MCP server.
 * It communicates via JSON-RPC over stdin/stdout using the
 * Model Context Protocol SDK.
 *
 * All tool handlers connect to the shared SQLite databases in
 * ~/.kirie/ (or KIRIE_DB_DIR env var) using WAL mode for safe
 * concurrent access from multiple processes.
 *
 * IMPORTANT: This server does NOT start cron jobs. It uses
 * ScheduleCrudStore (CRUD only) to avoid multiple processes
 * each firing cron events. The daemon's ScheduleStore handles cron.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { homedir } from "node:os";

import { MemoryStore, createMemoryToolHandlers } from "./tools/memory.js";
import { ScheduleCrudStore, createScheduleCrudToolHandlers } from "./tools/schedule-crud.js";
import { ChatHistoryStore, createChatHistoryToolHandlers } from "./tools/chat-history.js";
import { createDailyNoteToolHandlers } from "./tools/daily-notes.js";
import { BackgroundTaskStore } from "../engine/background-task-store.js";
import { createBackgroundTaskToolHandlers } from "./tools/background-tasks.js";
import { createCanvasToolHandlers } from "./tools/canvas-tool.js";
import { SessionStore } from "../engine/session-store.js";
import { createSessionToolHandlers } from "./tools/session-tools.js";
import { createWebFetchToolHandlers } from "./tools/web-fetch.js";
import { createWebSearchToolHandlers } from "./tools/web-search.js";
import { createBrowserToolHandlers } from "./tools/browser-tool.js";
import { createImageToolHandlers } from "./tools/image-tool.js";
import { createTTSToolHandlers } from "./tools/tts-tool.js";
import { createAgentsToolHandlers } from "./tools/agents-tool.js";
import { AgentRegistry } from "../engine/agent-registry.js";
import { MemoryManager, VectorStore, OpenAIEmbeddings, LocalEmbeddings, ensureModelDownloaded, isModelDownloaded } from "@kirie/memory";
import { HeartbeatLogStore, createHeartbeatLogToolHandlers } from "./tools/heartbeat-logs.js";
import { createMcpServersToolHandlers } from "./tools/mcp-servers.js";

// ── Database paths ──────────────────────────────────────────────────────────

const dbDir = process.env.KIRIE_DB_DIR || join(homedir(), ".kirie");

const memoryDbPath = join(dbDir, "memory.db");
const chatHistoryDbPath = join(dbDir, "chat-history.db");
const backgroundTasksDbPath = join(dbDir, "background-tasks.db");
const heartbeatLogDbPath = join(dbDir, "heartbeat-logs.db");

// ── Embedding provider + Vector store ────────────────────────────────────────

// Auto-download local embedding model if not present (non-blocking best-effort)
if (!process.env.OPENAI_API_KEY && !isModelDownloaded()) {
  void ensureModelDownloaded().catch(() => {
    // Model download failed — LocalEmbeddings will error on first use
  });
}

const embeddingProvider = process.env.OPENAI_API_KEY
  ? new OpenAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY })
  : new LocalEmbeddings();
const vectorDbPath = join(dbDir, "vectors.db");
const vectorStore = new VectorStore(vectorDbPath);

// ── Create stores ───────────────────────────────────────────────────────────

const memoryStore = new MemoryStore(memoryDbPath);
const scheduleCrud = new ScheduleCrudStore(memoryDbPath); // schedules table lives in memory.db
const chatHistoryStore = new ChatHistoryStore(chatHistoryDbPath, embeddingProvider);
const backgroundTaskStore = new BackgroundTaskStore(backgroundTasksDbPath);
const sessionStore = new SessionStore(join(dbDir, "sessions.db"));
const heartbeatLogStore = new HeartbeatLogStore(heartbeatLogDbPath, embeddingProvider);

// ── MemoryManager ────────────────────────────────────────────────────────────

const memoryManager = new MemoryManager({
  memoryStore: memoryStore as unknown as import("@kirie/memory").MemoryStore,
  vectorStore,
  embeddingProvider,
});

// ── Auto-reindex embeddings (non-blocking) ──────────────────────────────────

// Backfill vector embeddings for any memories/chat messages that don't have them
// (e.g. after switching from NoopEmbeddings to LocalEmbeddings).
void (async () => {
  try {
    await memoryManager.reindex();
  } catch {}
  try {
    await chatHistoryStore.reindex();
  } catch {}
  try {
    await heartbeatLogStore.reindex();
  } catch {}
})();

// ── Agent registry (empty for stdio server — agents only defined in daemon) ──

const agentRegistry = new AgentRegistry();

// ── Collect tool handlers ───────────────────────────────────────────────────

const memoryHandlers = createMemoryToolHandlers(memoryStore, memoryManager);
const scheduleHandlers = createScheduleCrudToolHandlers(scheduleCrud);
const chatHistoryHandlers = createChatHistoryToolHandlers(chatHistoryStore);
const backgroundTaskHandlers = createBackgroundTaskToolHandlers(backgroundTaskStore);
const sessionHandlers = createSessionToolHandlers({ sessionStore, chatHistoryStore });
const agentsHandlers = createAgentsToolHandlers(agentRegistry);

// ── Gateway-proxied tools ────────────────────────────────────────────────────
// These tools need the ChannelRegistry (daemon process only), so the stdio
// subprocess proxies them via the daemon's HTTP gateway.

const gatewayUrl = process.env.KIRIE_GATEWAY_URL;

function createGatewayProxyToolHandlers(baseUrl: string) {
  async function callGateway(body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/api/channel-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  return {
    send_message: {
      description:
        "Send a text message to a connected channel. Use this to proactively message users or respond in a different chat.",
      parameters: {
        type: "object" as const,
        properties: {
          channel: { type: "string" as const, description: "Channel name (telegram, discord, slack, whatsapp, signal)" },
          chatId: { type: "string" as const, description: "Chat/conversation ID" },
          text: { type: "string" as const, description: "Message text" },
          replyToId: { type: "string" as const, description: "Optional message ID to reply to" },
          threadId: { type: "string" as const, description: "Optional thread ID" },
        },
        required: ["channel", "chatId", "text"] as const,
      },
      async handler(params: Record<string, unknown>) {
        return callGateway({ ...params, action: "send_text" });
      },
    },

    channel_action: {
      description:
        "Perform channel-specific actions: send_reaction (react to a message with emoji), " +
        "edit_message (edit a sent message), send_typing (show typing indicator). " +
        "Use send_reaction to react with emoji to the user's message.",
      parameters: {
        type: "object" as const,
        properties: {
          channel: { type: "string" as const, description: "Channel name (telegram, discord, slack, whatsapp, signal)" },
          action: { type: "string" as const, description: "Action: send_reaction, edit_message, send_typing" },
          chatId: { type: "string" as const, description: "Chat/conversation ID" },
          messageId: { type: "string" as const, description: "Message ID (for reactions, edits)" },
          text: { type: "string" as const, description: "Text content (for edit_message)" },
          emoji: { type: "string" as const, description: "Emoji (for send_reaction, e.g. '👍', '❤️', '🔥')" },
          threadId: { type: "string" as const, description: "Thread ID (optional)" },
        },
        required: ["channel", "action", "chatId"] as const,
      },
      async handler(params: Record<string, unknown>) {
        return callGateway(params);
      },
    },

    gateway_restart: {
      description:
        "Restart the entire Kirie daemon — tears down all subsystems (channels, pipeline, MCP tools, gateway) " +
        "and re-initializes everything from scratch. Reloads config, reconnects channels, re-registers tools. " +
        "Use after making changes to config, skills, SOUL.md, or code.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      async handler() {
        const res = await fetch(`${baseUrl}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        return res.json();
      },
    },
  };
}

function createGatewayProactiveToolHandlers(baseUrl: string) {
  return {
    proactive_status: {
      description:
        "Get the status of the Proactive Intelligence Layer, including whether it's running, " +
        "signal queue size, last triage time, next triage time, digest queue size, and dedup cache size.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      async handler() {
        const res = await fetch(`${baseUrl}/api/proactive/status`);
        return res.json();
      },
    },

    proactive_trigger: {
      description:
        "Force an immediate triage cycle. Runs all signal detectors and the triage LLM immediately, " +
        "regardless of the normal schedule. Returns the number of signals processed and decisions made.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      async handler() {
        const res = await fetch(`${baseUrl}/api/proactive/trigger`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        return res.json();
      },
    },
  };
}

interface ToolDefinition {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

const allTools = new Map<string, ToolDefinition>();

function registerHandlers(handlers: Record<string, unknown>): void {
  for (const [name, def] of Object.entries(handlers)) {
    allTools.set(name, def as ToolDefinition);
  }
}

registerHandlers(memoryHandlers);
registerHandlers(scheduleHandlers);
registerHandlers(chatHistoryHandlers);
registerHandlers(createDailyNoteToolHandlers(memoryStore, memoryManager));
registerHandlers(backgroundTaskHandlers);
registerHandlers(sessionHandlers);
registerHandlers(agentsHandlers);
registerHandlers(createHeartbeatLogToolHandlers(heartbeatLogStore));
registerHandlers(createCanvasToolHandlers());
registerHandlers(createWebFetchToolHandlers());
registerHandlers(createWebSearchToolHandlers());
// Register browser tool only when enabled in config
if (process.env.KIRIE_BROWSER_ENABLED === "1") {
  registerHandlers(createBrowserToolHandlers());
}
registerHandlers(createImageToolHandlers());
registerHandlers(createTTSToolHandlers());
registerHandlers(createMcpServersToolHandlers());

// Gateway-proxied tools (send_message, channel_action, proactive) — only when spawned by daemon
if (gatewayUrl) {
  registerHandlers(createGatewayProxyToolHandlers(gatewayUrl));
  registerHandlers(createGatewayProactiveToolHandlers(gatewayUrl));
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: "kirie-tools",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [...allTools.entries()].map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: {
      type: "object" as const,
      properties: def.parameters.properties,
      required: def.parameters.required as string[] | undefined,
    },
  }));

  return { tools };
});

// Execute a tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = allTools.get(name);

  if (!tool) {
    return {
      content: [{ type: "text" as const, text: `Error: Unknown tool "${name}"` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler((args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Connect via stdio ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Write to stderr since stdout is reserved for JSON-RPC
  process.stderr.write(`kirie-tools MCP server fatal error: ${err}\n`);
  process.exit(1);
});
