import { z } from "zod/v3";

/**
 * A string value that may contain a $credential:key reference,
 * resolved at runtime via the CredentialStore.
 */
const credentialRef = z.string();

// ── Agent ────────────────────────────────────────────────────────────────────

export const AgentConfigSchema = z.object({
  /** Additional instructions appended to the default system prompt */
  customInstructions: z.string().optional(),
  /** Maximum agent turns per request. 0 = unlimited. */
  maxTurns: z.number().int().min(0).default(100),
  model: z.string().default("claude-opus-4-8[1m]"),
  /** Default working directory for the agent (cwd passed to the SDK) */
  workspace: z.string().optional(),
  /** Maximum turns for background task agents. Default 200. */
  backgroundTaskMaxTurns: z.number().int().min(1).default(200),
  /**
   * How messages are executed.
   *
   * - "v1": one query() per message. The subprocess starts, answers, and exits,
   *   so every message pays full startup cost. Session continuity comes from
   *   resuming a stored session ID.
   * - "v2": one persistent session per conversation, held open with streaming
   *   input. Avoids per-message startup, at the cost of long-lived subprocesses
   *   (capped by sessionIdleTimeoutMs / maxSessions).
   */
  sessionMode: z.enum(["v1", "v2"]).default("v1"),
  /** v2 only: close a session after this long with no activity. Default 10 min. */
  sessionIdleTimeoutMs: z.number().int().min(10_000).default(600_000),
  /** v2 only: maximum concurrent live sessions before evicting the oldest idle one. */
  maxSessions: z.number().int().min(1).default(20),
});

// ── Security ─────────────────────────────────────────────────────────────────

const ChannelIdentitiesSchema = z.object({
  telegram: z.array(z.union([z.string(), z.number()])).default([]),
  discord: z.array(z.string()).default([]),
  whatsapp: z.array(z.string()).default([]),
  signal: z.array(z.string()).default([]),
  slack: z.array(z.string()).default([]),
});

const RateLimitBucketSchema = z.object({
  maxRequests: z.number().int().positive().default(30),
  windowMs: z.number().int().positive().default(60_000),
});

export const SecurityConfigSchema = z.object({
  owner: z.object({
    identities: ChannelIdentitiesSchema.default({}),
  }).default({}),
  dmPolicy: z.enum(["owner-only", "allowlist", "open"]).default("owner-only"),
  groupPolicy: z.enum(["mention-only", "all", "disabled"]).default("mention-only"),
  rateLimit: z.object({
    perUser: RateLimitBucketSchema.default({ maxRequests: 30, windowMs: 60_000 }),
    perGroup: RateLimitBucketSchema.default({ maxRequests: 60, windowMs: 60_000 }),
  }).default({}),
});

// ── Channels ─────────────────────────────────────────────────────────────────

/** Per-channel security restrictions (shared across all channel schemas) */
const ChannelSecurityFields = {
  /** Only allow messages from these user IDs. Empty = no restriction (use global policy). */
  allowedUserIds: z.array(z.union([z.string(), z.number()])).default([]),
  /** Whether the bot responds in group chats on this channel */
  allowGroups: z.boolean().default(true),
  /** Whether the bot can be added to new groups (adapter-level enforcement) */
  allowAddToGroups: z.boolean().default(true),
};

const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  token: credentialRef.optional(),
  webhookUrl: z.string().url().optional(),
  pollingTimeout: z.number().int().positive().default(30),
  ...ChannelSecurityFields,
});

const DiscordChannelSchema = z.object({
  enabled: z.boolean().default(false),
  token: credentialRef.optional(),
  intents: z.array(z.string()).default([]),
  ...ChannelSecurityFields,
});

const SlackChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: credentialRef.optional(),
  appToken: credentialRef.optional(),
  signingSecret: credentialRef.optional(),
  ...ChannelSecurityFields,
});

const WhatsAppChannelSchema = z.object({
  enabled: z.boolean().default(false),
  sessionDataPath: z.string().optional(),
  ...ChannelSecurityFields,
});

