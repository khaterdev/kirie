import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { checkSizeCap, kindFromMime } from "@kirie/media";
import type { TranscriptionProvider } from "@kirie/media";
import type { UnifiedMessage, ChannelName, UnifiedMedia, MediaType, ChatType } from "../channels/normalizer.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelAdapter, FailedMedia, ResolvedMedia } from "../channels/adapter.js";
import {
  describeMediaDownloadError,
  formatBytes,
  formatFailedMediaNote,
  toFailedMedia,
} from "../channels/media-failure.js";
import { splitMediaFromOutput } from "../engine/media-output-parser.js";
import { SecurityGate, type GateResult } from "../security/gate.js";
import { resolveRoute } from "./resolve-route.js";
import { makeSessionKey, parseSessionKey } from "./session-key.js";
import type { SessionStore } from "../engine/session-store.js";
import { LaneQueue } from "../engine/lane-queue.js";
import type { AgentExecutor, IncomingMessage, ExecutionResult, ChatHistoryMessage } from "../engine/agent-engine.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SenderIdentity } from "../engine/prompt-builder.js";
import type { ResolvedIdentity } from "../security/auth.js";
import type { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import type { BackgroundTaskStore, BackgroundTask } from "../engine/background-task-store.js";
import type { CommandRegistry } from "../commands/registry.js";
import { commandContinuesToAgent } from "../commands/registry.js";
import type { CommandReply, CommandSource } from "../commands/types.js";
import type { OwnerDirectory } from "../interaction/owners.js";
import type { TurnContextRegistry, TurnOrigin } from "../engine/turn-context.js";
import { createModuleLogger } from "../logging/logger.js";
import { scrubSecrets } from "../security/secret-scrubber.js";
import type { UsageTracker } from "../logging/usage-tracker.js";
import type { HeartbeatService } from "../engine/heartbeat.js";
import { isTransientNetworkError } from "../engine/network-errors.js";
import { agentErrorUserMessage } from "../engine/agent-errors.js";
import {
  attachFailure,
  classifyFailure,
  failureOf,
  isHardFailure,
  userFacingTaskError,
  type FailureInfo,
} from "../engine/failure.js";

const log = createModuleLogger("message-pipeline");

/** Origins of text the daemon injects into a chat (PLAN B.14). Never a command, never the owner. */
export type InjectOrigin = "schedule" | "loop" | "webhook" | "goal";

const SYNTHETIC_ID_RE = /^(schedule|loop|webhook|goal)-\d+$/;

/**
 * True for the ids `injectMessage` gives its synthetic messages
 * ("<origin>-<timestamp>"). They are not platform message ids, so a reply must
 * never point at them. This only shapes replies: whether text may be a command
 * is decided by the `source` parameter, never by the id.
 */
export function isSyntheticId(id: string): boolean {
  return SYNTHETIC_ID_RE.test(id);
}

export interface InjectMessageOptions {
  channel: string;
  chatId: string;
  /** Default "dm" */
  chatType?: ChatType;
  text: string;
  senderId: string;
  senderName?: string;
  /** Becomes the id prefix "<origin>-<ts>" and the TurnOrigin */
  origin: InjectOrigin;
  /** true: never interrupt a running or queued turn; return "busy" instead */
  skipIfBusy?: boolean;
  /** A reply that is, or ends with, one of these is neither sent nor stored */
  quietSentinels?: readonly string[];
  /** Stored in chat history instead of the raw prompt */
  historyLabel?: string;
  /**
   * Called with a successful, non-quiet reply before it is stored or sent.
   * "suppress" treats it like a quiet reply (neither sent nor stored; the
   * result has `silent` and `suppressed`). A throwing hook means "send".
   */
  beforeDeliver?: (response: string) => "send" | "suppress";
}

export interface InjectMessageResult {
  status: "ok" | "busy" | "channel-down" | "aborted" | "error";
  response?: string;
  /** The reply was neither sent nor stored (a quiet sentinel, or suppressed by beforeDeliver) */
  silent?: boolean;
  /** beforeDeliver suppressed the reply (it was not a quiet sentinel) */
  suppressed?: boolean;
  costUsd?: number;
}

/**
 * What the pipeline put into the model's prompt besides the sender's own
 * text, so learning can label trust by what the model actually saw
 * (LEARN-B4). Earlier turns of the session are judged from the turn log.
 */
export interface TurnInputs {
  chatType: ChatType;
  /** The message was forwarded from someone else: its text is not the sender's words */
  forwarded: boolean;
  /** Replied-to text or a reaction target's text was put in the prompt */
  replyContext: boolean;
  /** Results of background tasks were put in the prompt */
  taskResults: boolean;
  /** Attachments other than voice notes and stickers (their content is not the sender's words) */
  attachments: boolean;
}

export interface TurnCompleteEvent {
  sessionKey: string;
  origin: TurnOrigin;
  /** What besides the sender's own text was in the prompt */
  inputs: TurnInputs;
  channel: string;
  senderId: string;
  senderRole: string;
  /** Chat-history row ids when stored */
  userMsgId?: number;
  assistantMsgId?: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  result: ExecutionResult;
}

export interface TurnErrorEvent {
  sessionKey: string;
  name: string;
  message: string;
}

export type MessageTransform = (
  text: string,
  meta: { sessionKey: string; channel: string; senderId: string },
) => Promise<string>;

/** Per-call state of an injected message. */
interface InjectState {
  origin: InjectOrigin;
  skipIfBusy: boolean;
  quietSentinels?: readonly string[];
  historyLabel?: string;
  beforeDeliver?: (response: string) => "send" | "suppress";
}

const SENDER_NAMES: Record<InjectOrigin, string> = {
  schedule: "Schedule",
  loop: "Loop",
  webhook: "Webhook",
  goal: "Goal",
};

/** True when the trimmed reply is, or ends with, one of the sentinels. */
export function isQuietReply(response: string, sentinels: readonly string[] | undefined): boolean {
  if (!sentinels || sentinels.length === 0) return false;
  const trimmed = response.trim();
  if (!trimmed) return false;
  return sentinels.some((s) => {
    const sentinel = s.trim();
    return sentinel.length > 0 && trimmed.endsWith(sentinel);
  });
}

/**
 * Configuration for the MessagePipeline.
 */
export interface MessagePipelineConfig {
  /** The channel registry to discover adapters and route responses */
  channelRegistry: ChannelRegistry;
  /** The security gate for auth/authz/rate-limit/input-guard */
  securityGate: SecurityGate;
  /** The session store for mapping session keys to SDK session IDs */
  sessionStore: SessionStore;
  /** The agent engine for processing messages */
  agentEngine: AgentExecutor;
  /** LaneQueue debounce in ms (default 1500) */
  debounceMs?: number;
  /** Optional chat history store for persisting messages */
  chatHistoryStore?: ChatHistoryStore;
  /** Optional background task store for context injection */
  backgroundTaskStore?: BackgroundTaskStore;
  /** Slash-command registry (PLAN B.4). Dispatch runs after the security gate, before the agent */
  commands?: CommandRegistry;
  /** Per-turn origin registry (PLAN B.2). The pipeline is its only writer */
  turnContext?: TurnContextRegistry;
  /** Owner identities, for the turn origin */
  owners?: OwnerDirectory;
  /** Optional usage tracker for recording execution costs */
  usageTracker?: UsageTracker;
  /** Model name for usage tracking */
  model?: string;
  /** Optional transcription provider for auto-transcribing audio/voice media */
  transcriptionProvider?: TranscriptionProvider;
  /** Optional heartbeat service for retrying failed message deliveries */
  heartbeat?: HeartbeatService;
}

/**
 * MessagePipeline wires the end-to-end message flow:
 *
 *   Channel -> SecurityGate -> Router -> LaneQueue -> AgentEngine -> Response
 *
 * Usage:
 *   1. Create the pipeline with all dependencies
 *   2. Call pipeline.start() to register message listeners on all channels
 *   3. Messages flow automatically through the pipeline
 *   4. Call pipeline.stop() to tear down
 */
export class MessagePipeline {
  private readonly config: MessagePipelineConfig;
  private readonly laneQueue: LaneQueue<ExecutionResult>;
  private started = false;
  /** Active Query handles for running agent executions, keyed by session key */
  private readonly runningQueries = new Map<string, Query>();
  /**
   * In-flight message handlers. Tracked so stop() can wait for running
   * agent tasks to finish their post-execution writes (session ID, chat
   * history) before the daemon closes the underlying SQLite stores.
   */
  private readonly inflight = new Set<Promise<void>>();
  /** Max time stop() waits for in-flight handlers to drain before closing stores */
  private static readonly DRAIN_TIMEOUT_MS = 5000;
  /**
   * Track bot-sent message IDs so we can identify reactions to bot messages.
   * Maps chatId -> messageId -> truncated message text.
   * Entries are pruned when the map exceeds MAX_TRACKED_MESSAGES per chat.
   */
  private readonly sentMessages = new Map<string, Map<string, string>>();
  private static readonly MAX_TRACKED_PER_CHAT = 200;
  /** Handlers past the security gate that have not reached the lane yet, per session key */
  private readonly preparing = new Map<string, number>();
  /** One-shot notes prefixed to the next executed message, per session key */
  private readonly nextTurnNotes = new Map<string, string[]>();
  private readonly turnCompleteListeners = new Set<(ev: TurnCompleteEvent) => void>();
  private readonly turnErrorListeners = new Set<(ev: TurnErrorEvent) => void>();
  private messageTransform: MessageTransform | null = null;
  /** Active session holds (holdSession), per session key */
  private readonly holds = new Map<string, Set<symbol>>();
  /** Messages waiting for a hold to be released, per session key */
  private readonly holdWaiters = new Map<string, Array<() => void>>();
  /** A hold that is never released expires after this long, so a crashed holder cannot block a chat */
  static readonly DEFAULT_HOLD_TIMEOUT_MS = 120_000;

  constructor(config: MessagePipelineConfig) {
    this.config = config;
    this.laneQueue = new LaneQueue<ExecutionResult>(config.debounceMs);
  }

  /**
   * Set the heartbeat service for retry support.
   * Called after HeartbeatService is created (it depends on the pipeline, so
   * the pipeline is created first and the heartbeat is wired in afterwards).
   */
  setHeartbeat(heartbeat: HeartbeatService): void {
    this.config.heartbeat = heartbeat;
  }

  // ── Extension points (PLAN B.14) ──────────────────────────────────────────

  /**
   * A running query or queued lane work (or a message being prepared, or a
   * session hold) for this session. `ignoreHolds` answers for turns only: the
   * holder itself uses it to check that no turn is running.
   */
  isBusy(sessionKey: string, opts?: { ignoreHolds?: boolean }): boolean {
    if (!opts?.ignoreHolds && this.isHeld(sessionKey)) return true;
    return (
      this.runningQueries.has(sessionKey) ||
      this.laneQueue.isBusy(sessionKey) ||
      (this.preparing.get(sessionKey) ?? 0) > 0
    );
  }

  /**
   * Hold a session: while held it counts as busy, injected messages with
   * skipIfBusy return "busy", and any other new message for it waits before
   * it is prepared or queued, then runs in order once the last hold is
   * released. Commands still run. The returned release is idempotent; a hold
   * that is not released expires after `timeoutMs` (default 120 s).
   */
  holdSession(sessionKey: string, opts?: { timeoutMs?: number }): () => void {
    const token = Symbol("hold");
    let set = this.holds.get(sessionKey);
    if (!set) {
      set = new Set();
      this.holds.set(sessionKey, set);
    }
    set.add(token);
    let released = false;
    const timeoutMs = opts?.timeoutMs ?? MessagePipeline.DEFAULT_HOLD_TIMEOUT_MS;
    const release = (): void => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      const current = this.holds.get(sessionKey);
      if (!current) return;
      current.delete(token);
      if (current.size > 0) return;
      this.holds.delete(sessionKey);
      this.wakeHoldWaiters(sessionKey);
    };
    const timer = setTimeout(() => {
      if (released) return;
      log.warn({ sessionKey, timeoutMs }, "session hold expired without release");
      release();
    }, timeoutMs);
    timer.unref?.();
    return release;
  }

  private isHeld(sessionKey: string): boolean {
    return (this.holds.get(sessionKey)?.size ?? 0) > 0;
  }

  private wakeHoldWaiters(sessionKey: string): void {
    const waiters = this.holdWaiters.get(sessionKey);
    if (!waiters) return;
    this.holdWaiters.delete(sessionKey);
    for (const wake of waiters) wake();
  }

  /** Resolves at once when the session is not held, else when the last hold is released or the pipeline stops. */
  private waitForHold(sessionKey: string): Promise<void> {
    if (!this.isHeld(sessionKey)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.holdWaiters.get(sessionKey) ?? [];
      list.push(resolve);
      this.holdWaiters.set(sessionKey, list);
    });
  }

  /** A one-shot `<system_note>` prefixed to the next executed message of this session. */
  addNextTurnNote(sessionKey: string, note: string): void {
    const text = note.trim();
    if (!text) return;
    const list = this.nextTurnNotes.get(sessionKey) ?? [];
    list.push(text);
    this.nextTurnNotes.set(sessionKey, list);
  }

  /** Called after every executed turn. Listeners run in try/catch and cannot break the reply. */
  onTurnComplete(listener: (ev: TurnCompleteEvent) => void): () => void {
    this.turnCompleteListeners.add(listener);
    return () => { this.turnCompleteListeners.delete(listener); };
  }

  /** Called when a turn fails with an error. Listeners run in try/catch. */
  onTurnError(listener: (ev: TurnErrorEvent) => void): () => void {
    this.turnErrorListeners.add(listener);
    return () => { this.turnErrorListeners.delete(listener); };
  }

  /** Rewrites the message text before execution. A throwing transform leaves the text unchanged. */
  setMessageTransform(fn: MessageTransform | null): void {
    this.messageTransform = fn;
  }

  /**
   * Inject text into a chat as a synthetic turn (schedules, loops, goals,
   * webhooks). It is never dispatched as a command and its turn origin is the
   * given origin, never "owner_message", whatever the sender id.
   */
  async injectMessage(opts: InjectMessageOptions): Promise<InjectMessageResult> {
    if (!this.started) return { status: "error" };
    const adapter = this.config.channelRegistry.getById(opts.channel);
    if (!adapter || !this.config.channelRegistry.isRunning(opts.channel)) {
      log.warn({ channel: opts.channel, origin: opts.origin }, "channel not available for injected message");
      return { status: "channel-down" };
    }
    const chatType = opts.chatType ?? "dm";
    const sessionKey = makeSessionKey({ channel: opts.channel, chatType, chatId: opts.chatId });
    if (opts.skipIfBusy && this.isBusy(sessionKey)) {
      log.info({ sessionKey, origin: opts.origin }, "chat busy, injected message not started");
      return { status: "busy" };
    }

    const syntheticMessage: UnifiedMessage = {
      id: `${opts.origin}-${Date.now()}`,
      channel: opts.channel as ChannelName,
      senderId: opts.senderId,
      senderName: opts.senderName || SENDER_NAMES[opts.origin],
      text: opts.text,
      chatType,
      chatId: opts.chatId,
      timestamp: Date.now(),
      raw: null,
    };

    const p = this.handleMessage(syntheticMessage, adapter, "synthetic", {
      origin: opts.origin,
      skipIfBusy: opts.skipIfBusy === true,
      quietSentinels: opts.quietSentinels,
      historyLabel: opts.historyLabel,
      ...(opts.beforeDeliver ? { beforeDeliver: opts.beforeDeliver } : {}),
    });
    const tracked = p.then(() => undefined, () => undefined);
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
    try {
      return await p;
    } catch (err) {
      log.error({ err, sessionKey, origin: opts.origin }, "injected message failed");
      return { status: "error" };
    }
  }

  /**
   * Track a bot-sent message for later reaction context lookup.
   */
  private trackSentMessage(chatId: string, messageId: string, text: string): void {
    let chatMap = this.sentMessages.get(chatId);
    if (!chatMap) {
      chatMap = new Map();
      this.sentMessages.set(chatId, chatMap);
    }
    chatMap.set(messageId, text.slice(0, 300));

    // Prune oldest entries if we exceed the limit
    if (chatMap.size > MessagePipeline.MAX_TRACKED_PER_CHAT) {
      const iter = chatMap.keys();
      chatMap.delete(iter.next().value!);
    }
  }

  /**
   * Look up a tracked bot-sent message by chat and message ID.
   * Returns the message text if found, undefined otherwise.
   */
  private lookupSentMessage(chatId: string, messageId: string): string | undefined {
    return this.sentMessages.get(chatId)?.get(messageId);
  }

  /**
   * Abort the running agent for a specific session.
   * Returns true if an agent was actually aborted.
   */
  abortSession(sessionKey: string): boolean {
    const q = this.runningQueries.get(sessionKey);
    if (q) {
      q.close();
      this.runningQueries.delete(sessionKey);
      this.laneQueue.clear(sessionKey);
      return true;
    }
    // Still clear any pending queue items
    this.laneQueue.clear(sessionKey);
    return false;
  }

  /**
   * Abort ALL running agent sessions and clear all pending queues.
   */
  abortAll(): number {
    let count = 0;
    for (const [, q] of this.runningQueries) {
      q.close();
      count++;
    }
    this.runningQueries.clear();
    this.laneQueue.clearAll();
    return count;
  }

  /**
   * Clear a session's SDK context (fresh conversation next message).
   */
  clearSession(sessionKey: string): void {
    this.abortSession(sessionKey);
    this.config.sessionStore.delete(sessionKey);
  }

  /**
   * Register message listeners on all currently registered channel adapters.
   * New adapters registered after start() must be wired manually or
   * the pipeline re-started.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const adapters = this.config.channelRegistry.getAll();
    for (const [id, adapter] of adapters) {
      log.info({ channel: id }, "wiring message listener");
      adapter.onMessage((message) => this.runHandler(message, adapter));
    }

    // Wire up newly registered adapters
    this.config.channelRegistry.on("registered", (id: ChannelName) => {
      const adapter = this.config.channelRegistry.getById(id);
      if (adapter) {
        log.info({ channel: id }, "wiring message listener for new adapter");
        adapter.onMessage((message) => this.runHandler(message, adapter));
      }
    });
  }

  /**
   * Run a message handler and track its promise so stop() can wait for it.
   * handleMessage handles its own errors internally; the catch here is a
   * last-resort guard so an unexpected throw never goes unhandled.
   */
  private runHandler(message: UnifiedMessage, adapter: ChannelAdapter): void {
    const p = this.handleMessage(message, adapter, "channel").then(() => undefined, (err) => {
      log.error({ err, messageId: message.id }, "unhandled error in message handler");
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /**
   * Stop the pipeline. Rejects pending queue items, aborts running agents,
   * then waits (bounded) for in-flight handlers to finish their post-execution
   * writes so the daemon doesn't close the SQLite stores out from under a
   * task that's still persisting its session ID or chat history.
   */
  async stop(): Promise<void> {
    this.started = false;
    // Wake messages waiting on a session hold; they see the pipeline stopped and end.
    for (const key of [...this.holdWaiters.keys()]) this.wakeHoldWaiters(key);
    // Abort running agents and reject all pending queue items.
    this.abortAll();
    // Wait for in-flight handlers to settle before stores are closed.
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise<void>((resolve) =>
          setTimeout(resolve, MessagePipeline.DRAIN_TIMEOUT_MS),
        ),
      ]);
    }
  }

  /**
   * Handle an incoming message through the full pipeline.
   * This is the core message flow.
   *
   * `source` is "channel" only for the adapter listener path (runHandler);
   * injected messages pass "synthetic" and their `inject` state. Synthetic
   * text is never a command and never gets the owner turn origin.
   */
  private async handleMessage(
    message: UnifiedMessage,
    sourceAdapter: ChannelAdapter,
    source: CommandSource,
    inject?: InjectState,
  ): Promise<InjectMessageResult> {
    // Drop messages that arrive during shutdown/restart. Without this, a
    // message accepted after stop() but before channels are torn down would
    // start a new agent task and write to stores the daemon is about to close.
    if (!this.started) return { status: "error" };

    const messageId = message.id;
    const channel = message.channel;

    log.info(
      { messageId, channel, senderId: message.senderId, chatType: message.chatType, source },
      "message received",
    );

    // Step 0: Security gate (must run before anything else, including commands)
    const gateResult: GateResult = this.config.securityGate.check(message);

    if (!gateResult.passed) {
      return { status: "error" };
    }

    // Step 1: Slash commands. Only real channel messages can be commands; the
    // registry checks the owner centrally and sends its own (plain) reply.
    if (this.config.commands) {
      try {
        const outcome = await this.config.commands.dispatch({
          message,
          identity: gateResult.identity,
          source,
          send: (reply) => this.sendCommandReply(sourceAdapter, message, reply),
        });
        if (!commandContinuesToAgent(outcome)) {
          log.info({ messageId, channel, outcome: outcome.kind }, "handled as a command");
          return { status: "ok" };
        }
      } catch (cmdErr) {
        // Fail closed for anything that looks like a command; ordinary text continues.
        if (source === "channel" && this.config.commands.parse(message.text)) {
          log.error({ cmdErr, messageId }, "command dispatch failed (not forwarded to the agent)");
          return { status: "error" };
        }
        log.warn({ cmdErr, messageId }, "command dispatch error (continuing to the agent)");
      }
    }

    const earlyKey = sessionKeyOf(message);
    // A held session (holdSession) makes new turns wait until it is released.
    // The wait is before "preparing", so the holder's own turn-only busy check
    // (isBusy with ignoreHolds) does not see the waiting message.
    if (this.isHeld(earlyKey)) {
      log.info({ messageId, sessionKey: earlyKey }, "session held, message waits for release");
      await this.waitForHold(earlyKey);
      if (!this.started) return { status: "error" };
    }
    this.preparing.set(earlyKey, (this.preparing.get(earlyKey) ?? 0) + 1);
    let preparingReleased = false;
    const releasePreparing = () => {
      if (preparingReleased) return;
      preparingReleased = true;
      const n = (this.preparing.get(earlyKey) ?? 1) - 1;
      if (n <= 0) this.preparing.delete(earlyKey);
      else this.preparing.set(earlyKey, n);
    };

    try {
      return await this.runTurn(message, sourceAdapter, source, gateResult, inject, releasePreparing);
    } finally {
      releasePreparing();
    }
  }

  /** Steps 2 to 8 of handleMessage: media, route, lane, execute, persist, send. */
  private async runTurn(
    message: UnifiedMessage,
    sourceAdapter: ChannelAdapter,
    source: CommandSource,
    gateResult: Extract<GateResult, { passed: true }>,
    inject: InjectState | undefined,
    releasePreparing: () => void,
  ): Promise<InjectMessageResult> {
    const messageId = message.id;
    const channel = message.channel;

    // Step 2: Download and save media attachments to disk
    let resolvedMedia: ResolvedMedia[] | undefined;
    let failedMedia: FailedMedia[] | undefined;
    if (message.media && message.media.length > 0 && sourceAdapter.downloadMedia) {
      const downloads = await downloadAndSaveMedia(
        message.media,
        sourceAdapter,
        this.config.transcriptionProvider,
      );
      resolvedMedia = downloads.resolved;
      if (downloads.failed.length > 0) failedMedia = downloads.failed;
    }

    // Step 3: Route resolution
    // Enrich reaction messages with context about the reacted-to message
    let reactionContext: { isTargetFromBot?: boolean; targetContent?: string } | undefined;
    if (message.reaction) {
      const targetContent = this.lookupSentMessage(message.chatId, message.reaction.messageId);
      reactionContext = {
        isTargetFromBot: targetContent !== undefined,
        targetContent,
      };
    }

    const route = resolveRoute(
      unifiedToIncoming(message, resolvedMedia, reactionContext, failedMedia),
      this.config.sessionStore,
    );

    log.debug(
      { messageId, sessionKey: route.sessionKey, hasSession: !!route.sdkSessionId },
      "route resolved",
    );

    // Step 4: Interrupt running agent if one is active for this session.
    // An injected message with skipIfBusy never interrupts (DECISIONS 16).
    releasePreparing();
    if (inject?.skipIfBusy && this.isBusy(route.sessionKey)) {
      log.info({ sessionKey: route.sessionKey, origin: inject.origin }, "chat became busy, injected message not started");
      return { status: "busy" };
    }
    if (this.runningQueries.has(route.sessionKey)) {
      log.info({ sessionKey: route.sessionKey }, "new message arrived while agent busy — interrupting");
      this.abortSession(route.sessionKey);
    }

    const origin: TurnOrigin = inject
      ? inject.origin
      : source === "channel" && this.config.owners?.isOwner(message.channel, message.senderId)
        ? "owner_message"
        : "other_user";
    const sender: SenderIdentity = { ...identityToSender(gateResult.identity, message.senderName), origin };
    let userMsgId: number | undefined;
    let assistantMsgId: number | undefined;
    const inputs: TurnInputs = {
      chatType: message.chatType,
      forwarded: message.isForwarded === true,
      replyContext: !!reactionContext?.targetContent,
      taskResults: false,
      attachments: (resolvedMedia ?? []).some((m) => m.type !== "voice" && m.type !== "sticker"),
    };
    let silent = false;
    let suppressed = false;
    let startedAt = Date.now();

    // Step 5: Enqueue in LaneQueue for per-session serialization
    try {
      // Start typing indicator loop while agent is working
      const typingCtx = {
        chatId: message.chatId,
        threadId: message.threadId,
      };
      const typingInterval = this.startTypingLoop(sourceAdapter, typingCtx);

      const result = await this.laneQueue.enqueue(route.sessionKey, async () => {
        // Step 6: Execute through AgentEngine
        log.debug(
          { messageId, sessionKey: route.sessionKey, role: sender.role },
          "executing agent query",
        );

        // Load recent chat history so the agent has conversation context
        let chatHistory: ChatHistoryMessage[] | undefined;
        if (this.config.chatHistoryStore) {
          try {
            const entries = this.config.chatHistoryStore.recent(route.sessionKey, 20);
            if (entries.length > 0) {
              chatHistory = entries.map((e) => ({
                role: e.role,
                content: e.content,
                senderName: e.sender_name ?? undefined,
                timestamp: e.created_at,
              }));
            }
          } catch (historyErr) {
            log.warn({ historyErr }, "failed to load chat history for context (non-fatal)");
          }
        }

        // Save user message to chat history BEFORE agent execution,
        // so it's preserved even if the agent is interrupted by a new message.
        if (this.config.chatHistoryStore) {
          try {
            let historyText = inject?.historyLabel ?? message.text;
            if (message.isEdited) {
              historyText = `[edited] ${historyText}`;
            }
            if (failedMedia) {
              const notes = failedMedia.map(formatFailedMediaNote).join("\n");
              historyText = historyText ? `${historyText}\n${notes}` : notes;
            }
            if (message.reaction) {
              const verb = message.reaction.action === "add" ? "reacted with" : "removed";
              const target = reactionContext?.isTargetFromBot ? " on bot's message" : "";
              historyText = `[${verb} ${message.reaction.emoji}${target} (msg ${message.reaction.messageId})]`;
              if (reactionContext?.targetContent) {
                historyText += ` "${reactionContext.targetContent.slice(0, 100)}"`;
              }
            }
            const rowId = this.config.chatHistoryStore.append(route.sessionKey, "user", historyText, {
              senderName: message.senderName,
              senderId: message.senderId,
              channel: message.channel,
              ...(message.isForwarded ? { forwarded: true } : {}),
            });
            if (typeof rowId === "number") userMsgId = rowId;
          } catch (historyErr) {
            log.warn({ historyErr }, "failed to store user message in chat history (non-fatal)");
          }
        }

        // Inject completed background task results as context
        const taskContext = this.buildBackgroundTaskContext(route.sessionKey);
        if (taskContext) inputs.taskResults = true;

        // Prepend rich reply context so the agent sees what message is being replied to
        const replyPrefix = formatReplyContext(route.message.replyTo);
        if (replyPrefix) inputs.replyContext = true;

        // One-shot notes registered by features for this session's next turn
        const notes = this.takeNextTurnNotes(route.sessionKey);

        let bodyText = route.message.text;
        if (this.messageTransform) {
          try {
            bodyText = await this.messageTransform(bodyText, {
              sessionKey: route.sessionKey,
              channel: message.channel,
              senderId: message.senderId,
            });
          } catch (transformErr) {
            log.warn({ transformErr, sessionKey: route.sessionKey }, "message transform failed (text unchanged)");
          }
        }

        const contextPrefix = [notes, taskContext, replyPrefix].filter(Boolean).join("\n\n");
        const messageWithContext = contextPrefix || bodyText !== route.message.text
          ? { ...route.message, text: contextPrefix + bodyText }
          : route.message;

        // Execute through the agent engine. Register the Query handle so
        // /stop, /stopall, and message interruption can call query.close()
        // to immediately terminate the SDK subprocess.
        startedAt = Date.now();
        this.config.turnContext?.begin(route.sessionKey, {
          origin,
          senderId: message.senderId,
          senderRole: sender.role,
          startedAt,
          ...(origin === "owner_message" && message.text
            ? { textPreview: scrubSecrets(message.text.slice(0, 80), { sink: "log" }) }
            : {}),
        });
        let executionResult: ExecutionResult;
        try {
          executionResult = await this.config.agentEngine.execute(
            messageWithContext,
            sender,
            route.sdkSessionId ?? undefined,
            (q) => { this.runningQueries.set(route.sessionKey, q); },
            chatHistory,
          );
        } catch (execErr) {
          this.runningQueries.delete(route.sessionKey);
          const failure = failureOf(execErr) ?? classifyFailure({ error: execErr });
          if (failure) attachFailure(execErr, failure);
          // If execution throws entirely (e.g. stale/expired session that can't
          // be resumed and fresh session also fails), clear the bad session ID
          // from the store so the next message doesn't hit the same failure loop.
          // A limit, auth, model or overload failure is not a stale session:
          // the mapping is kept so the conversation resumes once it clears.
          if (route.sdkSessionId && isHardFailure(failure)) {
            log.warn(
              { sessionKey: route.sessionKey, failureClass: failure.class },
              "keeping session mapping after a limit/account failure",
            );
          } else if (route.sdkSessionId) {
            log.warn(
              { sessionKey: route.sessionKey, sdkSessionId: route.sdkSessionId },
              "clearing stale session after execution failure",
            );
            this.config.sessionStore.delete(route.sessionKey);
          }
          throw execErr;
        } finally {
          // Only clear our own turn: after /stopall a newer turn may already have begun.
          if (this.config.turnContext?.get(route.sessionKey)?.startedAt === startedAt) {
            this.config.turnContext.end(route.sessionKey);
          }
        }
        this.runningQueries.delete(route.sessionKey);

        // A returned error result the engine could classify (usage limit,
        // auth, overload, ...) is answered with the fixed user message, never
        // the raw provider text.
        const classified = classifiedFailure(executionResult);
        if (classified) {
          log.warn(
            { messageId, sessionKey: route.sessionKey, failureClass: classified.class },
            "agent returned a classified error result",
          );
          executionResult = { ...executionResult, response: agentErrorUserMessage(classified) };
        }

        // Step 7: Persist the new/updated session ID
        if (executionResult.sessionId) {
          this.config.sessionStore.set(route.sessionKey, executionResult.sessionId);
        }

        log.info(
          {
            messageId,
            sessionKey: route.sessionKey,
            costUsd: executionResult.costUsd,
            numTurns: executionResult.numTurns,
            isError: executionResult.isError,
            ...(executionResult.model ? { model: executionResult.model } : {}),
          },
          "agent execution complete",
        );

        // Record usage for dashboard/analytics
        if (this.config.usageTracker) {
          try {
            this.config.usageTracker.record({
              model: executionResult.model ?? this.config.model ?? "unknown",
              inputTokens: 0,
              outputTokens: 0,
              cacheTokens: 0,
              costUsd: executionResult.costUsd,
              sessionKey: route.sessionKey,
              timestamp: new Date().toISOString(),
            });
          } catch (usageErr) {
            log.warn({ usageErr }, "failed to record usage (non-fatal)");
          }
        }

        // A quiet reply to an injected message (loops) is neither stored nor sent.
        silent = !executionResult.isError && isQuietReply(executionResult.response, inject?.quietSentinels);
        // The injector may hold back a reply that is not quiet (for example one unchanged since last run).
        if (!silent && inject?.beforeDeliver && !executionResult.isError && !executionResult.wasAborted && executionResult.response) {
          try {
            suppressed = inject.beforeDeliver(executionResult.response) === "suppress";
          } catch (hookErr) {
            log.warn({ hookErr, sessionKey: route.sessionKey }, "beforeDeliver hook failed (reply is sent)");
          }
          if (suppressed) silent = true;
        }

        // Store assistant response in chat history (user message was saved before execution).
        // If the execution was aborted (interrupted by a new message), save the partial
        // response with an [interrupted] prefix so the agent knows it was cut short.
        if (this.config.chatHistoryStore && executionResult.response && !silent) {
          try {
            const responseText = executionResult.wasAborted
              ? `[interrupted — new message arrived] ${executionResult.response}`
              : executionResult.response;
            const rowId = this.config.chatHistoryStore.append(route.sessionKey, "assistant", responseText, {
              channel: message.channel,
            });
            if (typeof rowId === "number") assistantMsgId = rowId;
          } catch (historyErr) {
            log.warn({ historyErr }, "failed to store assistant response in chat history (non-fatal)");
          }
        }

        return executionResult;
      }).finally(() => {
        clearInterval(typingInterval);
      });

      // Step 8: Send response back through the originating channel.
      // Skip sending if the execution was aborted (user sent a new message —
      // they'll get a fresh response from the new execution).
      if (result.response && !result.wasAborted && !silent) {
        // For reaction events, reply to the message that was reacted to
        // (not the synthetic reaction event ID which isn't a valid platform message).
        // For injected messages, don't set replyToId at all — the synthetic
        // ID (e.g. "schedule-1738000000000") isn't a real platform message ID
        // and would cause the send to fail.
        const replyToId = isSyntheticId(message.id)
          ? undefined
          : message.reaction
            ? message.reaction.messageId
            : message.id;

        const ctx = {
          chatId: message.chatId,
          threadId: message.threadId,
          ...(replyToId ? { replyToId } : {}),
        };

        // Parse media tokens from agent output
        const parsed = splitMediaFromOutput(result.response);

        // Send extracted media if adapter supports it
        if (parsed.mediaUrls && parsed.mediaUrls.length > 0 && sourceAdapter.sendMedia) {
          for (const url of parsed.mediaUrls) {
            try {
              const mediaType: MediaType = parsed.audioAsVoice && isAudioUrl(url) ? "voice" : guessMediaType(url);
              await sourceAdapter.sendMedia({
                ctx,
                media: { type: mediaType, url },
              });
            } catch (mediaErr) {
              // On transient network errors, queue a text fallback for retry via heartbeat
              const mediaFallbackText = `[media: ${url}]`;
              if (!this.queueForRetry(channel, message.chatId, mediaFallbackText, mediaErr, message.threadId)) {
                log.warn({ mediaErr, url }, "failed to send media from agent output (non-fatal)");
              }
            }
          }
        }

        // Send cleaned text (if any remains after media extraction)
        if (parsed.text && parsed.text.trim()) {
          try {
            const sentReceipts = await sourceAdapter.sendText({ ctx, text: parsed.text });
            // Track sent message IDs so reactions to bot messages can be identified
            for (const receipt of sentReceipts) {
              this.trackSentMessage(message.chatId, receipt.id, parsed.text);
            }
          } catch (sendErr) {
            // On transient network errors, queue for retry instead of losing the response
            if (!this.queueForRetry(channel, message.chatId, parsed.text, sendErr, message.threadId)) {
              throw sendErr; // Non-transient error — let the outer catch handle it
            }
          }
        }

        log.debug({ messageId, channel, mediaCount: parsed.mediaUrls?.length ?? 0 }, "response sent to channel");
      }

      if (result.isError) {
        log.warn(
          { messageId, failureClass: result.failure?.class, responseLength: result.response.length },
          "agent returned error result",
        );
      }

      const endedAt = Date.now();
      this.emitTurnComplete({
        sessionKey: route.sessionKey,
        origin,
        inputs: { ...inputs },
        channel: message.channel,
        senderId: message.senderId,
        senderRole: sender.role,
        ...(userMsgId !== undefined ? { userMsgId } : {}),
        ...(assistantMsgId !== undefined ? { assistantMsgId } : {}),
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        result,
      });

      if (result.wasAborted) return { status: "aborted", costUsd: result.costUsd };
      return {
        status: result.isError ? "error" : "ok",
        response: result.response,
        ...(silent ? { silent: true } : {}),
        ...(suppressed ? { suppressed: true } : {}),
        costUsd: result.costUsd,
      };
    } catch (err) {
      // Provide a more informative error message based on the failure type
      const failure = failureOf(err) ?? classifyFailure({ error: err });
      const userMessage = agentErrorUserMessage(failure ?? { kind: "unknown" });

      log.error({ messageId, err, errorKind: failure?.class ?? "unknown" }, "pipeline error");
      this.emitTurnError({
        sessionKey: route.sessionKey,
        name: err instanceof Error ? err.name : "Error",
        message: scrubSecrets(err instanceof Error ? err.message : String(err), { sink: "log" }).slice(0, 500),
      });

      await this.sendErrorResponse(
        sourceAdapter,
        message,
        userMessage,
      );
      return { status: "error" };
    }
  }

  private takeNextTurnNotes(sessionKey: string): string | null {
    const notes = this.nextTurnNotes.get(sessionKey);
    if (!notes || notes.length === 0) return null;
    this.nextTurnNotes.delete(sessionKey);
    return notes.map((n) => `<system_note>${n}</system_note>`).join("\n");
  }

  private emitTurnComplete(ev: TurnCompleteEvent): void {
    for (const listener of this.turnCompleteListeners) {
      try {
        listener(ev);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "turn-complete listener failed (ignored)");
      }
    }
  }

  private emitTurnError(ev: TurnErrorEvent): void {
    for (const listener of this.turnErrorListeners) {
      try {
        listener(ev);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "turn-error listener failed (ignored)");
      }
    }
  }

  /** Send one command reply to the message's chat. Always plain; buttons only when the adapter has them. */
  private async sendCommandReply(adapter: ChannelAdapter, message: UnifiedMessage, reply: CommandReply): Promise<void> {
    const replyToId = isSyntheticId(message.id) ? undefined : message.id;
    const ctx = { chatId: message.chatId, threadId: message.threadId, ...(replyToId ? { replyToId } : {}) };
    try {
      const receipts = reply.buttons && reply.buttons.length > 0 && adapter.sendInteractive
        ? [await adapter.sendInteractive({ ctx, text: reply.text, buttons: reply.buttons, plain: true })]
        : await adapter.sendText({ ctx, text: reply.text, plain: true });
      for (const r of receipts) this.trackSentMessage(message.chatId, r.id, reply.text);
    } catch (sendErr) {
      // On transient network errors, queue for retry instead of losing the reply
      if (!this.queueForRetry(message.channel, message.chatId, reply.text, sendErr, message.threadId)) {
        throw sendErr;
      }
    }
  }

  /**
   * Build context string for recently completed background tasks.
   * This is prepended to the user message so the agent is aware of
   * background work that finished since the last message.
   */
  private buildBackgroundTaskContext(sessionKey: string): string | null {
    if (!this.config.backgroundTaskStore) return null;

    try {
      const completed = this.config.backgroundTaskStore.list(sessionKey, "completed");
      if (completed.length === 0) return null;

      // Only include tasks completed in the last hour
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const recent = completed.filter((t) => t.updated_at > oneHourAgo);
      if (recent.length === 0) return null;

      const parts = ["<background_task_results>"];
      for (const task of recent.slice(0, 5)) { // Max 5 results
        parts.push(`  <task id="${task.id}" description="${task.description}" status="${task.status}">`);
        if (task.result) {
          // Truncate very long results
          const result = task.result.length > 2000
            ? task.result.slice(0, 2000) + "\n... (truncated, use background_task_result to see full)"
            : task.result;
          parts.push(`    ${result}`);
        }
        parts.push(`  </task>`);
      }
      parts.push("</background_task_results>");

      return parts.join("\n");
    } catch (err) {
      log.warn({ err }, "failed to build background task context (non-fatal)");
      return null;
    }
  }

  /**
   * Push a background task result proactively to the originating channel.
   * Called by the BackgroundTaskManager's onTaskComplete callback.
   */
  async pushBackgroundTaskResult(task: BackgroundTask): Promise<void> {
    const parts = parseSessionKey(task.session_key);
    if (!parts) {
      log.warn({ sessionKey: task.session_key }, "cannot parse session key for task result push");
      return;
    }

    const adapter = this.config.channelRegistry.getById(parts.channel);
    if (!adapter || !this.config.channelRegistry.isRunning(parts.channel)) {
      log.warn({ channel: parts.channel }, "channel not available for task result push");
      return;
    }

    const resultText = task.result || "Task completed (no result text)";
    const text = `Background task completed: ${task.description}\n\n${resultText}`;

    try {
      await adapter.sendText({
        ctx: { chatId: parts.chatId },
        text,
      });

      log.info({ taskId: task.id, channel: parts.channel, chatId: parts.chatId }, "pushed background task result");
    } catch (err) {
      // On transient network errors, queue for retry instead of losing the result
      if (!this.queueForRetry(parts.channel, parts.chatId, text, err)) {
        log.error({ taskId: task.id, err }, "failed to push background task result");
      }
    }
  }

  /**
   * Tell the originating chat that a background task failed.
   * Called by the BackgroundTaskManager's onTaskFailed callback. Only a
   * classified, user-safe sentence is shown; raw error text stays in the task row.
   */
  async pushBackgroundTaskFailure(task: BackgroundTask): Promise<void> {
    const parts = parseSessionKey(task.session_key);
    if (!parts) {
      log.warn({ sessionKey: task.session_key }, "cannot parse session key for task failure push");
      return;
    }

    const adapter = this.config.channelRegistry.getById(parts.channel);
    if (!adapter || !this.config.channelRegistry.isRunning(parts.channel)) {
      log.warn({ channel: parts.channel }, "channel not available for task failure push");
      return;
    }

    const detail =
      userFacingTaskError(task.error) ??
      "It stopped with an internal error. Ask me about this task to see the details.";
    const text = `Background task failed: ${task.description}\n\n${detail}`;

    try {
      await adapter.sendText({ ctx: { chatId: parts.chatId }, text });
      log.info({ taskId: task.id, channel: parts.channel }, "pushed background task failure");
    } catch (err) {
      if (!this.queueForRetry(parts.channel, parts.chatId, text, err)) {
        log.error({ taskId: task.id, err }, "failed to push background task failure");
      }
    }
  }

  /**
   * Deliver a result that a persistent session produced with no turn waiting
   * for it (for example an async subagent's final answer, after the turn
   * already returned "waiting for the agent"). Sent to the chat and stored in
   * chat history. Error results are logged, not sent.
   */
  async deliverUnsolicitedResult(sessionKey: string, result: ExecutionResult): Promise<void> {
    if (!this.started) return;
    if (result.isError) {
      log.warn(
        { sessionKey, failureClass: result.failure?.class },
        "unsolicited error result not delivered",
      );
      return;
    }
    if (!result.response.trim()) return;

    const parts = parseSessionKey(sessionKey);
    if (!parts) {
      log.warn({ sessionKey }, "cannot parse session key for unsolicited result");
      return;
    }
    const adapter = this.config.channelRegistry.getById(parts.channel);
    if (!adapter || !this.config.channelRegistry.isRunning(parts.channel)) {
      log.warn({ channel: parts.channel }, "channel not available for unsolicited result");
      return;
    }

    if (this.config.chatHistoryStore) {
      try {
        this.config.chatHistoryStore.append(sessionKey, "assistant", result.response, {
          channel: parts.channel,
        });
      } catch (historyErr) {
        log.warn({ historyErr }, "failed to store unsolicited result in chat history (non-fatal)");
      }
    }

    const ctx = { chatId: parts.chatId };
    const parsed = splitMediaFromOutput(result.response);

    if (parsed.mediaUrls && parsed.mediaUrls.length > 0 && adapter.sendMedia) {
      for (const url of parsed.mediaUrls) {
        try {
          const mediaType: MediaType = parsed.audioAsVoice && isAudioUrl(url) ? "voice" : guessMediaType(url);
          await adapter.sendMedia({ ctx, media: { type: mediaType, url } });
        } catch (mediaErr) {
          if (!this.queueForRetry(parts.channel, parts.chatId, `[media: ${url}]`, mediaErr)) {
            log.warn({ mediaErr, url }, "failed to send media from unsolicited result (non-fatal)");
          }
        }
      }
    }

    if (parsed.text && parsed.text.trim()) {
      try {
        const receipts = await adapter.sendText({ ctx, text: parsed.text });
        for (const receipt of receipts) {
          this.trackSentMessage(parts.chatId, receipt.id, parsed.text);
        }
        log.info({ sessionKey, channel: parts.channel }, "delivered unsolicited session result");
      } catch (err) {
        if (!this.queueForRetry(parts.channel, parts.chatId, parsed.text, err)) {
          log.error({ sessionKey, err }, "failed to deliver unsolicited session result");
        }
      }
    }
  }

  /**
   * Inject a scheduled message ("post-to-main" delivery) so the agent
   * processes it. A thin wrapper over injectMessage with origin "schedule" and
   * skipIfBusy: a scheduled message never aborts a running or queued turn
   * (DECISIONS 16); the caller retries a "busy" result once the chat is idle.
   */
  async injectScheduleMessage(opts: {
    channel: string;
    chatId: string;
    text: string;
    senderId: string;
    senderName?: string;
  }): Promise<InjectMessageResult> {
    return this.injectMessage({ ...opts, origin: "schedule", skipIfBusy: true });
  }

  /**
   * Start a repeating typing indicator. Fires immediately and then
   * every 4 seconds (most platforms expire typing after ~5s).
   * Returns the interval handle so the caller can clear it.
   */
  private startTypingLoop(
    adapter: ChannelAdapter,
    ctx: { chatId: string; threadId?: string },
  ): ReturnType<typeof setInterval> {
    const send = () => {
      adapter.sendTyping({ ctx }).catch((err) => {
        log.debug({ err }, "typing indicator failed (non-fatal)");
      });
    };

    // Fire immediately
    send();

    // Repeat every 4 seconds
    return setInterval(send, 4000);
  }

  /**
   * Queue a failed message for retry via the heartbeat service.
   * Only queues if the heartbeat service is configured and the error is transient.
   * Returns true if the message was queued, false otherwise.
   */
  private queueForRetry(
    channel: string,
    chatId: string,
    text: string,
    err: unknown,
    threadId?: string,
  ): boolean {
    if (!this.config.heartbeat || !isTransientNetworkError(err)) return false;
    const errorMsg = err instanceof Error ? err.message : String(err);
    this.config.heartbeat.addFailedDelivery(channel, chatId, text, errorMsg, threadId);
    log.info({ channel, chatId }, "queued failed send for retry via heartbeat");
    return true;
  }

  /**
   * Send an error response back to the user through the source adapter.
   * Falls back to sending without replyToId if the reply fails.
   */
  private async sendErrorResponse(
    adapter: ChannelAdapter,
    message: UnifiedMessage,
    errorText: string,
  ): Promise<void> {
    // Don't attempt to reply to injected messages — their synthetic
    // IDs aren't valid platform message IDs.
    const replyToId = isSyntheticId(message.id)
      ? undefined
      : message.reaction
        ? message.reaction.messageId
        : message.id;

    try {
      await adapter.sendText({
        ctx: {
          chatId: message.chatId,
          threadId: message.threadId,
          ...(replyToId ? { replyToId } : {}),
        },
        text: errorText,
      });
    } catch (sendErr) {
      // If we were trying to reply and it failed, retry without replyToId
      if (replyToId) {
        log.warn({ sendErr, originalMessage: message.id }, "reply failed for error response, retrying without reply");
        try {
          await adapter.sendText({
            ctx: {
              chatId: message.chatId,
              threadId: message.threadId,
            },
            text: errorText,
          });
        } catch (fallbackErr) {
          // Last resort: queue for heartbeat retry on transient network errors
          if (!this.queueForRetry(message.channel, message.chatId, errorText, fallbackErr, message.threadId)) {
            log.error({ fallbackErr, originalMessage: message.id }, "failed to send error response even without reply");
          }
        }
      } else {
        // Queue for heartbeat retry on transient network errors
        if (!this.queueForRetry(message.channel, message.chatId, errorText, sendErr, message.threadId)) {
          log.error({ sendErr, originalMessage: message.id }, "failed to send error response");
        }
      }
    }
  }
}

