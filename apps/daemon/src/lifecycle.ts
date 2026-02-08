import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import pino from "pino";
import {
  type KirieConfig,
  ConfigWatcher,
  AgentEngine,
  type AgentEngineConfig,
  SessionStore,
  ChannelRegistry,
  IdentityResolver,
  AuthorizationEngine,
  RateLimiter,
  InputGuard,
  SecurityGate,
  MessagePipeline,
  GatewayServer,
  HeartbeatService,
  createMcpToolRegistry,
  createSdkMcpServerFromTools,
  type ScheduleFireEvent,
} from "@kirie/core";
import {
  BackgroundTaskStore,
  BackgroundTaskManager,
  AutoReplyEngine,
  registerBuiltinCommands,
} from "@kirie/core";
import { loadAllSkills, isEligible } from "@kirie/skills";
import type { McpServerOptions } from "@kirie/core";
import { AgentRegistry } from "@kirie/core";
import { UsageTracker, UsageDashboard } from "@kirie/core";
import { ProactiveEngine, type HeartbeatTickEvent, HeartbeatLogStore } from "@kirie/core";
import type { HeartbeatLogLevel } from "@kirie/core";
import { MemoryManager, VectorStore, OpenAIEmbeddings, NoopEmbeddings, LocalEmbeddings } from "@kirie/memory";
import { MemoryStore, CredentialStore } from "@kirie/core";
import type { CredentialResolver } from "@kirie/core";
import { TelegramAdapter } from "@kirie/channel-telegram";
import { DiscordAdapter } from "@kirie/channel-discord";
import { SlackAdapter } from "@kirie/channel-slack";
import { WhatsAppAdapter } from "@kirie/channel-whatsapp";
import { SignalAdapter } from "@kirie/channel-signal";

const log = pino({ name: "kirie-daemon" });

/**
 * Holds all initialized subsystems so shutdown can cleanly tear them down.
 */
interface DaemonState {
  configWatcher: ConfigWatcher;
  config: KirieConfig;
  sessionStore: SessionStore;
  channelRegistry: ChannelRegistry;
  rateLimiter: RateLimiter;
  pipeline: MessagePipeline;
  gateway: GatewayServer;
  heartbeat: HeartbeatService;
  mcpShutdown: () => void;
  backgroundTaskManager: BackgroundTaskManager;
  backgroundTaskStore: BackgroundTaskStore;
  usageTracker: UsageTracker;
  proactive: ProactiveEngine | null;
  heartbeatLogStore: HeartbeatLogStore | null;
}

let state: DaemonState | null = null;
let shuttingDown = false;
let restarting = false;
let signalHandlersRegistered = false;

/**
 * Start the Kirie daemon.
 *
 * Initialization sequence:
 *   1. Load and validate config
 *   2. Create SessionStore (SQLite)
 *   3. Resolve MCP server paths
 *   4. Create AgentEngine with V1 query() + MCP server config
 *   5. Create security components (auth, authz, rate limiter, input guard)
 *   6. Create SecurityGate
 *   7. Set up MCP tool registry
 *   8. Create MessagePipeline and wire message flow
 *   9. Start channels
 *  10. Create and start HeartbeatService
 *  11. Start background task manager
 *  12. Start gateway HTTP server
 *  13. Register signal handlers for graceful shutdown
 */