const SignalChannelSchema = z.object({
  enabled: z.boolean().default(false),
  apiUrl: z.string().default("http://localhost:8080"),
  phoneNumber: z.string().optional(),
  ...ChannelSecurityFields,
});

export const ChannelsConfigSchema = z.object({
  telegram: TelegramChannelSchema.default({}),
  discord: DiscordChannelSchema.default({}),
  slack: SlackChannelSchema.default({}),
  whatsapp: WhatsAppChannelSchema.default({}),
  signal: SignalChannelSchema.default({}),
}).default({});

// ── Memory ───────────────────────────────────────────────────────────────────

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  backend: z.enum(["sqlite"]).default("sqlite"),
  dbPath: z.string().optional(),
  embeddings: z.object({
    /** Embedding provider: "local" for offline ONNX, "openai" for API, "noop" to disable */
    provider: z.enum(["local", "openai", "noop"]).default("local"),
    /** API key for OpenAI provider — also reads from $OPENAI_API_KEY env var as fallback */
    apiKey: credentialRef.optional(),
    /** Embedding model (default depends on provider) */
    model: z.string().optional(),
  }).default({}),
});

// ── Gateway ──────────────────────────────────────────────────────────────────

export const GatewayConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(18789),
  bind: z.enum(["loopback", "all"]).default("loopback"),
  bearerToken: credentialRef.optional(),
});

// ── Plugins ──────────────────────────────────────────────────────────────────

const PluginEntrySchema = z.object({
  package: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});

// ── Multi-Agent ─────────────────────────────────────────────────────────────

const AgentBindingSchema = z.object({
  scope: z.enum(["peer", "group", "channel", "default"]),
  channel: z.string().optional(),
  peerId: z.string().optional(),
  groupId: z.string().optional(),
});

const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  bindings: z.array(AgentBindingSchema).default([]),
  sessionScope: z.enum(["main", "per-peer", "per-channel-peer"]).default("main"),
  maxTurns: z.number().int().min(0).optional(),
  workspace: z.string().optional(),
});

// ── Tools ───────────────────────────────────────────────────────────────────

export const ToolsConfigSchema = z.object({
  agentToAgent: z.object({
    enabled: z.boolean().default(true),
    allow: z.array(z.string()).default(["*"]),
    maxPingPongTurns: z.number().int().min(1).max(10).default(5),
  }).default({}),
}).default({});

// ── Canvas ──────────────────────────────────────────────────────────────────

const CanvasConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(18793),
  canvasDir: z.string().optional(),
});


// -- Media Understanding --------------------------------------------------

const LocalWhisperConfigSchema = z.object({
  /** Path to whisper-cli binary (default: "whisper-cli" in PATH) */
  whisperBinary: z.string().default("whisper-cli"),
  /** Path to the GGML model file (required for local provider) */
  modelPath: z.string(),
  /** Language code or "auto" for auto-detect (default: "auto") */
  language: z.string().default("auto"),
  /** Number of threads for whisper-cpp (default: 4) */
  threads: z.number().int().min(1).default(4),
});

const MediaUnderstandingSchema = z.object({
  audio: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(["openai", "groq", "local"]).default("openai"),
    model: z.string().optional(),
    language: z.string().optional(),
    /** Configuration for the local whisper-cpp provider */
    local: LocalWhisperConfigSchema.optional(),
  }).default({}),
  video: z.object({
    enabled: z.boolean().default(false),
    extractAudio: z.boolean().default(true),
  }).default({}),
}).default({});

// -- Voice ----------------------------------------------------------------

const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["twilio"]).default("twilio"),
  twilio: z.object({
    accountSid: z.string().optional(),
    authToken: z.string().optional(),
    fromNumber: z.string().optional(),
  }).default({}),
  maxConcurrentCalls: z.number().int().min(1).default(3),
  tts: z.object({
    provider: z.enum(["openai", "elevenlabs", "edge"]).default("openai"),
    voice: z.string().default("alloy"),
  }).default({}),
  stt: z.object({
    provider: z.enum(["openai", "groq"]).default("openai"),
    model: z.string().default("whisper-1"),
  }).default({}),
}).default({});