/**
 * The failure of a returned error result, when it was classified into a known
 * class. Aborted turns and unrecognised errors return undefined.
 */
function classifiedFailure(result: ExecutionResult): FailureInfo | undefined {
  if (!result.isError || result.wasAborted || !result.failure) return undefined;
  return result.failure.class === "unknown" ? undefined : result.failure;
}

/**
 * Format rich reply context into a human-readable prefix string.
 * Returns an empty string if no reply context is present.
 *
 * Output format examples:
 *   [Replying to Alice: "What do you think?"]\n
 *   [Replying to user 12345]\n
 *   [Replying to message 789]\n
 */
export function formatReplyContext(replyTo: UnifiedMessage["replyTo"]): string {
  if (!replyTo) return "";

  const parts: string[] = [];
  if (replyTo.senderName) {
    parts.push(`Replying to ${replyTo.senderName}`);
  } else if (replyTo.senderId) {
    parts.push(`Replying to user ${replyTo.senderId}`);
  } else {
    parts.push(`Replying to message ${replyTo.messageId}`);
  }

  if (replyTo.text) {
    const truncated = replyTo.text.length > 200
      ? replyTo.text.slice(0, 200) + "..."
      : replyTo.text;
    parts.push(`"${truncated}"`);
  }

  return `[${parts.join(": ")}]\n`;
}

