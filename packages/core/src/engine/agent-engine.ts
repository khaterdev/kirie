import {
  query,
  type Query,
  type Options,
  type SDKMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import {
  buildPrompt,
  type ChannelContext,
  type SenderIdentity,
  type PromptConfig,
} from "./prompt-builder.js";
import { makeSessionKey } from "../routing/session-key.js";
import type { MediaType } from "../channels/normalizer.js";
import type { ResolvedMedia } from "../channels/adapter.js";

const log = pino({ name: "agent-engine" });

/**
 * Minimal shape of a unified incoming message.
 * Defined here to avoid circular dependencies with the channels package.
 * The full UnifiedMessage type from channels/adapter.ts extends this.
 */
export interface IncomingMessage {
  /** Unique message ID */
  id: string;
  /** Channel identifier */
  channel: string;
  /** Sender's display name */
  senderName: string;
  /** Sender's platform-specific ID */
  senderId: string;
  /** Message text content */
  text: string;
  /** Chat type */
  chatType: "dm" | "group" | "thread";
  /** Chat/conversation ID */
  chatId: string;
  /** Optional thread ID */
  threadId?: string;
  /** Optional ID of message being replied to */
  replyToId?: string;
  /** Whether this message is an edit of a previously sent message */
  isEdited?: boolean;
  /** Reaction event data (user added/removed an emoji on a message) */
  reaction?: {
    /** The emoji that was added or removed */
    emoji: string;
    /** Platform message ID of the message being reacted to */
    messageId: string;
    /** Whether the reaction was added or removed */
    action: "add" | "remove";
    /** Whether the reacted-to message was sent by the bot */
    isTargetFromBot?: boolean;
    /** Text content of the reacted-to message (if available) */
    targetContent?: string;
  };
  /** Rich reply context (text/sender info from the replied-to message) */
  replyTo?: {
    readonly messageId: string;
    readonly text?: string;
    readonly senderId?: string;
    readonly senderName?: string;
  };
  /** Resolved media attachments with local file paths */
  media?: ResolvedMedia[];
}

/**
 * A recent chat message to inject into the prompt for conversation context.
 */
export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  senderName?: string;
  timestamp?: string;
}

/**
 * Result returned from an AgentEngine.execute() call.
 */
export interface ExecutionResult {
  /** The agent's text response */
  response: string;
  /** Session ID for conversation continuity */
  sessionId: string;
  /** Total cost of the query in USD */
  costUsd: number;
  /** Number of turns used */
  numTurns: number;
  /** Whether the result was an error */
  isError: boolean;
  /** Whether the execution was aborted mid-stream (partial response) */
  wasAborted?: boolean;
}

/**
 * Configuration for the AgentEngine.
 */
export interface AgentEngineConfig {
  /** Prompt configuration (system prompt, max turns, model) */
  prompt: PromptConfig;
  /** MCP server configurations to attach to every query */
  mcpServers?: Record<string, McpServerConfig>;
  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[];
  /** Working directory for the agent session */
  cwd?: string;
}

/**
 * Converts a UTC timestamp string from the chat history DB
 * (SQLite `datetime('now')` → "YYYY-MM-DD HH:MM:SS", always UTC)
 * into the same wall-clock format rendered in the given IANA timezone.
 *
 * Returns the input unchanged when no timezone is configured or the
 * value can't be parsed, so callers never lose data on bad input.
 */
