/**
 * Feature-module registration (PLAN B.10).
 *
 * Every feature is one `FeatureSetup` in `features/<name>.ts`, listed once in
 * `features/index.ts`. `startDaemon` builds a `DaemonContext`, runs every
 * setup (phase 1: construct stores, register commands, gates, contributors,
 * observers, addenda, internal routes; no I/O loops), starts the core
 * subsystems, then calls each handle's `start` (phase 2: timers, listeners,
 * network). `stopDaemon` calls each `stop` in reverse order first.
 */

import type {
  KirieConfig,
  CommandRegistry,
  OwnerDirectory,
  OwnerPrompts,
  RuntimeSettings,
  AuditTrail,
  SecretScrubber,
  SdkOptionsPipeline,
  TurnContextRegistry,
  PromptAddenda,
  InternalApi,
  PublicIngress,
  ChannelRegistry,
  IdentityResolver,
  CredentialStore,
  SessionStore,
  MessagePipeline,
  HeartbeatService,
  ProactiveEngine,
  BackgroundTaskStore,
  BackgroundTaskManager,
  ScheduleStore,
  ChatHistoryStore,
  MemoryManagerLike,
  EmbeddingProvider,
  AgentEngine,
  V2SessionManager,
  McpServerConfig,
  HeartbeatLogStore,
  UsageDashboard,
} from "@kirie/core";
import type { TaskHooks } from "../task-hooks.js";

export interface DaemonContext {
  readonly config: KirieConfig;
  /** ~/.kirie */
  readonly dataDir: string;
  /** config.agent.workspace || dataDir */
  readonly agentCwd: string;

  // Shared contracts
  readonly commands: CommandRegistry;
  readonly owners: OwnerDirectory;
  readonly ownerPrompts: OwnerPrompts;
  readonly settings: RuntimeSettings;
  readonly audit: AuditTrail;
  readonly scrubber: SecretScrubber;
  readonly sdkOptions: SdkOptionsPipeline;
  readonly turnContext: TurnContextRegistry;
  readonly promptAddenda: PromptAddenda;
  readonly internalApi: InternalApi;
  readonly ingress: PublicIngress;
  /** Background-task controllers and profiles, keyed by `meta.profile` (PLAN B.14) */
  readonly taskHooks: TaskHooks;

  // Existing subsystems
  readonly channelRegistry: ChannelRegistry;
  readonly identityResolver: IdentityResolver;
  readonly credentialStore: CredentialStore;
  readonly sessionStore: SessionStore;
  readonly pipeline: MessagePipeline;
  readonly heartbeat: HeartbeatService;
  /** Constructed whenever an owner identity exists; started only if `proactive.enabled` is effective */
  readonly proactive: ProactiveEngine | null;
  readonly heartbeatLogStore: HeartbeatLogStore | null;
  readonly backgroundTaskStore: BackgroundTaskStore;
  readonly backgroundTaskManager: BackgroundTaskManager;
  readonly scheduleStore: ScheduleStore;
  readonly chatHistoryStore: ChatHistoryStore;
  readonly memoryManager: MemoryManagerLike | null;
  readonly embeddingProvider: EmbeddingProvider | null;
  readonly agentEngine: AgentEngine;
  /** Set when agent.sessionMode is "v2" */
  readonly v2Sessions: V2SessionManager | null;
  readonly usageDashboard: UsageDashboard;

  /** The live objects every engine reads at spawn time. Features may add keys during setup, before sessions start. */
  readonly mcpServers: Record<string, McpServerConfig>;
  /** The kirie-tools MCP server env (KIRIE_* flags read by feature tool factories) */
  readonly kirieToolsEnv: Record<string, string>;

  /**
   * One plain line to the owner's DM on the primary channel. Scrubbed. With `key`, at most one per key per 10 minutes;
   * with `always` (a real state change) it is sent anyway and the key recorded.
   */
  notifyOwner(text: string, opts?: { key?: string; always?: boolean; disableLinkPreview?: boolean }): Promise<void>;
  /** Restart the daemon (stop then start, same process). */
  restart(): void;
}

export interface FeatureHandle {
  name: string;
  /** Set by the runner from `FeatureEntry.security`. */
  security?: string;
  /** Phase 2: timers, listeners, network. Runs after channels, heartbeat and the task manager have started. */
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/** Phase 1: construct stores; register commands, gates, contributors, observers, addenda, internal routes, kind handlers. No I/O loops. */
export type FeatureSetup = (ctx: DaemonContext) => FeatureHandle | Promise<FeatureHandle>;

/** One entry of FEATURES. The name is used when a setup throws (it then has no handle). */
export interface FeatureEntry {
  readonly name: string;
  readonly setup: FeatureSetup;
  /**
   * For a security feature: the protection Kirie runs without when this
   * feature fails (CONF-N14). Its failure is logged as an error and named in
   * the owner notice first.
   */
  readonly security?: string;
}