/**
 * Convert a UnifiedMessage to the IncomingMessage shape expected by AgentEngine.
 */
function unifiedToIncoming(
  message: UnifiedMessage,
  resolvedMedia?: ResolvedMedia[],
  reactionContext?: { isTargetFromBot?: boolean; targetContent?: string },
  failedMedia?: FailedMedia[],
): IncomingMessage {
  return {
    id: message.id,
    channel: message.channel,
    senderName: message.senderName,
    senderId: message.senderId,
    text: message.text,
    chatType: message.chatType,
    chatId: message.chatId,
    threadId: message.threadId,
    replyToId: message.replyToId,
    replyTo: message.replyTo,
    media: resolvedMedia,
    failedMedia,
    isEdited: message.isEdited,
    reaction: message.reaction
      ? {
          emoji: message.reaction.emoji,
          messageId: message.reaction.messageId,
          action: message.reaction.action,
          isTargetFromBot: reactionContext?.isTargetFromBot,
          targetContent: reactionContext?.targetContent,
        }
      : undefined,
  };
}

/** Media directory for downloaded files */
const MEDIA_DIR = join(homedir(), ".kirie", "media");

/**
 * Download media attachments from a channel and save them to disk.
 * Checks size caps and optionally auto-transcribes audio/voice media.
 * Returns resolved media descriptors with local file paths, plus a record of
 * every attachment that could not be downloaded or saved (never dropped
 * silently, so the agent can tell the sender it didn't come through).
 */