// ── Logging ─────────────────────────────────────────────────────────────────

const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  telemetry: z.object({
    enabled: z.boolean().default(false),
    exporter: z.enum(["console", "otlp", "jaeger"]).default("otlp"),
    endpoint: z.string().optional(),
  }).default({}),
  redactSensitive: z.enum(["off", "tools", "all"]).default("tools"),
}).default({});

// ── Routing ─────────────────────────────────────────────────────────────────

const RoutingConfigSchema = z.object({
  broadcastGroups: z.record(z.object({
    targets: z.array(z.object({
      channel: z.string(),
      chatId: z.string(),
    })),
  })).default({}),
}).default({});

// ── Sandbox ─────────────────────────────────────────────────────────────────

const SandboxConfigSchema = z.object({
  mode: z.enum(["off", "docker"]).default("off"),
  scope: z.enum(["shared", "agent", "session"]).default("agent"),
  workspaceAccess: z.enum(["rw", "none"]).default("rw"),
  docker: z.object({
    image: z.string().default("kirie-sandbox:latest"),
    readOnlyRoot: z.boolean().default(true),
    network: z.enum(["none", "bridge", "host"]).default("none"),
    capDrop: z.array(z.string()).default(["ALL"]),
    memory: z.string().default("512m"),
    cpus: z.number().default(1),
  }).default({}),
  prune: z.object({
    idleHours: z.number().default(24),
    maxAgeDays: z.number().default(7),
  }).default({}),
}).default({});

// ── Nodes ───────────────────────────────────────────────────────────────────

export const NodesConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultTimeout: z.number().int().positive().default(30_000),
}).default({});

// ── MCP Servers ─────────────────────────────────────────────────────────────

/**
 * Configuration for a single external MCP server.
 * Supports stdio servers (command + args) and HTTP/SSE servers (url + headers).
 */
const McpServerEntrySchema = z.object({
  /** Command to spawn the MCP server (stdio mode). Mutually exclusive with `url`. */
  command: z.string().optional(),
  /** Arguments passed to the command. */
  args: z.array(z.string()).default([]),
  /** Environment variables to set for the spawned process. Supports ${VAR} interpolation. */
  env: z.record(z.string()).default({}),
  /** URL for HTTP/SSE MCP servers (remote mode). Mutually exclusive with `command`. */
  url: z.string().optional(),
  /** HTTP headers sent with requests to remote MCP servers. */
  headers: z.record(z.string()).default({}),
  /** Whether this server is enabled. Disabled servers are skipped at startup. */
  enabled: z.boolean().default(true),
});

export const McpServersConfigSchema = z.record(McpServerEntrySchema).default({});

// ── Browser ─────────────────────────────────────────────────────────────────

const BrowserConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).default({});

// ── Proactive Intelligence ──────────────────────────────────────────────────

