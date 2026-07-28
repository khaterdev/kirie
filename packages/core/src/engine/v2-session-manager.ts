import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKSessionOptions,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { SessionStore } from "./session-store.js";
import type { ExecutionResult } from "./agent-engine.js";

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
 * Tracks an active V2 session and its background stream consumer.
 */
interface ManagedSession {
  session: SDKSession;
  sessionKey: string;
  streamConsumer: Promise<void>;
  pendingResult: Deferred<ExecutionResult> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivity: number;
}

/**
 * Configuration for the V2SessionManager.
 */
export interface V2SessionManagerConfig {
  /** Workspace path where CLAUDE.md and .claude/settings.json live */
  workspacePath: string;
  /** Model to use for V2 sessions */
  model: string;
  /** Permission mode for sessions */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[];
  /** Tools to disallow entirely (removed from model context) */
  disallowedTools?: string[];
  /** Idle timeout in ms before closing a session (default 10 minutes) */
  idleTimeoutMs?: number;
  /** Maximum concurrent sessions (default 20) */
  maxSessions?: number;
  /** Optional environment variables to pass to subprocesses */
  env?: Record<string, string | undefined>;
}

/**
 * V2SessionManager manages persistent V2 SDK sessions.
 *
 * Instead of V1's one-shot query() calls that die after each message,
 * V2 sessions persist across multiple messages via send()/stream().
 * A session stays alive and can be reused for follow-up messages
 * without recreating the subprocess.
 *
 * Each V2 subprocess spawns its own stdio MCP server process (configured
 * via .claude/settings.json in the workspace directory) to access Kirie's
 * tools. All MCP server processes share the same SQLite databases.
 */
export class V2SessionManager {
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
   * Execute a user message through a persistent V2 session.
   *
   * Gets or creates a session for the given session key, sends the
   * message, and waits for the result from the background stream consumer.
   *
   * If the result is an error (e.g. from a stale/V1 session ID that can't
   * be resumed), automatically retries with a fresh session.
   */
  async execute(sessionKey: string, userMessage: string): Promise<ExecutionResult> {
    const result = await this.sendAndWait(sessionKey, userMessage);

    // If the result is an error, it may be from a stale session resume.
    // Clear the session and retry once with a fresh session.
    if (result.isError) {
      log.warn(
        { sessionKey, response: result.response.slice(0, 200) },
        "session returned error result, retrying with fresh session",
      );
      this.cleanupSession(sessionKey);
      this.sessionStore.delete(sessionKey);

      const retryResult = await this.sendAndWait(sessionKey, userMessage);
      return retryResult;
    }

    return result;
  }