export async function startDaemon(): Promise<void> {
  log.info("starting Kirie daemon");

  // 1. Load config with credential resolution
  const credentialStore = new CredentialStore();
  const storedKeys = credentialStore.list();
  const credentialCache = new Map<string, string>();
  for (const key of storedKeys) {
    const val = await credentialStore.get(key);
    if (val !== undefined) credentialCache.set(key, val);
  }
  const credentialResolver: CredentialResolver = {
    get(key: string) { return credentialCache.get(key); },
  };

  const configWatcher = new ConfigWatcher({ credentialResolver });
  const config = configWatcher.start();
  log.info("configuration loaded");

  // 2. Session store
  const sessionStore = new SessionStore();
  log.info({ sessions: sessionStore.count() }, "session store initialized");

  // 3. Resolve paths
  const dataDir = join(homedir(), ".kirie");
  ensureDataDir(dataDir);

  // Resolve the stdio-server entry point path dynamically from the @kirie/core package.
  // createRequire resolves through pnpm workspace links to the actual package location.
  const require = createRequire(import.meta.url);
  const coreDistDir = dirname(require.resolve("@kirie/core"));
  const stdioServerPath = resolve(join(coreDistDir, "mcp", "stdio-server.js"));

  // Build the stdio MCP server config for V1 query() calls.
  // V1 query() passes this to each subprocess so it spawns the kirie-tools MCP server.
  const gatewayPort = config.gateway.port;
  const mcpServers = {
    "kirie-tools": {
      command: "node",
      args: [stdioServerPath],
      env: {
        KIRIE_DB_DIR: resolve(dataDir),
        KIRIE_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        ...(config.browser?.enabled ? { KIRIE_BROWSER_ENABLED: "1" } : {}),
      },
    },
  };
  log.info({ stdioServerPath }, "MCP server config resolved");

  // Background task store
  const backgroundTaskStore = new BackgroundTaskStore(join(dataDir, "background-tasks.db"));

  // Usage tracking
  const usageTracker = new UsageTracker(join(dataDir, "usage.db"));
  const usageDashboard = new UsageDashboard(usageTracker.getDb());
  log.info("usage tracker initialized");

  // Allowed tools include both MCP and built-in tools
  const allowedTools = [
    // Kirie MCP tools
    "mcp__kirie-tools__memory_store",
    "mcp__kirie-tools__memory_recall",
    "mcp__kirie-tools__memory_search",
    "mcp__kirie-tools__memory_list",
    "mcp__kirie-tools__memory_delete",
    "mcp__kirie-tools__schedule_create",
    "mcp__kirie-tools__schedule_list",
    "mcp__kirie-tools__schedule_delete",
    "mcp__kirie-tools__send_message",
    "mcp__kirie-tools__list_channels",
    "mcp__kirie-tools__chat_history_recent",
    "mcp__kirie-tools__chat_history_search",
    "mcp__kirie-tools__background_task_create",
    "mcp__kirie-tools__background_task_list",
    "mcp__kirie-tools__background_task_result",
    "mcp__kirie-tools__background_task_cancel",
    "mcp__kirie-tools__background_task_send_message",
    "mcp__kirie-tools__memory_semantic_search",
    "mcp__kirie-tools__memory_reindex",
    "mcp__kirie-tools__daily_note_append",
    "mcp__kirie-tools__daily_note_read",
    "mcp__kirie-tools__chat_history_semantic_search",
    "mcp__kirie-tools__agents_list",
    "mcp__kirie-tools__agents_status",
    "mcp__kirie-tools__canvas",
    "mcp__kirie-tools__session_list",
    "mcp__kirie-tools__session_history",
    "mcp__kirie-tools__session_status",
    "mcp__kirie-tools__channel_action",
    "mcp__kirie-tools__gateway_status",
    "mcp__kirie-tools__gateway_config_reload",
    "mcp__kirie-tools__gateway_restart",
    "mcp__kirie-tools__web_fetch",
    "mcp__kirie-tools__web_search",
    "mcp__kirie-tools__browser",
    "mcp__kirie-tools__image",
    "mcp__kirie-tools__tts",
    "mcp__kirie-tools__sessions_spawn",
    "mcp__kirie-tools__sessions_send",
    "mcp__kirie-tools__discord_action",
    "mcp__kirie-tools__telegram_action",
    "mcp__kirie-tools__slack_action",
    "mcp__kirie-tools__whatsapp_action",
    "mcp__kirie-tools__voice_call_initiate",
    "mcp__kirie-tools__voice_call_status",
    "mcp__kirie-tools__voice_call_list",
    "mcp__kirie-tools__voice_call_hangup",
    "mcp__kirie-tools__proactive_status",
    "mcp__kirie-tools__proactive_trigger",
    "mcp__kirie-tools__heartbeat_log_search",
    "mcp__kirie-tools__heartbeat_log_semantic_search",
    "mcp__kirie-tools__heartbeat_log_time_range",
    "mcp__kirie-tools__heartbeat_log_by_tier",
    "mcp__kirie-tools__heartbeat_log_recent",
    // Built-in Claude Code tools — auto-allow so agents don't hit permission prompts
    "Bash(*)",
    "Read",
    "Write",
    "Edit",
    "MultiEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "NotebookEdit",
    "Task",
    "Skill",
  ];

  // ── Embedding provider + MemoryManager (created early so reindex can run after startup) ──
  const embCfg = config.memory?.embeddings;
  const embProvider = embCfg?.provider ?? "local";
  const embApiKey = embCfg?.apiKey || process.env.OPENAI_API_KEY;
  const embModel = embCfg?.model;

  // First-run model download check for local embeddings
  if (embProvider === "local") {
    const { isModelDownloaded, ensureModelDownloaded } = await import("@kirie/memory");
    if (!isModelDownloaded()) {
      log.info("downloading local embedding model (snowflake-arctic-embed-s)...");
      await ensureModelDownloaded({
        onProgress: (file: string, received: number, total: number) => {
          if (total) log.info({ file, pct: Math.round(received / total * 100) }, "downloading");
        },
      });
      log.info("embedding model ready");
    }
  }

  // First-run Playwright setup when browser is enabled
  if (config.browser?.enabled) {
    log.info("browser enabled — checking playwright-core and Chromium status...");
    const { checkPlaywrightStatus, ensurePlaywrightInstalled } = await import("@kirie/core");
    const status = await checkPlaywrightStatus();

    if (!status.installed || !status.browserReady) {
      log.info({ installed: status.installed, browserReady: status.browserReady }, "playwright not ready — installing...");
      await ensurePlaywrightInstalled({
        onProgress: (step) => log.info(step),
      });
      log.info("playwright and Chromium browser ready");
    } else {
      log.info("playwright and Chromium already available");
    }
  }

  let memoryManager: InstanceType<typeof MemoryManager> | undefined;
  let embeddingProvider: import("@kirie/memory").EmbeddingProvider | undefined;
  try {
    const ms = new MemoryStore(join(dataDir, "memory.db"));
    const vs = new VectorStore(join(dataDir, "vectors.db"));

    let ep: import("@kirie/memory").EmbeddingProvider;
    if (embProvider === "local") {
      ep = new LocalEmbeddings({ model: embModel });
      log.info({ model: ep.model }, "Local ONNX embeddings enabled — semantic search active (no API key needed)");
    } else if (embProvider === "openai" && embApiKey) {
      ep = new OpenAIEmbeddings({ apiKey: embApiKey, model: embModel ?? "text-embedding-3-small" });
      log.info({ model: ep.model }, "OpenAI embeddings enabled — semantic search active");
    } else if (embProvider === "noop") {
      ep = new NoopEmbeddings();
      log.info("Embedding provider set to noop — semantic search disabled");
    } else {
      // openai provider but no API key — fall back to local
      ep = new LocalEmbeddings({ model: embModel });
      log.warn("No OpenAI API key found, falling back to local embeddings — semantic search active");
    }

    embeddingProvider = ep;
    memoryManager = new MemoryManager({
      memoryStore: ms as unknown as import("@kirie/memory").MemoryStore,
      vectorStore: vs,
      embeddingProvider: ep,
    });
    log.info("MemoryManager initialized");
  } catch (err) {
    log.warn({ err }, "Failed to initialize MemoryManager (falling back to FTS5 only)");
  }

  // 4a. Load skills and write them as Claude Code skills (.claude/skills/)
  // The SDK's built-in Skill tool discovers skills from {cwd}/.claude/skills/{name}/SKILL.md
  // We transform Kirie's frontmatter to Claude Code's format (e.g. user-invocable, disable-model-invocation)
  const skillsDir = resolve(join(dirname(require.resolve("@kirie/core")), "../../../skills"));
  const allSkills = loadAllSkills({ bundledDir: skillsDir });
  const eligibleSkills = allSkills.filter(isEligible);
  log.info({ total: allSkills.length, eligible: eligibleSkills.length }, "skills loaded");

  const agentCwd = config.agent.workspace || dataDir;
  const sdkSkillsDir = resolve(join(agentCwd, ".claude", "skills"));
  for (const skill of eligibleSkills) {
    const skillDir = join(sdkSkillsDir, skill.name);
    mkdirSync(skillDir, { recursive: true });

    // Build Claude Code-compatible frontmatter
    const fm: string[] = ["---"];
    fm.push(`name: ${skill.name}`);
    fm.push(`description: ${skill.description}`);
    if (skill.invocation?.userInvocable === false) {
      fm.push("user-invocable: false");
    }
    if (skill.invocation?.disableModelInvocation === true) {
      fm.push("disable-model-invocation: true");
    }
    fm.push("---");

    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, fm.join("\n") + "\n\n" + skill.content, "utf-8");
  }
  log.info({ sdkSkillsDir, count: eligibleSkills.length }, "skills written as Claude Code skills");

  // 4b. Create agent registry
  const agentRegistry = new AgentRegistry();
  if (config.agents) {
    for (const agentDef of config.agents as import("@kirie/core").AgentDefinition[]) {
      agentRegistry.register(agentDef);
    }
    log.info({ agents: agentRegistry.list().length }, "agent definitions loaded");
  }

  // 4. Agent engine (uses V1 query() with mcpServers passed directly)
  const agentConfig: AgentEngineConfig = {
    prompt: {
      customInstructions: config.agent.customInstructions,
      maxTurns: config.agent.maxTurns,
      model: config.agent.model,
      dataDir,
    },
    cwd: config.agent.workspace || dataDir,
    allowedTools,
    mcpServers,
  };
  const agentEngine = new AgentEngine(agentConfig);
  log.info({ model: config.agent.model, maxTurns: config.agent.maxTurns }, "agent engine created (V1 mode with MCP)");

  // 5. Security components
  const identityResolver = new IdentityResolver({
    securityConfig: config.security,
  });

  const authzEngine = new AuthorizationEngine({
    dmPolicy: config.security.dmPolicy,
    groupPolicy: config.security.groupPolicy,
  });

  const rateLimiter = new RateLimiter({
    securityConfig: config.security,
  });

  const inputGuard = new InputGuard();

  // 6. Security gate (with per-channel restrictions from channel config)
  const channelRestrictions: Record<string, { allowedUserIds?: (string | number)[]; allowGroups?: boolean }> = {};
  for (const [name, chConf] of Object.entries(config.channels)) {
    const ch = chConf as { allowedUserIds?: (string | number)[]; allowGroups?: boolean };
    if ((ch.allowedUserIds && ch.allowedUserIds.length > 0) || ch.allowGroups === false) {
      channelRestrictions[name] = {
        allowedUserIds: ch.allowedUserIds,
        allowGroups: ch.allowGroups,
      };
    }
  }

  const securityGate = new SecurityGate({
    identityResolver,
    authzEngine,
    rateLimiter,
    inputGuard,
    channelRestrictions,
  });
  log.info("security gate initialized");

  // 7. MCP tools + Channel registration
  const channelRegistry = new ChannelRegistry();
  registerChannelAdapters(channelRegistry, config);

  // Late-binding reference so ProactiveEngine closures can access heartbeat after it's created
  const heartbeatRef: { instance: HeartbeatService | null } = { instance: null };

  // 7a. Create HeartbeatLogStore early (before ProactiveEngine so it can use triage context injection)
  const hbLogging = config.proactive?.heartbeatLogging;
  const hbLogEnabled = hbLogging?.enabled !== false;
  const hbLogDbPath = hbLogging?.dbPath ?? join(dataDir, "heartbeat-logs.db");
  const hbLogLevels = hbLogging?.levels;
  const hbLogRetention = hbLogging?.retention;
  let heartbeatLogStore: HeartbeatLogStore | null = null;
  if (hbLogEnabled) {
    heartbeatLogStore = new HeartbeatLogStore(hbLogDbPath, embeddingProvider as any, hbLogLevels as any);
    log.info("heartbeat log store initialized");
  }

  // 7b. Create ProactiveEngine (before MCP registry so tools can reference it)
  let proactive: ProactiveEngine | null = null;
  if (config.proactive?.enabled) {
    const ownerIds = config.security.owner.identities;
    let defaultChannel = "telegram" as import("@kirie/core").ChannelName;
    let defaultChatId = "";

    if (ownerIds.telegram.length > 0) {
      defaultChannel = "telegram";
      defaultChatId = String(ownerIds.telegram[0]);
    } else if (ownerIds.discord.length > 0) {
      defaultChannel = "discord";
      defaultChatId = String(ownerIds.discord[0]);
    } else if (ownerIds.slack.length > 0) {
      defaultChannel = "slack";
      defaultChatId = String(ownerIds.slack[0]);
    }

    if (defaultChatId) {
      proactive = new ProactiveEngine({
        config: config.proactive,
        channelRegistry,
        sessionStore,
        defaultChannel,
        defaultChatId,
        getRunningTasks: () => {
          try {
            const tasks = backgroundTaskStore.listByStatus("running");
            return tasks.map((t) => ({
              id: t.id,
              description: t.description,
              startedAt: new Date(t.created_at).getTime(),
              status: t.status,
            }));
          } catch {
            return [];
          }
        },
        getFailedDeliveryCount: () => {
          // Heartbeat not created yet at this point, but the callback is
          // called later when ticks fire, by which time heartbeat exists.
          return heartbeatRef.instance?.pendingRetryCount ?? 0;
        },
        createBackgroundTask: (sessionKey: string, description: string, prompt: string) => {
          backgroundTaskStore.create(sessionKey, description, prompt);
        },
        heartbeatLogStore: heartbeatLogStore ?? undefined,
      });
      log.info("proactive engine created");
    } else {
      log.warn("proactive layer enabled but no owner identities configured — skipping");
    }
  }

  const { mcpShutdown, tools, scheduleStore, chatHistoryStore, sdkMcpServer } = createMcpRegistry(
    channelRegistry,
    {
      sessionStore,
      configReload: async () => !!configWatcher.reload(),
      agentRegistry,
      dataDir,
      config,
      memoryManager: memoryManager as unknown as McpServerOptions["memoryManager"],
      embeddingProvider,
      onRestart: () => void restartDaemon(),
      proactiveEngine: proactive,
      heartbeatLogStore: heartbeatLogStore ?? undefined,
    },
  );
  log.info({ toolCount: tools.size }, "MCP tools registered");

  // 8. Auto-reply engine (fast command responses, bypasses agent)
  const autoReply = new AutoReplyEngine();
  // Register basic commands now; stop/stopall/clear added after pipeline is created
  registerBuiltinCommands(autoReply, { channelRegistry, sessionStore });
  log.info("auto-reply engine initialized");

  // 9. Message pipeline
  const pipeline = new MessagePipeline({
    channelRegistry,
    securityGate,
    sessionStore,
    agentEngine,
    chatHistoryStore,
    backgroundTaskStore,
    autoReply,
    usageTracker,
    model: config.agent.model,
  });

  // 9. Start channels
  pipeline.start();
  const channelErrors = await channelRegistry.startAll();
  for (const [id, err] of channelErrors) {
    log.error({ channel: id, error: err.message }, "failed to start channel");
  }

  const running = channelRegistry.getRunning();
  log.info({ channels: running }, "channels started");

  // 10. HeartbeatService
  const heartbeat = new HeartbeatService({
    sessionStore,
    channelRegistry,
    scheduleStore,
    onScheduleFire: async (event: ScheduleFireEvent) => {
      // Route the scheduled message through the channel adapter
      const adapter = channelRegistry.getById(event.channel);
      if (!adapter) {
        throw new Error(`Channel "${event.channel}" not found for schedule "${event.name}"`);
      }
      await adapter.sendText({
        ctx: { chatId: event.chatId },
        text: event.message,
      });
    },
    onRetryDelivery: async (delivery) => {
      const adapter = channelRegistry.getById(delivery.channel);
      if (!adapter) {
        throw new Error(`Channel "${delivery.channel}" not found for retry`);
      }
      await adapter.sendText({
        ctx: { chatId: delivery.chatId, threadId: delivery.threadId },
        text: delivery.text,
      });
    },
  });

  // Wire ScheduleStore "fire" events to the heartbeat
  scheduleStore.on("fire", (event: ScheduleFireEvent) => {
    heartbeat.enqueueScheduleEvent(event);
  });

  heartbeat.start();
  heartbeatRef.instance = heartbeat;
  log.info("heartbeat service started");

  // 10b. Wire heartbeat logging + proactive engine to heartbeat ticks
  let lastTickNumber = 0;

  heartbeat.on("tick", (event: HeartbeatTickEvent) => {
    lastTickNumber = event.tickNumber;

    // Forward to proactive engine
    proactive?.onTick(event);

    // Log heartbeat tick summary (only when something happened)
    if (heartbeatLogStore) {
      const hasFires = (event as any).scheduleFires > 0;
      const hasRetries = (event as any).pendingRetries > 0;
      const hasPrunes = (event as any).sessionsPruned > 0;
      if (hasFires || hasRetries || hasPrunes) {
        heartbeatLogStore.log({
          tick_number: event.tickNumber,
          tier: "heartbeat",
          category: "tick_summary",
          level: "debug",
          title: `Tick ${event.tickNumber}: ${hasFires ? "schedules fired" : ""}${hasRetries ? " retries pending" : ""}${hasPrunes ? " sessions pruned" : ""}`.trim(),
          content: `scheduleFires=${(event as any).scheduleFires ?? 0}, pendingRetries=${(event as any).pendingRetries ?? 0}, sessionsPruned=${(event as any).sessionsPruned ?? 0}`,
        });
      }

      // Auto-pruning on prune ticks (every ~10 minutes)
      if (event.tickNumber % 60 === 0 && hbLogRetention) {
        const pruned = heartbeatLogStore.pruneOldLogs({
          tier1: hbLogRetention.tier1 ?? 7,
          tier2: hbLogRetention.tier2 ?? 30,
          tier3: hbLogRetention.tier3 ?? 0,
          heartbeat: hbLogRetention.heartbeat ?? 14,
        });
        if (pruned > 0) {
          log.debug({ pruned }, "heartbeat logs pruned");
        }
      }
    }
  });

  // Wire specific heartbeat events to the log store
  if (heartbeatLogStore) {
    heartbeat.on("scheduleFired", (event: any) => {
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "heartbeat",
        category: "schedule_fired",
        level: "info",
        title: `Schedule fired: ${event.name ?? "unnamed"}`,
        content: `Channel: ${event.channel}, chatId: ${event.chatId}`,
        metadata: event,
      });
    });

    heartbeat.on("deliveryRetried", (event: any) => {
      const succeeded = event.success !== false;
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "heartbeat",
        category: "delivery_retry",
        level: succeeded ? "info" : "warn",
        title: `Delivery retry ${succeeded ? "succeeded" : "failed"}: ${event.channel ?? "unknown"}`,
        content: `chatId: ${event.chatId ?? "?"}, attempt: ${event.attempt ?? "?"}`,
        metadata: event,
      });
    });

    heartbeat.on("sessionsPruned", (event: any) => {
      const count = typeof event === "number" ? event : event?.count ?? 0;
      if (count > 0) {
        heartbeatLogStore!.log({
          tick_number: lastTickNumber,
          tier: "heartbeat",
          category: "session_prune",
          level: "info",
          title: `Pruned ${count} expired session(s)`,
          content: `Sessions pruned during heartbeat tick ${lastTickNumber}`,
          metadata: { count },
        });
      }
    });
  }

  // Wire proactive engine events to heartbeat log store
  if (proactive && heartbeatLogStore) {
    proactive.on("signalDetected", (signal) => {
      const levelMap: Record<string, HeartbeatLogLevel> = {
        critical: "error",
        high: "warn",
        medium: "info",
        low: "debug",
        info: "debug",
      };
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "tier1",
        category: "signal_detected",
        level: levelMap[signal.severity] ?? "info",
        title: signal.title,
        content: signal.details,
        metadata: { id: signal.id, type: signal.type, severity: signal.severity, source: signal.source },
      });
    });

    proactive.on("triageCompleted", (result) => {
      // Only log when something happened — skip empty triage runs
      if (result.decisions.length === 0) return;
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "tier2",
        category: "triage_decision",
        level: "info",
        title: `Triage completed: ${result.signalsProcessed} signals, ${result.decisions.length} decisions`,
        content: result.decisions.map((d) => `${d.action}${d.signalId ? ` (${d.signalId})` : ""}: ${d.message ?? "no message"}`).join("; "),
        metadata: { signalsProcessed: result.signalsProcessed, decisions: result.decisions },
      });
    });

    proactive.on("notificationSent", (info) => {
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "tier2",
        category: "notification_sent",
        level: "info",
        title: `Notification sent to ${info.channel}:${info.chatId}`,
        content: info.message,
        metadata: info,
      });
    });

    proactive.on("escalationSpawned", (info) => {
      heartbeatLogStore!.log({
        tick_number: lastTickNumber,
        tier: "tier3",
        category: "escalation",
        level: "info",
        title: `Escalation spawned: ${info.decision.message ?? "investigate signal"}`,
        content: `Session: ${info.sessionKey}, action: ${info.decision.action}`,
        metadata: { decision: info.decision, sessionKey: info.sessionKey },
      });
    });
  }

  if (proactive) {
    proactive.start();
    log.info("proactive intelligence layer started");
  }

  // 11. Background task manager (uses V1 query() with mcpServers)
  const backgroundTaskManager = new BackgroundTaskManager(backgroundTaskStore, {
    model: config.agent.model,
    mcpServers,
    allowedTools,
    cwd: config.agent.workspace || dataDir,
    onTaskComplete: async (task) => {
      // Push completed task result proactively to the originating channel
      await pipeline.pushBackgroundTaskResult(task);
    },
  });

  backgroundTaskManager.resumeOnStartup();
  backgroundTaskManager.start();
  log.info("background task manager started");

  // Register stop/stopall/clear/restart/context/usage commands now that pipeline + backgroundTaskManager exist
  registerBuiltinCommands(autoReply, {
    channelRegistry,
    sessionStore,
    pipeline,
    backgroundTaskManager,
    onRestart: () => void restartDaemon(),
    chatHistoryStore,
    usageDashboard,
  });

  // Register slash commands with channels that support it (e.g. Telegram setMyCommands)
  // Done after all commands are registered so /context, /usage etc. are included.
  const botCommands = autoReply.listCommands().map((c) => ({
    command: c.name.replace(/^\//, ""),
    description: c.description,
  }));
  for (const [, adapter] of channelRegistry.getAll()) {
    if (typeof adapter.registerCommands === "function") {
      void adapter.registerCommands(botCommands).catch((err: unknown) => {
        log.warn({ channel: adapter.id, err }, "failed to register slash commands");
      });
    }
  }

  // 12. Gateway server
  const gateway = new GatewayServer({
    config: config.gateway,
    deps: {
      channelRegistry,
      sessionStore,
      usageDashboard,
      onConfigReload: async () => {
        const reloaded = configWatcher.reload();
        if (reloaded) {
          log.info("configuration reloaded via gateway");
        }
      },
      onShutdown: () => {
        log.info("shutdown requested via gateway");
        void stopDaemon();
      },
      onRestart: () => {
        log.info("restart requested via gateway");
        void restartDaemon();
      },
      proactiveEngine: proactive,
    },
  });

  const port = await gateway.start();
  log.info({ port, bind: config.gateway.bind }, "gateway server started");

  // Non-blocking auto-reindex of memory embeddings
  if (memoryManager) {
    void (memoryManager as any).reindex().then((r: any) => {
      if (r.processed > 0 || r.errors > 0) {
        log.info({ processed: r.processed, errors: r.errors, skipped: r.skipped }, "incremental reindex complete");
      }
    }).catch((err: unknown) => {
      log.warn({ err }, "background reindex failed");
    });
  }

  // 13. Save state for shutdown
  state = {
    configWatcher,
    config,
    sessionStore,
    channelRegistry,
    rateLimiter,
    pipeline,
    gateway,
    heartbeat,
    mcpShutdown,
    backgroundTaskManager,
    backgroundTaskStore,
    usageTracker,
    proactive,
    heartbeatLogStore,
  };

  // 14. Signal handlers (registered once to avoid stacking on restart)
  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;

    const handleSignal = (signal: string) => {
      log.info({ signal }, "received signal");
      void stopDaemon();
    };

    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    // Handle EPIPE errors from SDK subprocess pipes.
    // When query.close() kills a running agent subprocess, pending writes to
    // the subprocess's stdin pipe can emit EPIPE. This is expected during
    // agent interruption (/stop, /stopall, message interruption) and must
    // not crash the daemon.
    process.on("uncaughtException", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") {
        log.warn("EPIPE from subprocess pipe (agent interrupted, non-fatal)");
        return;
      }
      // During restart, errors from stale connections are expected (e.g. Telegram
      // long-polling overlap). Log but don't crash — startDaemon() will recover.
      if (restarting) {
        log.warn({ err }, "uncaught exception during restart (non-fatal)");
        return;
      }
      log.fatal({ err }, "uncaught exception — shutting down");
      void stopDaemon().finally(() => process.exit(1));
    });

    process.on("unhandledRejection", (reason) => {
      if (reason instanceof Error && (reason as NodeJS.ErrnoException).code === "EPIPE") {
        log.warn("EPIPE rejection from subprocess pipe (agent interrupted, non-fatal)");
        return;
      }
      // Grammy 409 Conflict ("terminated by other getUpdates request") is transient.
      // It happens when Telegram's previous long-polling session hasn't expired yet
      // (e.g. after a restart or when another process was recently running).
      // Grammy auto-retries internally, so this should not crash the daemon.
      if (reason != null && typeof reason === "object") {
        const r = reason as Record<string, unknown>;
        if (r.error_code === 409 || (r.name === "GrammyError" && typeof r.description === "string" && (r.description as string).includes("terminated by other getUpdates"))) {
          log.warn("Telegram 409 conflict (stale long-polling session, non-fatal — Grammy will retry)");
          return;
        }
      }
      if (restarting) {
        log.warn({ reason }, "unhandled rejection during restart (non-fatal)");
        return;
      }
      log.fatal({ reason }, "unhandled promise rejection — shutting down");
      void stopDaemon().finally(() => process.exit(1));
    });
  }

  log.info("Kirie daemon is running");
}

