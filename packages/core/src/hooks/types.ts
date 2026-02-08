/**
 * Hook event types that plugins can subscribe to in the Kirie lifecycle.
 */

export interface BeforeMessageEvent {
  type: "beforeMessage";
  channel: string;
  senderId: string;
  senderName: string;
  chatId: string;
  text: string;
  timestamp: number;
}

export interface AfterMessageEvent {
  type: "afterMessage";
  channel: string;
  senderId: string;
  chatId: string;
  inputText: string;
  responseText: string;
  durationMs: number;
}

export interface BeforeToolUseEvent {
  type: "beforeToolUse";
  toolName: string;
  params: Record<string, unknown>;
}

export interface AfterToolUseEvent {
  type: "afterToolUse";
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}

export interface OnErrorEvent {
  type: "onError";
  source: string;
  error: Error;
  context?: Record<string, unknown>;
}

export interface OnChannelConnectEvent {
  type: "onChannelConnect";
  channel: string;
}

export interface OnChannelDisconnectEvent {
  type: "onChannelDisconnect";
  channel: string;
  reason?: string;
}

export type HookEvent =
  | BeforeMessageEvent
  | AfterMessageEvent
  | BeforeToolUseEvent
  | AfterToolUseEvent
  | OnErrorEvent
  | OnChannelConnectEvent
  | OnChannelDisconnectEvent;

export type HookEventType = HookEvent["type"];

/**
 * Extract the event payload for a given event type.
 */
export type HookEventPayload<T extends HookEventType> = Extract<HookEvent, { type: T }>;

/**
 * A hook handler receives a typed event and may return void or a promise.
 * Handlers may optionally return a modified event for "before*" hooks (pipeline pattern).
 */
export type HookHandler<T extends HookEventType = HookEventType> = (
  event: HookEventPayload<T>,
) => void | Promise<void> | HookEventPayload<T> | Promise<HookEventPayload<T>>;

export interface HookRegistration<T extends HookEventType = HookEventType> {
  id: string;
  eventType: T;
  handler: HookHandler<T>;
  priority: number;
  pluginName?: string;
}
