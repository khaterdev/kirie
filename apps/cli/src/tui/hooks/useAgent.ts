import { useState, useCallback, useRef } from "react";
import type { ChatMessage, StreamingState, ConnectionStatus } from "../types.js";
import type { AgentEngine, ExecutionResult, IncomingMessage, SessionStore, ChatHistoryMessage } from "@kirie/core";
import type { SenderIdentity, ChatHistoryStore } from "@kirie/core";

interface UseAgentOptions {
  engine?: AgentEngine;
  sessionId: string;
  /** SessionStore for persisting SDK session IDs (enables cross-channel sync) */
  sessionStore?: SessionStore;
  /** Session key to sync with (e.g., "telegram:dm:12345") */
  sessionKey?: string;
  /** ChatHistoryStore for persistent message history */
  chatHistoryStore?: ChatHistoryStore;
}

interface UseAgentReturn {
  messages: ChatMessage[];
  streaming: StreamingState;
  connectionStatus: ConnectionStatus;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
}

/**
 * Hook that wraps AgentEngine.execute() with state management for the TUI.
 * Manages conversation history, streaming indicator, and connection status.
 *
 * When sessionStore and sessionKey are provided, the hook loads the existing
 * SDK session ID from the store on init and persists updates after each
 * execution. This allows the CLI to share a session with another channel
 * (e.g., Telegram).
 *
 * When no engine is provided (e.g., during development), falls back to a
 * local placeholder response.
 */
export function useAgent({ engine, sessionId, sessionStore, sessionKey, chatHistoryStore }: UseAgentOptions): UseAgentReturn {
  const effectiveSessionKey = sessionKey ?? `cli:dm:${sessionId}`;

  // Load chat history on init
  const initialMessages = (): ChatMessage[] => {
    if (!chatHistoryStore) return [];
    try {
      const history = chatHistoryStore.recent(effectiveSessionKey);
      return history.map((entry, idx) => ({
        id: `history_${idx}`,
        role: entry.role,
        content: entry.content,
        timestamp: new Date(entry.created_at),
      }));
    } catch {
      return [];
    }
  };

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [streaming, setStreaming] = useState<StreamingState>({
    isStreaming: false,
    partialContent: "",
    activeToolCalls: [],
  });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(
    engine ? "connected" : "disconnected",
  );
  const messageIdCounter = useRef(0);
  const agentSessionIdRef = useRef<string | undefined>(
    sessionStore && sessionKey ? (sessionStore.get(sessionKey) ?? undefined) : undefined,
  );
  const abortRef = useRef<AbortController | null>(null);

  const nextId = useCallback(() => {
    messageIdCounter.current += 1;
    return `msg_${messageIdCounter.current}`;
  }, []);

  const sendMessage = useCallback(
    async (content: string) => {
      const userMessage: ChatMessage = {
        id: nextId(),
        role: "user",
        content,
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, userMessage]);
      setStreaming({ isStreaming: true, partialContent: "", activeToolCalls: [] });

      try {
        let responseText: string;

        if (engine) {
          const incomingMessage: IncomingMessage = {
            id: nextId(),
            channel: "cli",
            senderName: "user",
            senderId: "cli-user",
            text: content,
            chatType: "dm",
            chatId: sessionId,
          };

          const sender: SenderIdentity = {
            name: "user",
            platformId: "cli-user",
            role: "owner",
          };

          abortRef.current = new AbortController();

          // Load recent chat history so the agent has conversation context
          let history: ChatHistoryMessage[] | undefined;
          if (chatHistoryStore) {
            try {
              const entries = chatHistoryStore.recent(effectiveSessionKey, 20);
              if (entries.length > 0) {
                history = entries.map((e) => ({
                  role: e.role,
                  content: e.content,
                  senderName: e.sender_name ?? undefined,
                  timestamp: e.created_at,
                }));
              }
            } catch {
              // Non-fatal
            }
          }

          const result: ExecutionResult = await engine.execute(
            incomingMessage,
            sender,
            agentSessionIdRef.current,
            abortRef.current,
            history,
          );

          agentSessionIdRef.current = result.sessionId;

          // Persist SDK session ID to store for cross-channel sync
          if (sessionStore && sessionKey && result.sessionId) {
            sessionStore.set(sessionKey, result.sessionId);
          }

          responseText = result.response;

          // Store messages in chat history
          if (chatHistoryStore && responseText) {
            try {
              chatHistoryStore.append(effectiveSessionKey, "user", content, {
                senderName: "user",
                senderId: "cli-user",
                channel: "cli",
              });
              chatHistoryStore.append(effectiveSessionKey, "assistant", responseText, {
                channel: "cli",
              });
            } catch {
              // Non-fatal — don't break the chat flow
            }
          }

          if (result.isError) {
            setConnectionStatus("error");
            setTimeout(() => setConnectionStatus("connected"), 3000);
          }
        } else {
          // No engine configured - provide a helpful placeholder
          await new Promise((resolve) => setTimeout(resolve, 200));
          responseText =
            "Kirie is running without an AgentEngine. " +
            "Configure your ANTHROPIC_API_KEY and restart to enable AI responses.";
        }

        const assistantMessage: ChatMessage = {
          id: nextId(),
          role: "assistant",
          content: responseText,
          timestamp: new Date(),
        };

        setMessages((prev) => [...prev, assistantMessage]);
        setStreaming({ isStreaming: false, partialContent: "", activeToolCalls: [] });
      } catch (err) {
        setConnectionStatus("error");
        setStreaming({ isStreaming: false, partialContent: "", activeToolCalls: [] });

        const errorContent =
          err instanceof Error ? err.message : "An unknown error occurred.";

        const errorMessage: ChatMessage = {
          id: nextId(),
          role: "assistant",
          content: `Error: ${errorContent}`,
          timestamp: new Date(),
        };

        setMessages((prev) => [...prev, errorMessage]);
        setTimeout(() => setConnectionStatus("connected"), 3000);
      } finally {
        abortRef.current = null;
      }
    },
    [nextId, engine, sessionId, sessionStore, sessionKey, chatHistoryStore, effectiveSessionKey],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    agentSessionIdRef.current = undefined;
  }, []);

  return { messages, streaming, connectionStatus, sendMessage, clearMessages };
}