/**
 * Gracefully stop the Kirie daemon.
 *
 * Shutdown sequence:
 *   1. Stop background task manager
 *   2. Stop heartbeat service
 *   3. Stop accepting new messages (pipeline)
 *   4. Stop gateway HTTP server
 *   5. Stop all channel adapters
 *   6. Shut down MCP tools (close DB connections)
 *   7. Clean up rate limiter
 *   8. Close session store
 *   9. Close background task store
 *  10. Stop config watcher
 */
export async function stopDaemon(): Promise<void> {
  if (shuttingDown || !state) return;
  shuttingDown = true;

  log.info("beginning graceful shutdown");

  const {
    configWatcher, sessionStore, channelRegistry, rateLimiter,
    pipeline, gateway, heartbeat, mcpShutdown,
    backgroundTaskManager, backgroundTaskStore, usageTracker,
    proactive: proactiveEngine,
    heartbeatLogStore: hbLogStore,
  } = state;

  // 0. Stop proactive engine (before heartbeat so it stops receiving ticks)
  if (proactiveEngine) {
    proactiveEngine.stop();
    log.info("proactive engine stopped");
  }

  // 1. Stop background task manager
  await backgroundTaskManager.shutdown();
  log.info("background task manager stopped");

  // 2. Stop heartbeat
  heartbeat.stop();
  log.info("heartbeat service stopped");

  // 3. Stop the message pipeline (prevents new message processing)
  pipeline.stop();
  log.info("message pipeline stopped");

  // 4. Stop gateway
  try {
    await gateway.stop();
    log.info("gateway server stopped");
  } catch (err) {
    log.error({ err }, "error stopping gateway");
  }

  // 5. Stop all channels
  const channelErrors = await channelRegistry.stopAll();
  for (const [id, err] of channelErrors) {
    log.error({ channel: id, error: err.message }, "error stopping channel");
  }
  log.info("all channels stopped");

  // 6. MCP tool shutdown
  mcpShutdown();
  log.info("MCP tools shut down");

  // 7. Rate limiter cleanup
  rateLimiter.dispose();

  // 8. Close session store
  sessionStore.close();
  log.info("session store closed");

  // 9. Close background task store
  backgroundTaskStore.close();
  log.info("background task store closed");

  // 9b. Close usage tracker
  usageTracker.close();

  // 9c. Close heartbeat log store
  if (hbLogStore) {
    hbLogStore.close();
    log.info("heartbeat log store closed");
  }

  // 10. Stop config watcher
  await configWatcher.stop();
  log.info("config watcher stopped");

  log.info("Kirie daemon shutdown complete");

  state = null;
  shuttingDown = false;
}

