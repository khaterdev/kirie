import { randomUUID } from "node:crypto";
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
import {
  attachFailure,
  classifyFailure,
  feedTurnSignals,
  isHardFailure,
  logSdkSignal,
  newTurnSignals,
  type TurnSignals,
} from "./failure.js";
import {
  chatCallContext,
  type SdkCallContext,
  type SdkOptionsPipeline,
  type SdkTurnEndResult,
} from "./sdk-options.js";

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

  /** Queue a user message and return the uuid stamped on it. */
  push(text: string): string {
    if (this.closed) throw new Error("cannot send on a closed session");

    const uuid = randomUUID();
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
    };

    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: message, done: false });
      return uuid;
    }
    this.pending.push(message);
    return uuid;
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
  /** Assistant text collected so far for the in-flight turn. */
  textParts: string[];
  /** Set when the caller closed the session mid-turn via the onQuery handle. */
  aborted: boolean;
  /** Context this session's options were built with (fixed for its lifetime). */
  ctx: SdkCallContext;
  /** Failure signals gathered since the last result. */
  signals: TurnSignals;
  /** uuid of the user message whose turn is in flight. */
  currentUuid: string | undefined;
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
  /** Shared SDK options seam (hooks, gates, contributors, stream observers) */
  sdkOptions?: SdkOptionsPipeline;
  /**
   * Called for a `result` that arrives with no turn pending, e.g. the final
   * answer of an async subagent after the turn already returned
   * "waiting for the agent". Can also be set later with setUnsolicitedResultHandler.
   */
  onUnsolicitedResult?: UnsolicitedResultHandler;
}

