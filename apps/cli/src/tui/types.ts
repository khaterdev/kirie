/** Shared types for the Kirie TUI */

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  input?: string;
  output?: string;
}

export interface StreamingState {
  isStreaming: boolean;
  partialContent: string;
  activeToolCalls: ToolCall[];
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface SessionInfo {
  sessionId: string;
  channel: string;
  startedAt: Date;
  messageCount: number;
}
