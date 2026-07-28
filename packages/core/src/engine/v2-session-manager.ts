import {
  query,
  type Query,
  type Options,
  type PermissionMode,
  type SDKUserMessage,
  type SDKResultMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { SessionStore } from "./session-store.js";
import {
  wrapUserMessage,
  type AgentExecutor,
  type ExecutionResult,
  type IncomingMessage,
  type ChatHistoryMessage,
} from "./agent-engine.js";
import {
  buildPrompt,
  type ChannelContext,
  type PromptConfig,
  type SenderIdentity,
} from "./prompt-builder.js";
import { makeSessionKey } from "../routing/session-key.js";

const log = pino({ name: "v2-session-manager" });

/**
 * A deferred promise that can be resolved/rejected externally.
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A push-driven async iterable of user messages.
 *
 * This is what keeps a session open. `query()` treats a string prompt as a
 * one-shot request and tears the subprocess down once it completes, but an
 * AsyncIterable prompt puts it in streaming-input mode: the subprocess stays
 * alive waiting for the next message. Pushing here is how we "send".
 */
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("cannot send on a closed session");

    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };

    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  /** Ends the input stream, which lets the subprocess shut down cleanly. */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const queued = this.pending.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.closed) return;

      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

/**
 * Tracks an active session and its background stream consumer.
 */
interface ManagedSession {
  stream: Query;
  input: UserMessageQueue;
  sessionKey: string;
  sdkSessionId: string | null;
  streamConsumer: Promise<void>;
  pendingResult: Deferred<ExecutionResult> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
}

/**
 * Configuration for the V2SessionManager.
 */
export interface V2SessionManagerConfig {
  /** Workspace path used as the subprocess cwd */
  workspacePath: string;
  /** Model to use for sessions */
  model: string;
  /**
   * Prompt configuration, used to build the per-session system prompt the same
   * way AgentEngine does. Omit only in tests.
   */
  prompt?: PromptConfig;
  /** Permission mode for sessions */
  permissionMode?: PermissionMode;
  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[];
  /** Tools to disallow entirely (removed from model context) */
  disallowedTools?: string[];
  /** MCP servers to expose to the session */
  mcpServers?: Record<string, McpServerConfig>;
  /** Maximum agent turns per message */
  maxTurns?: number;
  /** Idle timeout in ms before closing a session (default 10 minutes) */
  idleTimeoutMs?: number;
  /** Maximum concurrent sessions (default 20) */
  maxSessions?: number;
  /** Optional environment variables to pass to subprocesses */
  env?: Record<string, string>;
}

/**
 * Per-session values derived from the first message on that session.
 *
 * A persistent session's system prompt and model are fixed when the subprocess
 * starts, so they come from the message that opens the session rather than
 * being rebuilt per message the way the one-shot path does it.
 */
interface SessionBootstrap {
  systemPrompt?: Options["systemPrompt"];
  model?: string;
  maxTurns?: number;
}

/**
 * V2SessionManager manages persistent agent sessions.
 *
 * The default V1 path calls `query()` with a string prompt, which spawns a
 * subprocess, answers one message, and exits — so every message pays full
 * startup cost. This manager instead drives `query()` in streaming-input mode,
 * keeping one subprocess alive per session key and pushing follow-up messages
 * into it.
 *
 * Sessions are keyed by session key (e.g. "telegram:dm:123"), resumed from a
 * persisted SDK session ID when possible, closed after an idle timeout, and
 * evicted oldest-first once the concurrency cap is reached.
 */
export class V2SessionManager implements AgentExecutor {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly sessionStore: SessionStore;
  private readonly config: V2SessionManagerConfig;
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(sessionStore: SessionStore, config: V2SessionManagerConfig) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 10 * 60 * 1000; // 10 minutes
    this.maxSessions = config.maxSessions ?? 20;