  /**
   * Send a message and wait for the result. Handles send failures by
   * recreating the session.
   */
  private async sendAndWait(sessionKey: string, userMessage: string): Promise<ExecutionResult> {
    const managed = await this.getOrCreate(sessionKey);
    managed.lastActivity = Date.now();
    this.resetIdleTimer(managed);

    // Create a deferred for this execution
    const deferred = createDeferred<ExecutionResult>();
    managed.pendingResult = deferred;

    try {
      await managed.session.send(userMessage);
    } catch (err) {
      managed.pendingResult = null;
      // Session might be dead — try to recreate
      log.warn({ sessionKey, err }, "send failed, recreating session");
      this.cleanupSession(sessionKey);
      this.sessionStore.delete(sessionKey);

      const fresh = await this.createNewSession(sessionKey);
      const freshDeferred = createDeferred<ExecutionResult>();
      fresh.pendingResult = freshDeferred;

      try {
        await fresh.session.send(userMessage);
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
  private async getOrCreate(sessionKey: string): Promise<ManagedSession> {
    // Check in-memory map
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    // Check session store for a saved session ID to resume
    const savedSessionId = this.sessionStore.get(sessionKey);
    if (savedSessionId) {
      try {
        const managed = this.resumeSession(sessionKey, savedSessionId);
        return managed;
      } catch (err) {
        log.warn({ sessionKey, savedSessionId, err }, "failed to resume session, creating new");
      }
    }

    // Evict oldest idle session if at capacity
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestSession();
    }

    return this.createNewSession(sessionKey);
  }

  /**
   * Create a brand new V2 session.
   */
  private createNewSession(sessionKey: string): ManagedSession {
    const options = this.createSessionOptions();

    log.info({ sessionKey }, "creating new V2 session");
    const session = unstable_v2_createSession(options);

    const managed: ManagedSession = {
      session,
      sessionKey,
      streamConsumer: Promise.resolve(),
      pendingResult: null,
      idleTimer: null,
      lastActivity: Date.now(),
    };

    // Start the background stream consumer
    managed.streamConsumer = this.startStreamConsumer(managed);

    this.sessions.set(sessionKey, managed);
    return managed;
  }

  /**
   * Resume an existing V2 session by SDK session ID.
   */
  private resumeSession(sessionKey: string, sdkSessionId: string): ManagedSession {
    const options = this.createSessionOptions();

    log.info({ sessionKey, sdkSessionId }, "resuming V2 session");
    const session = unstable_v2_resumeSession(sdkSessionId, options);

    const managed: ManagedSession = {
      session,
      sessionKey,
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
   * Build SDKSessionOptions for V2 sessions.
   *
   * Note: V2 does NOT support mcpServers or systemPrompt directly.
   * MCP servers are discovered from .claude/settings.json in the workspace.
   * System prompt is read from CLAUDE.md in the workspace.
   */
  private createSessionOptions(): SDKSessionOptions {
    const permMode = this.config.permissionMode ?? "bypassPermissions";

    const options: SDKSessionOptions = {
      model: this.config.model,
      permissionMode: permMode,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
    };

    // V2 SDKSessionOptions doesn't declare some fields used by the underlying
    // ProcessTransport. We cast to add them since ProcessTransport destructures
    // them from the options object regardless of the TypeScript type.
    const extOptions = options as SDKSessionOptions & {
      allowDangerouslySkipPermissions?: boolean;
      cwd?: string;
    };

    if (permMode === "bypassPermissions") {
      extOptions.allowDangerouslySkipPermissions = true;
    }

    // Set the subprocess working directory to the workspace so Claude Code
    // discovers .claude/settings.json and CLAUDE.md from there.
    if (this.config.workspacePath) {
      extOptions.cwd = this.config.workspacePath;
    }

    // Pass environment variables to the subprocess
    if (this.config.env) {
      options.env = {
        ...process.env,
        ...this.config.env,
      };
    }

    return options;
  }

  /**
   * Background stream consumer that reads messages from the V2 session.
   * Runs for the lifetime of the session, resolving pending deferreds
   * when result messages arrive.
   */
  private async startStreamConsumer(managed: ManagedSession): Promise<void> {
    const textParts: string[] = [];

    try {
      for await (const msg of managed.session.stream()) {
        switch (msg.type) {
          case "assistant": {
            // Collect text from assistant message content blocks
            for (const block of msg.message.content) {
              if ("type" in block && block.type === "text" && "text" in block) {
                textParts.push(block.text as string);
              }
            }

            // Persist session ID
            try {
              const sessionId = managed.session.sessionId;
              if (sessionId) {
                this.sessionStore.set(managed.sessionKey, sessionId);
              }
            } catch {
              // sessionId might not be available yet
            }
            break;
          }

          case "result": {
            const resultMsg = msg as SDKResultMessage;
            let response: string;
            let costUsd = 0;
            let numTurns = 0;
            let isError = false;
            let sessionId = "";

            if (resultMsg.subtype === "success") {
              response = resultMsg.result;
              costUsd = resultMsg.total_cost_usd;
              numTurns = resultMsg.num_turns;
              isError = resultMsg.is_error;
              sessionId = resultMsg.session_id;
            } else {
              // Error result
              const errResult = resultMsg as { errors: string[]; total_cost_usd: number; num_turns: number; is_error: boolean; session_id: string };
              response = errResult.errors.length > 0
                ? errResult.errors.join("\n")
                : textParts.join("");
              costUsd = errResult.total_cost_usd;
              numTurns = errResult.num_turns;
              isError = errResult.is_error;
              sessionId = errResult.session_id;
            }

            // Persist session ID
            if (sessionId) {
              this.sessionStore.set(managed.sessionKey, sessionId);
            }

            // Resolve the pending deferred
            if (managed.pendingResult) {
              managed.pendingResult.resolve({
                response,
                sessionId,
                costUsd,
                numTurns,
                isError,
              });
              managed.pendingResult = null;
            }

            // Clear collected text for next message
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

      // Reject any pending deferred
      if (managed.pendingResult) {
        managed.pendingResult.reject(err);
        managed.pendingResult = null;
      }
    } finally {
      // Stream ended — session is dead
      log.info({ sessionKey: managed.sessionKey }, "stream consumer ended");

      // If there's still a pending deferred, the stream ended without a result.
      // This happens when the subprocess exits unexpectedly (e.g. startup failure,
      // permission issues, missing executable). Reject so the caller doesn't hang.
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

    try {
      managed.session.close();
    } catch (err) {
      log.debug({ sessionKey, err }, "error closing session (may already be closed)");
    }

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