export function localizeUtcTimestamp(utc: string, timezone?: string): string {
  if (!timezone) return utc;
  const date = new Date(`${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return utc;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return utc;
  }
}

/**
 * AgentEngine wraps the Claude Agent SDK, providing a high-level
 * interface for executing messages through the AI agent.
 *
 * Uses V1 query() calls with the `resume` option for session continuity.
 * V1 supports mcpServers, systemPrompt, cwd, settingSources, and
 * bypassPermissions — all required for MCP tool discovery.
 *
 * It handles:
 * - Building the system prompt with channel/sender context
 * - Managing session continuity via session IDs
 * - Iterating the async message stream to extract the final response
 * - Configuring MCP servers, allowed tools, and permission modes
 */
export class AgentEngine {
  private readonly config: AgentEngineConfig;

  constructor(config: AgentEngineConfig) {
    this.config = config;
  }

  /**
   * Set or update the MCP servers for this engine.
   * Call this after creating MCP tool servers to make them available to the agent.
   */
  setMcpServers(servers: Record<string, McpServerConfig>): void {
    this.config.mcpServers = {
      ...this.config.mcpServers,
      ...servers,
    };
  }

  /**
   * Execute a user message through the Claude agent.
   *
   * Uses V1 query() with mcpServers passed directly and bypassPermissions
   * for full tool access. Sessions are continued via the `resume` option.
   *
   * @param message - The incoming unified message from a channel
   * @param sender - Resolved identity of the sender (from auth system)
   * @param sessionId - Optional session ID to resume a prior conversation
   * @param abortController - Optional AbortController to cancel the query
   * @param chatHistory - Recent conversation history to inject into the prompt
   * @returns The execution result with response text and session ID
   */
  async execute(
    message: IncomingMessage,
    sender: SenderIdentity,
    sessionId?: string,
    onQuery?: (q: Query) => void,
    chatHistory?: ChatHistoryMessage[],
  ): Promise<ExecutionResult> {
    const channel: ChannelContext = {
      channel: message.channel,
      chatType: message.chatType,
      chatId: message.chatId,
      threadId: message.threadId,
    };

    const builtPrompt = buildPrompt({
      config: this.config.prompt,
      channel,
      sender,
    });

    const sessionKey = makeSessionKey({ channel: message.channel, chatType: message.chatType, chatId: message.chatId });

    const options: Options = {
      systemPrompt: builtPrompt.systemPrompt,
      // Use bypassPermissions so agents can use all tools without prompts.
      // V1 query() supports this mode fully (unlike V2 which hardcodes it off).
      permissionMode: "bypassPermissions",
      maxTurns: builtPrompt.maxTurns,
      model: builtPrompt.model,
      allowedTools: this.config.allowedTools,
      mcpServers: this.config.mcpServers,
      cwd: this.config.cwd,
      // Load skills from both user (~/.claude/skills/) and project ({cwd}/.claude/skills/) directories.
      // Without this, the SDK does NOT discover any filesystem-based skills.
      settingSources: ["user", "project"],
    };

    const userPrompt = this.wrapUserMessage(message, chatHistory, sessionKey);

    // Attempt to resume an existing session. If the session is stale or from
    // a different process (e.g., CLI resuming a daemon session), the SDK will
    // fail. In that case, retry without resume to start a fresh session.
    if (sessionId) {
      options.resume = sessionId;
      try {
        const stream = query({ prompt: userPrompt, options });
        onQuery?.(stream);
        const result = await this.consumeStream(stream);
        if (!result.isError) {
          return result;
        }
        log.warn(
          { sessionId, response: result.response.slice(0, 200) },
          "session returned error result, retrying with fresh session",
        );
      } catch (err) {
        log.error({ sessionId, err }, "session resume failed, starting fresh session");
      }
      delete options.resume;
    }

    // Fresh session attempt with retry. If the first attempt fails (e.g. transient
    // SDK spawn issue, network blip), wait briefly and retry once more before giving up.
    const MAX_FRESH_RETRIES = 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_FRESH_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delayMs = attempt * 2000; // 2s, 4s
          log.info({ attempt, delayMs }, "retrying fresh session after delay");
          await new Promise((r) => setTimeout(r, delayMs));
        }
        const stream = query({ prompt: userPrompt, options });
        onQuery?.(stream);
        return await this.consumeStream(stream);
      } catch (err) {
        lastErr = err;
        log.error({ attempt, err }, "fresh session attempt failed");
      }
    }
    throw lastErr;
  }

  /**
   * Wraps the raw user message text with XML context tags for the InputGuard.
   * Prepends recent chat history when available so the agent has conversation
   * context even when starting a fresh SDK session.
   *
   * @param sessionKey - Optional session key to include in the message context.
   *   When provided, the agent can use it for background tasks, chat history, etc.
   */
  private wrapUserMessage(message: IncomingMessage, chatHistory?: ChatHistoryMessage[], sessionKey?: string): string {
    const parts: string[] = [];

    // Inject recent chat history so the agent knows what was discussed before
    if (chatHistory && chatHistory.length > 0) {
      const tz = this.config.prompt?.timezone;
      const historyKey = sessionKey ?? `${message.channel}:${message.chatType}:${message.chatId}`;
      parts.push(`<conversation_history session_key="${historyKey}">`);
      parts.push(
        `Recent messages from this conversation (oldest first). Timestamps are local time in ${tz || "UTC"}:`,
      );
      for (const entry of chatHistory) {
        const ts = entry.timestamp ? `[${localizeUtcTimestamp(entry.timestamp, tz)}] ` : "";
        if (entry.role === "user") {
          const name = entry.senderName ?? "user";
          parts.push(`${ts}${name}: ${entry.content}`);
        } else {
          parts.push(`${ts}assistant: ${entry.content}`);
        }
      }
      parts.push("</conversation_history>");
      parts.push("");
    }

    // Include session context so the agent knows its session key for background tasks, etc.
    const effectiveSessionKey = sessionKey ?? `${message.channel}:${message.chatType}:${message.chatId}`;
    parts.push(`<session_context session_key="${effectiveSessionKey}" channel="${message.channel}" chat_type="${message.chatType}" chat_id="${message.chatId}" />`);

    const editAttr = message.isEdited ? ' edited="true"' : "";
    parts.push(
      `<user_message channel="${message.channel}" sender="${message.senderName}" sender_id="${message.senderId}" message_id="${message.id}"${editAttr}>`,
    );

    if (message.isEdited) {
      parts.push("[This message was EDITED by the user. They changed what they originally wrote. Treat this as a correction/update to their previous message and respond to the updated content.]");
      parts.push("");
    }

    parts.push(message.text);

    // Include media attachment info so the agent knows about attached files
    if (message.media && message.media.length > 0) {
      parts.push("");
      for (const m of message.media) {
        const label = mediaTypeLabel(m.type);
        if (m.type === "voice" || m.type === "audio") {
          const transcriptNote = m.transcript
            ? `\n[Transcription: "${m.transcript}"]`
            : "\n(Audio file — transcription not available)";
          parts.push(`[📎 ${label} attached: ${m.localPath}]${transcriptNote}`);
        } else if (m.type === "document" && m.filename) {
          parts.push(`[📎 ${label} attached: ${m.localPath} (${m.filename})]`);
        } else if (m.caption) {
          parts.push(`[📎 ${label} attached: ${m.localPath} — "${m.caption}"]`);
        } else {
          parts.push(`[📎 ${label} attached: ${m.localPath}]`);
        }
      }
      parts.push("(Use the Read tool to view attached images)");
    }

    // Include reaction event context
    if (message.reaction) {
      parts.push("");
      const actionVerb = message.reaction.action === "add" ? "reacted with" : "removed reaction";
      const target = message.reaction.isTargetFromBot ? "YOUR (the assistant's) message" : "a message";
      parts.push(`[${message.senderName} ${actionVerb} ${message.reaction.emoji} on ${target} (message_id: ${message.reaction.messageId})]`);
      if (message.reaction.targetContent) {
        const truncated = message.reaction.targetContent.length > 300
          ? message.reaction.targetContent.slice(0, 300) + "..."
          : message.reaction.targetContent;
        parts.push(`[Reacted-to message content: "${truncated}"]`);
      }
      if (message.reaction.isTargetFromBot) {
        parts.push("[The user reacted to something YOU said. Consider whether this warrants a response — e.g. they might be acknowledging, agreeing, disagreeing, or requesting follow-up based on the emoji used.]");
      }
    }

    parts.push(`</user_message>`);

    if (message.replyTo) {
      const replyParts: string[] = [];
      if (message.replyTo.senderName) {
        replyParts.push(`Replying to ${message.replyTo.senderName}`);
      } else if (message.replyTo.senderId) {
        replyParts.push(`Replying to user ${message.replyTo.senderId}`);
      } else {
        replyParts.push(`Replying to message ${message.replyTo.messageId}`);
      }

      if (message.replyTo.text) {
        const truncated = message.replyTo.text.length > 200
          ? message.replyTo.text.slice(0, 200) + "..."
          : message.replyTo.text;
        replyParts.push(`"${truncated}"`);
      }

      parts.push(`\n[${replyParts.join(": ")}]`);
    } else if (message.replyToId) {
      parts.push(`\n[Replying to message: ${message.replyToId}]`);
    }

    return parts.join("\n");
  }

  /**
   * Consumes the SDK message stream, collecting assistant text and
   * extracting the final result metadata.
   *
   * If the stream is closed (via query.close()) or aborted, returns
   * partial results with wasAborted=true instead of throwing.
   */
  private async consumeStream(
    stream: AsyncGenerator<SDKMessage, void>,
  ): Promise<ExecutionResult> {
    let resultSessionId = "";
    let costUsd = 0;
    let numTurns = 0;
    let isError = false;
    let resultText = "";
    const textParts: string[] = [];
    let wasAborted = false;
    let gotResult = false;

    try {
      for await (const msg of stream) {
        switch (msg.type) {
          case "assistant": {
            // Extract text from the assistant message content blocks
            for (const block of msg.message.content) {
              if (block.type === "text") {
                textParts.push(block.text);
              }
            }
            resultSessionId = msg.session_id;
            break;
          }

          case "result": {
            gotResult = true;
            resultSessionId = msg.session_id;
            costUsd = msg.total_cost_usd;
            numTurns = msg.num_turns;
            isError = msg.is_error;

            if (msg.subtype === "success") {
              resultText = msg.result;
            } else {
              // For error results, join any collected text or use error details
              resultText =
                "errors" in msg && msg.errors.length > 0
                  ? msg.errors.join("\n")
                  : textParts.join("");
            }
            break;
          }

          // system, user, stream_event, tool_progress, auth_status messages
          // are consumed but not acted upon here
          default:
            if ("session_id" in msg && msg.session_id) {
              resultSessionId = msg.session_id;
            }
            break;
        }
      }
    } catch (err) {
      // Check if this was an abort/close — return partial results instead of throwing
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.includes("abort") || err.message.includes("close"));
      if (isAbort) {
        wasAborted = true;
        log.info({ sessionId: resultSessionId, partialTextLength: textParts.join("").length }, "stream aborted, returning partial result");
      } else {
        throw err;
      }
    }

    // If the stream ended without a result message (e.g. query.close() was called),
    // treat it as an abort with whatever text was collected so far.
    if (!gotResult && !wasAborted) {
      wasAborted = true;
      log.info({ sessionId: resultSessionId, partialTextLength: textParts.join("").length }, "stream ended without result (likely closed), treating as abort");
    }

    // If no explicit result message was received, use collected text parts
    if (!resultText && textParts.length > 0) {
      resultText = textParts.join("");
    }

    return {
      response: resultText,
      sessionId: resultSessionId,
      costUsd,
      numTurns,
      isError,
      wasAborted,
    };
  }
}

function mediaTypeLabel(type: MediaType): string {
  switch (type) {
    case "photo": return "Image";
    case "video": return "Video";
    case "audio": return "Audio";
    case "voice": return "Voice message";
    case "document": return "Document";
    case "sticker": return "Sticker";
    case "animation": return "Animation";
    default: return "File";
  }
}