export async function downloadAndSaveMedia(
  mediaItems: readonly UnifiedMedia[],
  adapter: ChannelAdapter,
  transcriptionProvider?: TranscriptionProvider,
): Promise<{ resolved: ResolvedMedia[]; failed: FailedMedia[] }> {
  const results: ResolvedMedia[] = [];
  const failed: FailedMedia[] = [];

  for (const media of mediaItems) {
    try {
      if (!adapter.downloadMedia) continue;
      const downloaded = await adapter.downloadMedia(media);

      // Check size cap for this media kind
      const mediaKind = kindFromMime(downloaded.mimeType);
      if (!checkSizeCap(mediaKind, downloaded.buffer.length)) {
        log.warn(
          { mediaType: media.type, size: downloaded.buffer.length, kind: mediaKind },
          "media exceeds size cap, skipping",
        );
        failed.push(toFailedMedia(
          { ...media, sizeBytes: media.sizeBytes ?? downloaded.buffer.length },
          `file is too big (${formatBytes(downloaded.buffer.length)} exceeds Kirie's ${mediaKind} size cap)`,
          true,
        ));
        continue;
      }

      if (!existsSync(MEDIA_DIR)) {
        mkdirSync(MEDIA_DIR, { recursive: true });
      }

      const hash = createHash("sha256").update(downloaded.buffer).digest("hex").slice(0, 12);
      const ext = extensionFromMime(downloaded.mimeType) ?? extensionFromFilename(downloaded.filename) ?? "bin";
      const filename = `${Date.now()}-${hash}.${ext}`;
      const localPath = join(MEDIA_DIR, filename);

      writeFileSync(localPath, downloaded.buffer);

      // Auto-transcribe audio/voice media if provider is configured
      let transcript: string | undefined;
      if (
        transcriptionProvider &&
        (media.type === "voice" || media.type === "audio" || downloaded.mimeType.startsWith("audio/"))
      ) {
        try {
          transcript = await transcriptionProvider.transcribe(downloaded.buffer, {
            mime: downloaded.mimeType,
          });
          log.debug({ localPath, transcriptLength: transcript.length }, "audio transcribed");
        } catch (transcribeErr) {
          log.warn({ transcribeErr, localPath }, "auto-transcription failed (non-fatal)");
        }
      }

      results.push({
        localPath,
        type: media.type,
        mimeType: downloaded.mimeType,
        caption: media.caption,
        filename: media.filename,
        transcript,
      });

      log.debug({ localPath, type: media.type, size: downloaded.buffer.length }, "media saved to disk");
    } catch (err) {
      const { reason, tooBig } = describeMediaDownloadError(err, adapter.id);
      log.warn(
        { err, mediaType: media.type, sizeBytes: media.sizeBytes, url: media.url.slice(0, 100), reason },
        "failed to download media (agent will be told)",
      );
      failed.push(toFailedMedia(media, reason, tooBig));
    }
  }

  return { resolved: results, failed };
}

