/**
 * A realistic DaemonContext for the audit tests (W4-INT items 7 and 8): real
 * registries and real stores in a temp data dir, fakes only for engines and
 * services that no feature setup drives. Every feature is switched on in the
 * config as far as the schema allows without credentials.
 */
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  AuditTrail,
  BackgroundTaskStore,
  ChannelRegistry,
  ChatHistoryStore,
  CommandRegistry,
  HeartbeatLogStore,
  InteractionRouter,
  InternalApi,
  KirieConfigSchema,
  MessagePipeline,
  OwnerDirectory,
  OwnerPrompts,
  PromptAddenda,
  PublicIngress,
  RuntimeSettings,
  ScheduleStore,
  SdkOptionsPipeline,
  SecretScrubber,
  SessionStore,
  TurnContextRegistry,
  type AgentExecutor,
  type SecurityGate,
} from "@kirie/core";
import type { DaemonContext } from "./types.js";
import { TaskHooks } from "../task-hooks.js";

export const AUDIT_OWNER = "1001";

/** Every feature switched on in config, as far as the schema allows without credentials. */
export const ALL_ON_CONFIG = {
  security: { owner: { identities: { telegram: [AUDIT_OWNER] } } },
  proactive: { enabled: true },
  accounts: { rotation: { enabled: true } },
  agent: { fallback: { enabled: true } },
  learning: { enabled: true },
  curator: { enabled: true },
  userModel: { enabled: true },
  goals: { enabled: true },
  loops: { enabled: true },
  webhooks: { enabled: true },
  undo: { enabled: true },
  plugins: { enabled: true },
  computerUse: { enabled: true },
  voice: { enabled: true },
};

/** The context plus a function that closes the stores it opened. */
export function buildAuditContext(dataDir: string): { ctx: DaemonContext; close: () => void } {
  const closers: Array<() => void> = [];
  const config = KirieConfigSchema.parse(ALL_ON_CONFIG);
  const owners = new OwnerDirectory(config.security.owner.identities);
  const channelRegistry = new ChannelRegistry();
  const audit = new AuditTrail(join(dataDir, "logs", "audit.jsonl"));
  const settings = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"), { audit });
  const router = new InteractionRouter({ channelRegistry, owners, audit });
  const ownerPrompts = new OwnerPrompts({ router, channelRegistry, owners, audit, maxPending: config.commands.maxPendingPrompts });
  const commands = new CommandRegistry({ owners, prompts: ownerPrompts, audit });
  const sessionStore = new SessionStore(join(dataDir, "sessions.db"));
  const backgroundTaskStore = new BackgroundTaskStore(join(dataDir, "background-tasks.db"));
  const scheduleStore = new ScheduleStore(join(dataDir, "schedules.db"));
  const chatHistoryStore = new ChatHistoryStore(join(dataDir, "chat-history.db"));
  const heartbeatLogStore = new HeartbeatLogStore(join(dataDir, "heartbeat-logs.db"), null);
  closers.push(() => sessionStore.close(), () => backgroundTaskStore.close(), () => scheduleStore.close(),
    () => chatHistoryStore.close(), () => heartbeatLogStore.close());
  const engine: AgentExecutor = { execute: vi.fn(async () => ({ response: "", sessionId: "s", costUsd: 0, numTurns: 0, isError: false })) } as unknown as AgentExecutor;
  const pipeline = new MessagePipeline({
    channelRegistry,
    securityGate: { check: () => ({ passed: false }) } as unknown as SecurityGate,
    sessionStore,
    agentEngine: engine,
    commands,
    owners,
    chatHistoryStore,
    backgroundTaskStore,
  });
  const resilience = { setResilience: vi.fn() };
  const proactiveState = { running: false };
  const ctx = {
    config,
    dataDir,
    agentCwd: dataDir,
    commands,
    owners,
    ownerPrompts,
    settings,
    audit,
    scrubber: new SecretScrubber(),
    sdkOptions: new SdkOptionsPipeline(),
    turnContext: new TurnContextRegistry(),
    promptAddenda: new PromptAddenda(),
    internalApi: new InternalApi(),
    ingress: new PublicIngress(config.ingress),
    taskHooks: new TaskHooks(),
    channelRegistry,
    identityResolver: { addOwnerIdentities: vi.fn() },
    credentialStore: { get: () => undefined, has: () => false, list: () => [] },
    sessionStore,
    pipeline,
    heartbeat: new EventEmitter(),
    proactive: {
      get isRunning() { return proactiveState.running; },
      start: () => { proactiveState.running = true; },
      stop: () => { proactiveState.running = false; },
      setTier2IntervalMinutes: vi.fn(),
      snooze: vi.fn(),
      status: () => ({ running: proactiveState.running, signalQueueSize: 0, lastTriageAt: 0, nextTriageAt: 0, digestQueueSize: 0,
        dedupCacheSize: 0, notifiedTypesCacheSize: 0, tier2IntervalMinutes: 15, snoozedUntil: 0, triageInProgress: false }),
    },
    heartbeatLogStore,
    backgroundTaskStore,
    backgroundTaskManager: { ...resilience, cancelAll: () => 0, sendMessage: vi.fn() },
    scheduleStore,
    chatHistoryStore,
    memoryManager: null,
    embeddingProvider: null,
    agentEngine: resilience,
    v2Sessions: {
      ...resilience,
      closeIdleSessions: vi.fn(() => 0),
      isBusy: () => false,
      getIdleQuery: () => undefined,
      closeAndWait: vi.fn(async () => undefined),
    },
    usageDashboard: {},
    mcpServers: {},
    kirieToolsEnv: {},
    notifyOwner: vi.fn(async () => {}),
    restart: vi.fn(),
  } as unknown as DaemonContext;
  const close = (): void => {
    for (const fn of closers.splice(0)) {
      try { fn(); } catch { /* already closed */ }
    }
  };
  return { ctx, close };
}