/** Receives a result that arrived while no turn was waiting for it. */
export type UnsolicitedResultHandler = (sessionKey: string, result: ExecutionResult) => void;

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
  /** Call context for the SDK options seam, from the message that opens the session. */
  ctx: SdkCallContext;
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
  private unsolicitedHandler: UnsolicitedResultHandler | null;

  constructor(sessionStore: SessionStore, config: V2SessionManagerConfig) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.unsolicitedHandler = config.onUnsolicitedResult ?? null;
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
      // A usage limit, auth failure, unavailable model or overload is not a
      // stale session. Wiping the mapping and retrying fresh would hit the same
      // wall and lose the conversation, so the session and mapping are kept.
      if (isHardFailure(result.failure)) {
        log.warn(
          { sessionKey, failureClass: result.failure.class },
          "session returned a limit/account error; keeping the session, not retrying fresh",
        );
        return result;
      }
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
    const ctx = chatCallContext({
      sessionKey: makeSessionKey({ channel: message.channel, chatType: message.chatType, chatId: message.chatId }),
      channel: message.channel,
      chatType: message.chatType,
      senderRole: sender.role,
      cwd: this.config.workspacePath,
    });

    if (!this.config.prompt) {
      return { model: this.config.model, maxTurns: this.config.maxTurns, ctx };
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
      ctx,
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
    onQuery?.(this.abortHandle(managed));

    const deferred = createDeferred<ExecutionResult>();
    managed.pendingResult = deferred;

    try {
      const uuid = managed.input.push(userMessage);
      this.beginTurn(managed, uuid);
    } catch (err) {
      managed.pendingResult = null;
      // Session is dead (input stream already closed) — recreate it.
      log.warn({ sessionKey, err }, "send failed, recreating session");
      this.cleanupSession(sessionKey);
      this.sessionStore.delete(sessionKey);

      const fresh = this.createNewSession(sessionKey, bootstrap);
      onQuery?.(this.abortHandle(fresh));
      const freshDeferred = createDeferred<ExecutionResult>();
      fresh.pendingResult = freshDeferred;

      try {
        const uuid = fresh.input.push(userMessage);
        this.beginTurn(fresh, uuid);
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
   * Wrap a session's Query so the pipeline's close() behaves like the one-shot
   * path: the in-flight turn resolves with its partial text marked wasAborted
   * instead of rejecting, and the SDK session ID stays persisted so the next
   * message resumes the conversation in a fresh subprocess.
   *
   * The session is detached synchronously. The pipeline sends the superseding
   * message right after close(), and without this it would be pushed into the
   * dying subprocess still registered under the same key.
   */
  private abortHandle(managed: ManagedSession): Query {
    const close = (): void => {
      if (managed.aborted) return;
      managed.aborted = true;

      if (this.sessions.get(managed.sessionKey) === managed) {
        this.sessions.delete(managed.sessionKey);
      }
      if (managed.idleTimer) {
        clearTimeout(managed.idleTimer);
        managed.idleTimer = null;
      }

      if (managed.pendingResult) {
        const uuid = managed.currentUuid;
        this.endTurn(managed, { isError: false, wasAborted: true, costUsd: 0, numTurns: 0 });
        managed.pendingResult.resolve({
          response: managed.textParts.join(""),
          sessionId: managed.sdkSessionId ?? "",
          costUsd: 0,
          numTurns: 0,
          isError: false,
          wasAborted: true,
          accountId: null,
          ...(uuid ? { userMessageUuid: uuid } : {}),
        });
        managed.pendingResult = null;
      }

      managed.input.close();
      managed.stream.close();
    };

    return new Proxy(managed.stream, {
      get(target, prop) {
        if (prop === "close") return close;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
    const options = this.createOptions(resumeSessionId, bootstrap);
    this.config.sdkOptions?.apply(options, bootstrap.ctx);
    const stream = query({ prompt: input, options });

    const managed: ManagedSession = {
      stream,
      input,
      sessionKey,
      sdkSessionId: resumeSessionId,
      streamConsumer: Promise.resolve(),
      pendingResult: null,
      idleTimer: null,
      lastActivity: Date.now(),
      textParts: [],
      aborted: false,
      ctx: bootstrap.ctx,
      signals: newTurnSignals(),
      currentUuid: undefined,
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
    const textParts = managed.textParts;
    const sdkOptions = this.config.sdkOptions;

    try {
      for await (const msg of managed.stream) {
        sdkOptions?.observe({ type: "message", ctx: managed.ctx, message: msg });
        feedTurnSignals(managed.signals, msg);
        logSdkSignal(log, managed.ctx.label, msg);

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

            const failure = resultMsg.is_error
              ? classifyFailure({ text: response, signals: managed.signals })
              : null;
            const model = managed.signals.model;
            const uuid = managed.currentUuid;
            const result: ExecutionResult = {
              response,
              sessionId,
              costUsd: resultMsg.total_cost_usd,
              numTurns: resultMsg.num_turns,
              isError: resultMsg.is_error,
              ...(failure ? { failure } : {}),
              ...(model ? { model } : {}),
              accountId: null,
              ...(uuid ? { userMessageUuid: uuid } : {}),
            };

            this.endTurn(managed, {
              isError: resultMsg.is_error,
              wasAborted: false,
              costUsd: resultMsg.total_cost_usd,
              numTurns: resultMsg.num_turns,
              ...(model ? { model } : {}),
            });

            if (managed.pendingResult) {
              managed.pendingResult.resolve(result);
              managed.pendingResult = null;
            } else {
              this.deliverUnsolicited(managed, result);
            }

            // Clear collected text and signals for the next message on this session
            textParts.length = 0;
            managed.signals = newTurnSignals();

            // Idle time counts from the end of the turn, not from the send
            managed.lastActivity = Date.now();
            if (!managed.aborted) this.resetIdleTimer(managed);
            break;
          }

          default:
            // system, user, stream_event, tool_progress, auth_status etc.
            // are consumed but not acted upon
            break;
        }
      }
    } catch (err) {
      if (!managed.aborted) {
        log.error({ sessionKey: managed.sessionKey, err }, "stream consumer error");
      }

      if (managed.pendingResult) {
        const failure = classifyFailure({ error: err, signals: managed.signals });
        if (failure) attachFailure(err, failure);
        this.endTurn(managed, { isError: true, wasAborted: false, costUsd: 0, numTurns: 0 });
        managed.pendingResult.reject(err);
        managed.pendingResult = null;
      }
    } finally {
      log.info({ sessionKey: managed.sessionKey }, "stream consumer ended");

      // If a deferred is still pending, the stream ended without producing a
      // result — the subprocess exited unexpectedly (startup failure, missing
      // executable, permissions). Reject so the caller doesn't hang forever.
      if (managed.pendingResult) {
        this.endTurn(managed, { isError: true, wasAborted: false, costUsd: 0, numTurns: 0 });
        managed.pendingResult.reject(
          new Error("Session stream ended without producing a result"),
        );
        managed.pendingResult = null;
      }

      // An aborted session is detached before its stream ends, and a
      // replacement may already be registered under the same key.
      if (this.sessions.get(managed.sessionKey) === managed) {
        this.sessions.delete(managed.sessionKey);
      }
      if (managed.idleTimer) {
        clearTimeout(managed.idleTimer);
      }
    }
  }

  /** Start a turn: reset its signals and emit turn_start. */
  private beginTurn(managed: ManagedSession, uuid: string): void {
    managed.currentUuid = uuid;
    managed.signals = newTurnSignals();
    this.config.sdkOptions?.observe({
      type: "turn_start",
      ctx: managed.ctx,
      userMessageUuid: uuid,
      ...(managed.sdkSessionId ? { sdkSessionId: managed.sdkSessionId } : {}),
      accountId: null,
    });
  }

  /**
   * Emit turn_end. A result with no turn pending (unsolicited) is reported
   * with no userMessageUuid.
   */
  private endTurn(managed: ManagedSession, result: SdkTurnEndResult): void {
    const uuid = managed.pendingResult ? managed.currentUuid : undefined;
    this.config.sdkOptions?.observe({
      type: "turn_end",
      ctx: managed.ctx,
      ...(uuid ? { userMessageUuid: uuid } : {}),
      ...(managed.sdkSessionId ? { sdkSessionId: managed.sdkSessionId } : {}),
      accountId: null,
      result,
    });
    if (managed.pendingResult) managed.currentUuid = undefined;
  }

  /** Hand a result that no turn was waiting for to the registered handler. */
  private deliverUnsolicited(managed: ManagedSession, result: ExecutionResult): void {
    if (managed.aborted) return;
    log.info(
      { sessionKey: managed.sessionKey, isError: result.isError, hasText: result.response.length > 0 },
      "result arrived with no turn pending (unsolicited)",
    );
    if (!this.unsolicitedHandler) return;
    try {
      this.unsolicitedHandler(managed.sessionKey, result);
    } catch (err) {
      log.error({ sessionKey: managed.sessionKey, err }, "unsolicited result handler threw");
    }
  }

  /** Set (or clear) the receiver of results that arrive with no turn pending. */
  setUnsolicitedResultHandler(handler: UnsolicitedResultHandler | null): void {
    this.unsolicitedHandler = handler;
  }

  /**
   * Reset the idle timer for a managed session.
   */
  private resetIdleTimer(managed: ManagedSession): void {
    if (managed.idleTimer) {
      clearTimeout(managed.idleTimer);
    }

    managed.idleTimer = setTimeout(() => {
      // A long turn (e.g. slow tool use) is not idleness. Closing here would
      // reject the in-flight turn with "Session closed"; wait for it instead.
      if (managed.pendingResult) {
        this.resetIdleTimer(managed);
        return;
      }
      if (this.sessions.get(managed.sessionKey) !== managed) return;

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
   * Close every session with no turn in flight that has been idle for longer
   * than `olderThanMs` (default: the idle timeout). Pass 0 to close every
   * session that is not busy, e.g. so the next turn starts with new options.
   * Returns the number of sessions closed.
   */
  closeIdleSessions(olderThanMs: number = this.idleTimeoutMs): number {
    const now = Date.now();
    let closed = 0;
    for (const [key, managed] of [...this.sessions]) {
      if (now - managed.lastActivity >= olderThanMs && !managed.pendingResult) {
        log.info({ sessionKey: key }, "closing idle session");
        this.cleanupSession(key);
        closed++;
      }
    }
    return closed;
  }

  /**
   * Close a session and wait until its subprocess stream has ended, so a
   * caller can safely resume the same SDK session in a new process. After
   * `timeoutMs` the query is force-closed. A turn still in flight is rejected.
   */
  async closeAndWait(sessionKey: string, timeoutMs = 10_000): Promise<void> {
    const managed = this.sessions.get(sessionKey);
    if (!managed) return;

    const consumer = managed.streamConsumer;
    this.cleanupSession(sessionKey);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      consumer.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    if (timedOut) {
      log.warn({ sessionKey, timeoutMs }, "session did not exit in time; force-closing");
      managed.stream.close();
      await consumer;
    }
  }

  /** The live Query of a session with no turn in flight, for control requests. */
  getIdleQuery(sessionKey: string): Query | undefined {
    const managed = this.sessions.get(sessionKey);
    if (!managed || managed.pendingResult || managed.aborted) return undefined;
    return managed.stream;
  }

  /** True while a turn is in flight on this session. */
  isBusy(sessionKey: string): boolean {
    return !!this.sessions.get(sessionKey)?.pendingResult;
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