function extensionFromMime(mimeType: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "video/mp4": "mp4", "video/webm": "webm", "audio/ogg": "ogg", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "application/pdf": "pdf",
  };
  return map[mimeType] ?? null;
}

function extensionFromFilename(filename: string): string | null {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()! : null;
}

/**
 * Convert a ResolvedIdentity to the SenderIdentity shape expected by AgentEngine.
 */
/** The session key of a message, as resolveRoute computes it. */
function sessionKeyOf(message: UnifiedMessage): string {
  return makeSessionKey({ channel: message.channel, chatType: message.chatType, chatId: message.chatId });
}

function identityToSender(identity: ResolvedIdentity, displayName: string): SenderIdentity {
  return {
    name: displayName,
    platformId: identity.senderId,
    role: identity.role,
  };
}

/**
 * Guess media type from a URL based on file extension.
 */
function guessMediaType(url: string): MediaType {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/.test(lower)) return "photo";
  if (/\.(mp4|webm|mov|avi|mkv)$/.test(lower)) return "video";
  if (/\.(mp3|ogg|oga|wav|m4a|flac|aac|opus)$/.test(lower)) return "audio";
  return "document";
}

/**
 * Check if a URL points to an audio file.
 */
function isAudioUrl(url: string): boolean {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  return /\.(mp3|ogg|oga|wav|m4a|flac|aac|opus)$/.test(lower);
}
