/**
 * Hook events that plugins can subscribe to (PLAN C.15).
 *
 * Every payload a plugin receives is a scrubbed, size-capped, deep-frozen copy.
 * Plugins observe. The only exception is `beforeMessage` for a plugin that the
 * owner approved with the `hooks:transform-message` capability: it may return
 * a replacement `text`, and nothing else is taken from its return value.
 * No event lets a plugin block or rewrite a tool call.
 */

export interface BeforeMessageEvent {
  type: "beforeMessage";
  sessionKey: string;
  channel: string;
  senderId: string;
  /** Parsed from the session key when it has the usual `channel:chatType:chatId` shape */
  chatId?: string;
  /** The text the agent is about to see (after earlier transforms) */
  text: string;
  timestamp: number;
}

export interface AfterMessageEvent {
  type: "afterMessage";
  sessionKey: string;
  channel: string;
  senderId: string;
  chatId?: string;
  /** "owner_message" | "other_user" | "schedule" | "loop" | "webhook" | "goal" | ... */
  origin: string;
  /** The text the agent saw, when the host recorded it for this turn */
  inputText?: string;
  responseText: string;
  isError: boolean;
  durationMs: number;
}

export interface BeforeToolUseEvent {
  type: "beforeToolUse";
  toolName: string;
  params: Record<string, unknown>;
  /** The gate chain's verdict. Plugins see it after the fact and cannot change it */
  verdict: "allowed" | "denied" | "asked";
  toolUseId: string;
  /** "chat" | "background" | "goal" | "webhook" | "utility" */
  kind: string;
  sessionKey?: string;
}

export interface AfterToolUseEvent {
  type: "afterToolUse";
  toolName: string;
  params: Record<string, unknown>;
  result: unknown;
  toolUseId: string;
  kind: string;
  sessionKey?: string;
  /** Time since the matching beforeToolUse, when it was seen */
  durationMs?: number;
}

export interface OnErrorEvent {
  type: "onError";
  /** Where the error happened, e.g. "pipeline" */
  source: string;
  sessionKey?: string;
  /** Error name and scrubbed message, never the raw Error object */
  name: string;
  message: string;
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

/** Every event type, in a fixed order. */
export const HOOK_EVENT_TYPES: readonly HookEventType[] = [
  "beforeMessage",
  "afterMessage",
  "beforeToolUse",
  "afterToolUse",
  "onError",
  "onChannelConnect",
  "onChannelDisconnect",
];

export function isHookEventType(value: unknown): value is HookEventType {
  return typeof value === "string" && (HOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Extract the event payload for a given event type. */
export type HookEventPayload<T extends HookEventType> = Extract<HookEvent, { type: T }>;

/** A plugin may return `{ text }` from a transform hook; every other field is ignored. */
export interface MessageTransformResult {
  text: string;
}

/**
 * A hook handler receives a frozen copy of the event. Its return value is
 * ignored, except for a `transform` registration on `beforeMessage`, where a
 * returned `{ text: string }` replaces the text.
 */
export type HookHandler<T extends HookEventType = HookEventType> = (
  event: Readonly<HookEventPayload<T>>,
) => unknown;

/** "observe": not awaited by the caller, return value ignored. "transform": beforeMessage only, awaited under the budget. */
export type HookMode = "observe" | "transform";

export interface HookRegistration<T extends HookEventType = HookEventType> {
  id: string;
  eventType: T;
  handler: HookHandler<T>;
  priority: number;
  mode: HookMode;
  pluginName?: string;
}