/**
 * Restart the Kirie daemon without killing the process.
 *
 * Performs a full stop followed by a fresh start, re-reading config,
 * re-registering channels, and re-running all initialization checks.
 * Includes a brief delay between stop and start to allow network
 * connections (e.g. Telegram long-polling) to fully close.
 */
export async function restartDaemon(): Promise<void> {
  if (restarting) return; // prevent concurrent restarts
  restarting = true;
  log.info("restarting Kirie daemon");
  try {
    await stopDaemon();
    // Wait for network connections to fully close (Telegram long-polling,
    // Discord WebSocket, etc.) before starting fresh instances.
    await new Promise((r) => setTimeout(r, 2000));
    await startDaemon();
  } finally {
    restarting = false;
  }
}

/**
 * Read the config and register enabled channel adapters with the registry.
 */
function registerChannelAdapters(registry: ChannelRegistry, config: KirieConfig): void {
  const ch = config.channels;

  if (ch.telegram?.enabled && ch.telegram.token) {
    log.info("registering Telegram adapter");
    registry.register(new TelegramAdapter({ token: ch.telegram.token }));
  }

  if (ch.discord?.enabled && ch.discord.token) {
    log.info("registering Discord adapter");
    registry.register(new DiscordAdapter({ token: ch.discord.token }));
  }

  if (ch.slack?.enabled && ch.slack.botToken && ch.slack.appToken) {
    log.info("registering Slack adapter");
    registry.register(new SlackAdapter({
      botToken: ch.slack.botToken,
      appToken: ch.slack.appToken,
    }));
  }

  if (ch.whatsapp?.enabled) {
    log.info("registering WhatsApp adapter");
    registry.register(new WhatsAppAdapter({
      authDir: ch.whatsapp.sessionDataPath,
    }));
  }

  if (ch.signal?.enabled && ch.signal.phoneNumber) {
    log.info("registering Signal adapter");
    registry.register(new SignalAdapter({
      apiUrl: ch.signal.apiUrl,
      phoneNumber: ch.signal.phoneNumber,
    }));
  }

  log.info({ registered: registry.size }, "channel adapters registered");
}

