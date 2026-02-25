import pino from "pino";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { checkSizeCap, kindFromMime } from "@kirie/media";
import type { TranscriptionProvider } from "@kirie/media";
import type { UnifiedMessage, ChannelName, UnifiedMedia, MediaType } from "../channels/normalizer.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelAdapter, ResolvedMedia } from "../channels/adapter.js";
import { splitMediaFromOutput } from "../engine/media-output-parser.js";
import { SecurityGate, type GateResult } from "../security/gate.js";
import { resolveRoute } from "./resolve-route.js";
import { parseSessionKey } from "./session-key.js";
import type { SessionStore } from "../engine/session-store.js";
import { LaneQueue } from "../engine/lane-queue.js";
import { AgentEngine, type IncomingMessage, type ExecutionResult, type ChatHistoryMessage } from "../engine/agent-engine.js";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { SenderIdentity } from "../engine/prompt-builder.js";
import type { ResolvedIdentity } from "../security/auth.js";
import type { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import type { BackgroundTaskStore, BackgroundTask } from "../engine/background-task-store.js";
import type { AutoReplyEngine } from "../auto-reply/auto-reply.js";
import type { UsageTracker } from "../logging/usage-tracker.js";
import type { HeartbeatService } from "../engine/heartbeat.js";
import { isTransientNetworkError } from "../engine/network-errors.js";

const log = pino({ name: "message-pipeline" });

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
  agentEngine: AgentEngine;
  /** LaneQueue debounce in ms (default 1500) */
  debounceMs?: number;
  /** Optional chat history store for persisting messages */
  chatHistoryStore?: ChatHistoryStore;
  /** Optional background task store for context injection */
  backgroundTaskStore?: BackgroundTaskStore;
  /** Optional auto-reply engine for fast command responses (bypasses agent) */
  autoReply?: AutoReplyEngine;
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
   * Track bot-sent message IDs so we can identify reactions to bot messages.
   * Maps chatId -> messageId -> truncated message text.
   * Entries are pruned when the map exceeds MAX_TRACKED_MESSAGES per chat.
   */
  private readonly sentMessages = new Map<string, Map<string, string>>();
  private static readonly MAX_TRACKED_PER_CHAT = 200;

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
      adapter.onMessage((message) => this.handleMessage(message, adapter));
    }

    // Wire up newly registered adapters
    this.config.channelRegistry.on("registered", (id: ChannelName) => {
      const adapter = this.config.channelRegistry.getById(id);
      if (adapter) {
        log.info({ channel: id }, "wiring message listener for new adapter");
        adapter.onMessage((message) => this.handleMessage(message, adapter));
      }
    });
  }

  /**
   * Stop the pipeline, clearing all pending lane queue items.
   */
  stop(): void {
    this.started = false;
    this.laneQueue.clearAll();
  }

  /**
   * Handle an incoming message through the full pipeline.
   * This is the core message flow.
   */
  private async handleMessage(
    message: UnifiedMessage,
    sourceAdapter: ChannelAdapter,
  ): Promise<void> {
    const messageId = message.id;
    const channel = message.channel;

    log.info(
      { messageId, channel, senderId: message.senderId, chatType: message.chatType },
      "message received",
    );

    // Step 0: Auto-reply check (fast path, skips agent entirely)
    if (this.config.autoReply && message.text) {
      try {
        const autoResponse = await this.config.autoReply.match(message.text, {
          senderName: message.senderName,
          senderId: message.senderId,
          channel: message.channel,
          chatType: message.chatType,
          chatId: message.chatId,
        });
        if (autoResponse) {
          log.info({ messageId, channel }, "auto-reply matched");
          const isScheduleMsg = message.id.startsWith("schedule-");
          try {
            const autoReceipts = await sourceAdapter.sendText({
              ctx: {
                chatId: message.chatId,
                threadId: message.threadId,
                ...(isScheduleMsg ? {} : { replyToId: message.id }),
              },
              text: autoResponse,
            });
            for (const r of autoReceipts) {
              this.trackSentMessage(message.chatId, r.id, autoResponse);
            }
          } catch (autoSendErr) {
            // On transient network errors, queue for retry instead of losing the auto-reply
            this.queueForRetry(channel, message.chatId, autoResponse, autoSendErr, message.threadId);
          }
          return;
        }
      } catch (autoErr) {
        log.warn({ autoErr, messageId }, "auto-reply error (falling through to agent)");
      }
    }

    // Step 1: Security gate
    const gateResult: GateResult = this.config.securityGate.check(message);

    if (!gateResult.passed) {
      return;
    }

    // Step 1.5: Download and save media attachments to disk
    let resolvedMedia: ResolvedMedia[] | undefined;
    if (message.media && message.media.length > 0 && sourceAdapter.downloadMedia) {
      resolvedMedia = await downloadAndSaveMedia(
        message.media,
        sourceAdapter,
        this.config.transcriptionProvider,
      );
    }

    // Step 2: Route resolution
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
      unifiedToIncoming(message, resolvedMedia, reactionContext),
      this.config.sessionStore,
    );

    log.debug(
      { messageId, sessionKey: route.sessionKey, hasSession: !!route.sdkSessionId },
      "route resolved",
    );

    // Step 3: Interrupt running agent if one is active for this session
    if (this.runningQueries.has(route.sessionKey)) {
      log.info({ sessionKey: route.sessionKey }, "new message arrived while agent busy — interrupting");
      this.abortSession(route.sessionKey);
    }

    // Step 4: Enqueue in LaneQueue for per-session serialization
    try {
      // Start typing indicator loop while agent is working
      const typingCtx = {
        chatId: message.chatId,
        threadId: message.threadId,
      };
      const typingInterval = this.startTypingLoop(sourceAdapter, typingCtx);

      const result = await this.laneQueue.enqueue(route.sessionKey, async () => {
        // Step 5: Execute through AgentEngine
        const sender = identityToSender(gateResult.identity, message.senderName);

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
            let historyText = message.text;
            if (message.isEdited) {
              historyText = `[edited] ${historyText}`;
            }
            if (message.reaction) {
              const verb = message.reaction.action === "add" ? "reacted with" : "removed";
              const target = reactionContext?.isTargetFromBot ? " on bot's message" : "";
              historyText = `[${verb} ${message.reaction.emoji}${target} (msg ${message.reaction.messageId})]`;
              if (reactionContext?.targetContent) {
                historyText += ` "${reactionContext.targetContent.slice(0, 100)}"`;
              }
            }
            this.config.chatHistoryStore.append(route.sessionKey, "user", historyText, {
              senderName: message.senderName,
              senderId: message.senderId,
              channel: message.channel,
            });
          } catch (historyErr) {
            log.warn({ historyErr }, "failed to store user message in chat history (non-fatal)");
          }
        }

        // Inject completed background task results as context
        const taskContext = this.buildBackgroundTaskContext(route.sessionKey);

        // Prepend rich reply context so the agent sees what message is being replied to
        const replyPrefix = formatReplyContext(route.message.replyTo);

        const contextPrefix = [taskContext, replyPrefix].filter(Boolean).join("\n\n");
        const messageWithContext = contextPrefix
          ? { ...route.message, text: contextPrefix + route.message.text }
          : route.message;

        // Execute through the agent engine. Register the Query handle so
        // /stop, /stopall, and message interruption can call query.close()
        // to immediately terminate the SDK subprocess.
        let executionResult: ExecutionResult;
        try {
          executionResult = await this.config.agentEngine.execute(
            messageWithContext,
            sender,
            route.sdkSessionId ?? undefined,
            (q) => { this.runningQueries.set(route.sessionKey, q); },
            chatHistory,
          );
        } finally {
          this.runningQueries.delete(route.sessionKey);
        }

        // Step 5: Persist the new/updated session ID
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
          },
          "agent execution complete",
        );

        // Record usage for dashboard/analytics
        if (this.config.usageTracker) {
          try {
            this.config.usageTracker.record({
              model: this.config.model ?? "unknown",
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

        // Store assistant response in chat history (user message was saved before execution).
        // If the execution was aborted (interrupted by a new message), save the partial
        // response with an [interrupted] prefix so the agent knows it was cut short.
        if (this.config.chatHistoryStore && executionResult.response) {
          try {
            const responseText = executionResult.wasAborted
              ? `[interrupted — new message arrived] ${executionResult.response}`
              : executionResult.response;
            this.config.chatHistoryStore.append(route.sessionKey, "assistant", responseText, {
              channel: message.channel,
            });
          } catch (historyErr) {
            log.warn({ historyErr }, "failed to store assistant response in chat history (non-fatal)");
          }
        }

        return executionResult;
      }).finally(() => {
        clearInterval(typingInterval);
      });

      // Step 6: Send response back through the originating channel.
      // Skip sending if the execution was aborted (user sent a new message —
      // they'll get a fresh response from the new execution).
      if (result.response && !result.wasAborted) {
        // For reaction events, reply to the message that was reacted to
        // (not the synthetic reaction event ID which isn't a valid platform message).
        // For schedule-injected messages, don't set replyToId at all — the
        // synthetic ID (e.g. "schedule-1738000000000") isn't a real platform
        // message ID and would cause the send to fail.
        const isScheduleMessage = message.id.startsWith("schedule-");
        const replyToId = isScheduleMessage
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
        log.warn({ messageId, response: result.response }, "agent returned error result");
      }
    } catch (err) {
      log.error({ messageId, err }, "pipeline error");

      await this.sendErrorResponse(
        sourceAdapter,
        message,
        "Sorry, an internal error occurred while processing your message.",
      );
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
   * Inject a scheduled message into the pipeline as if a user sent it.
   * Used by "post-to-main" delivery mode so the agent actually processes the message.
   */
  async injectScheduleMessage(opts: {
    channel: string;
    chatId: string;
    text: string;
    senderId: string;
    senderName?: string;
  }): Promise<void> {
    const adapter = this.config.channelRegistry.getById(opts.channel);
    if (!adapter || !this.config.channelRegistry.isRunning(opts.channel)) {
      log.warn({ channel: opts.channel }, "channel not available for schedule injection");
      return;
    }

    const syntheticMessage: UnifiedMessage = {
      id: `schedule-${Date.now()}`,
      channel: opts.channel as ChannelName,
      senderId: opts.senderId,
      senderName: opts.senderName || "Schedule",
      text: opts.text,
      chatType: "dm",
      chatId: opts.chatId,
    };

    await this.handleMessage(syntheticMessage, adapter);
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
    // Don't attempt to reply to schedule-injected messages — their synthetic
    // IDs aren't valid platform message IDs.
    const isScheduleMsg = message.id.startsWith("schedule-");
    const replyToId = isScheduleMsg
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
 * Returns resolved media descriptors with local file paths.
 */
async function downloadAndSaveMedia(
  mediaItems: readonly UnifiedMedia[],
  adapter: ChannelAdapter,
  transcriptionProvider?: TranscriptionProvider,
): Promise<ResolvedMedia[]> {
  if (!existsSync(MEDIA_DIR)) {
    mkdirSync(MEDIA_DIR, { recursive: true });
  }

  const results: ResolvedMedia[] = [];

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
        continue;
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
      log.warn({ err, mediaType: media.type, url: media.url.slice(0, 100) }, "failed to download media (skipping)");
    }
  }

  return results;
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