export const ProactiveConfigSchema = z.object({
  /** Whether the proactive intelligence layer is enabled */
  enabled: z.boolean().default(true),
  /** Interval in minutes between Tier 2 triage runs */
  tier2IntervalMinutes: z.number().default(15),
  /** Model to use for Tier 2 triage (fast, cheap) */
  tier2Model: z.string().default("claude-haiku-4-5"),
  /** Model to use for Tier 3 escalation (deep reasoning) */
  tier3Model: z.string().default("claude-opus-4-8[1m]"),
  /** Active hours — proactive notifications only fire within this window */
  activeHours: z.object({
    start: z.string().default("00:00"),
    end: z.string().default("23:59"),
    timezone: z.string().default("Africa/Cairo"),
  }).default({}),
  /** Time of day for the daily digest (HH:MM format) */
  dailyDigestTime: z.string().default("09:00"),
  /** Path to the heartbeat checklist file */
  heartbeatFile: z.string().default("~/.kirie/HEARTBEAT.md"),
  /** RSS memory threshold in MB before triggering a high-memory warning */
  memoryThresholdMB: z.number().int().min(128).default(1024),
  /** Cooldown in minutes before re-notifying about the same signal type (0 = no cooldown) */
  notificationCooldownMinutes: z.number().min(0).default(60),
  /** Heartbeat logging configuration */
  heartbeatLogging: z.object({
    enabled: z.boolean().default(true),
    /** Per-tier minimum log levels */
    levels: z.object({
      tier1: z.enum(["debug", "info", "warn", "error"]).default("info"),
      tier2: z.enum(["debug", "info", "warn", "error"]).default("info"),
      tier3: z.enum(["debug", "info", "warn", "error"]).default("debug"),
      heartbeat: z.enum(["debug", "info", "warn", "error"]).default("info"),
    }).default({}),
    /** Per-tier retention in days (0 = keep forever) */
    retention: z.object({
      tier1: z.number().int().min(0).default(7),
      tier2: z.number().int().min(0).default(30),
      tier3: z.number().int().min(0).default(0),
      heartbeat: z.number().int().min(0).default(14),
    }).default({}),
    /** Custom database path */
    dbPath: z.string().optional(),
  }).default({}),
}).default({});

// ── Messages TTS ────────────────────────────────────────────────────────────

const EdgeTTSConfigSchema = z.object({
  enabled: z.boolean().default(true),
  voice: z.string().default("en-US-AriaNeural"),
});

const KokoroTTSConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(18790),
  voice: z.string().default("af_heart"),
  lang: z.string().default("a"),
  speed: z.number().default(1.0),
  pythonPath: z.string().default("python3"),
  daemonScript: z.string().default(""),
});

const MessagesTTSConfigSchema = z.object({
  auto: z.enum(["off", "edge", "kokoro", "openai", "elevenlabs"]).default("off"),
  provider: z.enum(["edge", "kokoro", "openai", "elevenlabs"]).default("edge"),
  edge: EdgeTTSConfigSchema.default({}),
  kokoro: KokoroTTSConfigSchema.default({}),
}).default({});

const MessagesConfigSchema = z.object({
  tts: MessagesTTSConfigSchema,
}).default({});

// ── Root ─────────────────────────────────────────────────────────────────────

export const KirieConfigSchema = z.object({
  agent: AgentConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  channels: ChannelsConfigSchema.default({}),
  memory: MemoryConfigSchema.default({}),
  gateway: GatewayConfigSchema.default({}),
  plugins: z.array(PluginEntrySchema).default([]),
  agents: z.array(AgentDefinitionSchema).default([]),
  canvas: CanvasConfigSchema.default({}),
  tools: ToolsConfigSchema,
  logging: LoggingConfigSchema,
  mediaUnderstanding: MediaUnderstandingSchema,
  voice: VoiceConfigSchema,
  routing: RoutingConfigSchema,
  sandbox: SandboxConfigSchema,
  nodes: NodesConfigSchema,
  browser: BrowserConfigSchema,
  proactive: ProactiveConfigSchema,
  /** External MCP servers to connect alongside the built-in kirie-tools server. */
  mcpServers: McpServersConfigSchema,
  /** Message-level settings (TTS, etc.) */
  messages: MessagesConfigSchema,
});

export type KirieConfig = z.infer<typeof KirieConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type LoggingConfig = z.infer<typeof LoggingConfigSchema>;
export type MediaUnderstandingConfig = z.infer<typeof MediaUnderstandingSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type SandboxSchemaConfig = z.infer<typeof SandboxConfigSchema>;
export type NodesConfig = z.infer<typeof NodesConfigSchema>;
export type ProactiveConfig = z.infer<typeof ProactiveConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;
export type MessagesConfig = z.infer<typeof MessagesConfigSchema>;
export type MessagesTTSConfig = z.infer<typeof MessagesTTSConfigSchema>;

/**
 * Pattern for detecting $credential:key references in string values.
 * Matches strings like "$credential:telegram.bot_token".
 */
export const CREDENTIAL_REF_PATTERN = /^\$credential:(.+)$/;