/**
 * Ensure the data directory and seed context files exist.
 * Creates ~/.kirie, SOUL.md, MEMORY.md, and TOOLS.md if they are missing.
 */
function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });

  const soulPath = join(dataDir, "SOUL.md");
  if (!existsSync(soulPath)) {
    writeFileSync(
      soulPath,
      `# Soul

## Name
Kirie

## Tagline
(A short one-liner about who you are)

## Identity
- You are Kirie, a personal AI assistant.
- You communicate through messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal).
- You are loyal to your owner and act in their best interest.

## Mission
- Help your owner with tasks, questions, and daily life.
- Be proactive — anticipate needs, remember context, and follow through.
- Learn and adapt to your owner's preferences over time.

## Personality
- Friendly, direct, and concise.
- Avoids filler and unnecessary formality.
- Matches the owner's communication style over time.

## Boundaries
- Never share the owner's private information with others.
- Be honest — say "I don't know" rather than guessing.
- Ask for clarification when instructions are ambiguous.

## Communication Style
- Default language: English
- Tone: Casual but competent
- Use short messages in chat. Save long responses for when detail is needed.
`,
    );
    log.info("created seed SOUL.md");
  }

  const memoryPath = join(dataDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(
      memoryPath,
      `# Kirie Memory

## Owner
- (Agent will fill in owner details as it learns them)

## Preferences
- (Agent will record user preferences here)

## Important Events
- (Agent will log notable events here)

## Knowledge Index
Items stored in long-term memory DB (use memory_recall to retrieve details):
- (Agent will add keys here as it stores detailed info in the DB)
`,
    );
    log.info("created seed MEMORY.md");
  }

  const toolsPath = join(dataDir, "TOOLS.md");
  if (!existsSync(toolsPath)) {
    writeFileSync(
      toolsPath,
      `# Kirie Tools & Skills

## Built-in Tools
- memory_store, memory_recall, memory_search, memory_list, memory_delete — Long-term memory DB
- schedule_create, schedule_list, schedule_delete — Cron scheduling
- send_message, list_channels — Cross-channel messaging
- chat_history_recent, chat_history_search — Conversation history
- background_task_create, background_task_list, background_task_result, background_task_cancel, background_task_send_message — Async background tasks

## Learned Skills
Skills created by the agent through experience:
- (Agent will add skills here as it learns them)

## External Commands
- (Agent will document useful external commands here)

## Skill Index
Detailed skill docs stored in long-term memory DB (use memory_recall to retrieve):
- (Agent will add keys here for skills with large documentation)
`,
    );
    log.info("created seed TOOLS.md");
  }
}