    // Periodically check for idle sessions
    this.idleCheckInterval = setInterval(() => this.closeIdleSessions(), 60_000);
  }

  /**
   * Execute a user message through a persistent session.
   *
   * Gets or creates a session for the given session key, sends the
   * message, and waits for the result from the background stream consumer.
   *
   * If the result is an error (e.g. from a stale session ID that can't be
   * resumed), automatically retries once with a fresh session.
   */
  async execute(
    message: IncomingMessage,
    sender: SenderIdentity,
    sessionId?: string,
    onQuery?: (q: Query) => void,
    chatHistory?: ChatHistoryMessage[],
  ): Promise<ExecutionResult> {
    const sessionKey = makeSessionKey({
      channel: message.channel,
      chatType: message.chatType,
      chatId: message.chatId,
    });

    const bootstrap = this.buildBootstrap(message, sender);
    const userPrompt = wrapUserMessage(
      message,
      chatHistory,
      sessionKey,
      this.config.prompt?.timezone,
    );

    const result = await this.sendAndWait(sessionKey, userPrompt, bootstrap, sessionId, onQuery);

    if (result.isError) {
      log.warn(
        { sessionKey, response: result.response.slice(0, 200) },
        "session returned error result, retrying with fresh session",
      );
      this.cleanupSession(sessionKey);
      this.sessionStore.delete(sessionKey);

      return this.sendAndWait(sessionKey, userPrompt, bootstrap, undefined, onQuery);
    }

    return result;
  }

  /**
   * Build the values that are fixed for the lifetime of a session.
   */
  private buildBootstrap(message: IncomingMessage, sender: SenderIdentity): SessionBootstrap {
    if (!this.config.prompt) {
      return { model: this.config.model, maxTurns: this.config.maxTurns };
    }

    const channel: ChannelContext = {
      channel: message.channel,
      chatType: message.chatType,
      chatId: message.chatId,
      threadId: message.threadId,
    };

    const built = buildPrompt({ config: this.config.prompt, channel, sender });
    return {
      systemPrompt: built.systemPrompt,
      model: built.model ?? this.config.model,
      maxTurns: built.maxTurns ?? this.config.maxTurns,
    };
  }

  /**
   * Send a message and wait for the result. Handles send failures by
   * recreating the session.
   */
  private async sendAndWait(
    sessionKey: string,
    userMessage: string,
    bootstrap: SessionBootstrap,
    resumeSessionId?: string,
    onQuery?: (q: Query) => void,
  ): Promise<ExecutionResult> {
    const managed = this.getOrCreate(sessionKey, bootstrap, resumeSessionId);
    managed.lastActivity = Date.now();
    this.resetIdleTimer(managed);

    // Expose the live Query so the pipeline can interrupt this turn
    // (/stop, /stopall, or a newer message superseding this one).
    onQuery?.(managed.stream);

    const deferred = createDeferred<ExecutionResult>();
    managed.pendingResult = deferred;

    try {
      managed.input.push(userMessage);
    } catch (err) {
      managed.pendingResult = null;
      // Session is dead (input stream already closed) — recreate it.
      log.warn({ sessionKey, err }, "send failed, recreating session");
      this.cleanupSession(sessionKey);
      this.sessionStore.delete(sessionKey);

      const fresh = this.createNewSession(sessionKey, bootstrap);
      onQuery?.(fresh.stream);
      const freshDeferred = createDeferred<ExecutionResult>();
      fresh.pendingResult = freshDeferred;

      try {
        fresh.input.push(userMessage);
        return await freshDeferred.promise;
      } catch (retryErr) {
        fresh.pendingResult = null;
        this.cleanupSession(sessionKey);
        throw retryErr;
      }
    }

    return deferred.promise;
  }

  /**
   * Get an existing session or create a new one for the given session key.
   */
  private getOrCreate(
    sessionKey: string,
    bootstrap: SessionBootstrap,
    resumeSessionId?: string,
  ): ManagedSession {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    // Resume the caller's session ID if given, else whatever we persisted
    const savedSessionId = resumeSessionId ?? this.sessionStore.get(sessionKey);
    if (savedSessionId) {
      try {
        return this.startSession(sessionKey, savedSessionId, bootstrap);
      } catch (err) {
        log.warn({ sessionKey, savedSessionId, err }, "failed to resume session, creating new");
      }
    }

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestSession();
    }

    return this.createNewSession(sessionKey, bootstrap);
  }

  /**
   * Create a brand new session.
   */
  private createNewSession(sessionKey: string, bootstrap: SessionBootstrap): ManagedSession {
    log.info({ sessionKey }, "creating new session");
    return this.startSession(sessionKey, null, bootstrap);
  }

  /**
   * Start a session, optionally resuming a previous SDK session by ID.
   */
  private startSession(
    sessionKey: string,
    resumeSessionId: string | null,
    bootstrap: SessionBootstrap,
  ): ManagedSession {
    if (resumeSessionId) {
      log.info({ sessionKey, sdkSessionId: resumeSessionId }, "resuming session");
    }

    const input = new UserMessageQueue();
    const stream = query({
      prompt: input,
      options: this.createOptions(resumeSessionId, bootstrap),
    });

    const managed: ManagedSession = {
      stream,
      input,
      sessionKey,
      sdkSessionId: resumeSessionId,
      streamConsumer: Promise.resolve(),
      pendingResult: null,
      idleTimer: null,
      lastActivity: Date.now(),
    };

    managed.streamConsumer = this.startStreamConsumer(managed);

    this.sessions.set(sessionKey, managed);
    return managed;
  }

  /**
   * Build Options for a session.
   *
   * Unlike the removed unstable_v2 API, mainline `query()` accepts mcpServers
   * and systemPrompt directly, so there is no need to stage them through
   * .claude/settings.json or CLAUDE.md in the workspace.
   */
  private createOptions(resumeSessionId: string | null, bootstrap: SessionBootstrap): Options {
    const options: Options = {
      model: bootstrap.model ?? this.config.model,
      permissionMode: this.config.permissionMode ?? "bypassPermissions",
      cwd: this.config.workspacePath,
      // Matches the one-shot path: without this the SDK discovers no
      // filesystem skills from ~/.claude/skills or {cwd}/.claude/skills.
      settingSources: ["user", "project"],
    };

    if (this.config.allowedTools) options.allowedTools = this.config.allowedTools;
    if (this.config.disallowedTools) options.disallowedTools = this.config.disallowedTools;
    if (this.config.mcpServers) options.mcpServers = this.config.mcpServers;
    if (bootstrap.systemPrompt) options.systemPrompt = bootstrap.systemPrompt;
    if (bootstrap.maxTurns != null) options.maxTurns = bootstrap.maxTurns;
    if (this.config.env) options.env = { ...process.env, ...this.config.env } as Record<string, string>;
    if (resumeSessionId) options.resume = resumeSessionId;

    return options;
  }

  /**
   * Background stream consumer that reads messages from the session.
   * Runs for the lifetime of the session, resolving pending deferreds
   * when result messages arrive.
   */
  private async startStreamConsumer(managed: ManagedSession): Promise<void> {
    const textParts: string[] = [];

    try {
      for await (const msg of managed.stream) {
        switch (msg.type) {
          case "assistant": {
            for (const block of msg.message.content) {
              if ("type" in block && block.type === "text" && "text" in block) {
                textParts.push(block.text as string);
              }
            }

            if (msg.session_id) {
              managed.sdkSessionId = msg.session_id;
              this.sessionStore.set(managed.sessionKey, msg.session_id);
            }
            break;
          }

          case "result": {
            const resultMsg = msg as SDKResultMessage;
            const sessionId = resultMsg.session_id;

            const response =
              resultMsg.subtype === "success"
                ? resultMsg.result
                : resultMsg.errors.length > 0
                  ? resultMsg.errors.join("\n")
                  : textParts.join("");

            if (sessionId) {
              managed.sdkSessionId = sessionId;
              this.sessionStore.set(managed.sessionKey, sessionId);
            }

            if (managed.pendingResult) {
              managed.pendingResult.resolve({
                response,
                sessionId,
                costUsd: resultMsg.total_cost_usd,
                numTurns: resultMsg.num_turns,
                isError: resultMsg.is_error,
              });
              managed.pendingResult = null;
            }

            // Clear collected text for the next message on this session
            textParts.length = 0;
            break;
          }

          default:
            // system, user, stream_event, tool_progress, auth_status etc.
            // are consumed but not acted upon
            break;
        }
      }
    } catch (err) {
      log.error({ sessionKey: managed.sessionKey, err }, "stream consumer error");

      if (managed.pendingResult) {
        managed.pendingResult.reject(err);
        managed.pendingResult = null;
      }
    } finally {
      log.info({ sessionKey: managed.sessionKey }, "stream consumer ended");

      // If a deferred is still pending, the stream ended without producing a
      // result — the subprocess exited unexpectedly (startup failure, missing
      // executable, permissions). Reject so the caller doesn't hang forever.
      if (managed.pendingResult) {
        managed.pendingResult.reject(
          new Error("Session stream ended without producing a result"),
        );
        managed.pendingResult = null;
      }

      this.sessions.delete(managed.sessionKey);
      if (managed.idleTimer) {
        clearTimeout(managed.idleTimer);
      }
    }
  }

  /**
   * Reset the idle timer for a managed session.
   */
  private resetIdleTimer(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }

    managed.idleTimer = setTimeout(() => {
      log.info({ sessionKey: managed.sessionKey }, "closing idle session");
      this.closeSession(managed.sessionKey);
    }, this.idleTimeoutMs);
  }

  /**
   * Close a specific session by key.
   */
  closeSession(sessionKey: string): void {
    this.cleanupSession(sessionKey);
  }

  /**
   * Internal cleanup of a session.
   */
  private cleanupSession(sessionKey: string): void {
    const managed = this.sessions.get(sessionKey);
    if (!managed) return;

    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }

    if (managed.pendingResult) {
      managed.pendingResult.reject(new Error("Session closed"));
      managed.pendingResult = null;
    }

    // Ending the input stream lets the subprocess exit on its own; interrupt()
    // covers the case where it is mid-turn and would otherwise keep running.
    try {
      managed.input.close();
    } catch (err) {
      log.debug({ sessionKey, err }, "error closing session input");
    }

    void Promise.resolve(managed.stream.interrupt?.()).catch(() => {
      // Session may already be gone, or the CLI may not support interrupt
    });

    this.sessions.delete(sessionKey);
  }

  /**
   * Close all sessions that have been idle past the timeout.
   */
  private closeIdleSessions(): void {
    const now = Date.now();
    for (const [key, managed] of this.sessions) {
      if (now - managed.lastActivity > this.idleTimeoutMs && !managed.pendingResult) {
        log.info({ sessionKey: key }, "closing idle session (periodic check)");
        this.cleanupSession(key);
      }
    }
  }

  /**
   * Evict the oldest idle session to make room for a new one.
   */
  private evictOldestSession(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, managed] of this.sessions) {
      // Don't evict sessions with pending results
      if (!managed.pendingResult && managed.lastActivity < oldestTime) {
        oldestTime = managed.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      log.info({ sessionKey: oldestKey }, "evicting oldest session (capacity reached)");
      this.cleanupSession(oldestKey);
    }
  }

  /**
   * Get the number of active sessions.
   */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Check if a session exists for the given key.
   */
  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /**
   * Shut down all sessions and stop the idle check interval.
   */
  async shutdown(): Promise<void> {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }

    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      this.cleanupSession(key);
    }

    log.info({ closedSessions: keys.length }, "V2 session manager shut down");
  }
}