/**
 * Helper to create the MCP tool registry with MemoryManager and AgentRegistry.
 */
function createMcpRegistry(
  channelRegistry: ChannelRegistry,
  opts?: {
    sessionStore?: SessionStore;
    configReload?: () => Promise<boolean>;
    agentRegistry?: AgentRegistry;
    dataDir?: string;
    config?: KirieConfig;
    memoryManager?: McpServerOptions["memoryManager"];
    embeddingProvider?: import("@kirie/memory").EmbeddingProvider;
    onRestart?: () => void;
    proactiveEngine?: ProactiveEngine | null;
    heartbeatLogStore?: HeartbeatLogStore;
  },
) {
  const result = createMcpToolRegistry({
    channelRegistry,
    sessionStore: opts?.sessionStore,
    configReload: opts?.configReload,
    agentRegistry: opts?.agentRegistry,
    memoryManager: opts?.memoryManager,
    onRestart: opts?.onRestart,
    proactiveEngine: opts?.proactiveEngine,
    heartbeatLogStore: opts?.heartbeatLogStore,
  });

  // Create an in-process SDK MCP server for potential V1 in-process fallback
  const sdkMcpServer = createSdkMcpServerFromTools(result.tools);

  return {
    tools: result.tools,
    mcpShutdown: result.shutdown,
    scheduleStore: result.scheduleStore,
    chatHistoryStore: result.chatHistoryStore,
    backgroundTaskStore: result.backgroundTaskStore,
    sdkMcpServer,
  };
}
