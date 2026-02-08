// @kirie/plugin-sdk - Public API for extension authors

// Channel adapter types
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelContext,
  ChannelStatus,
  ChannelState,
  SendTextParams,
  SendTypingParams,
  SendMediaParams,
  SendReactionParams,
  EditMessageParams,
  SentMessage,
} from "@kirie/core";

// Message types
export type { UnifiedMessage, UnifiedMedia } from "@kirie/core";

// Hook types
export type {
  HookEvent,
  HookEventType,
  HookEventPayload,
  HookHandler,
  HookRegistration,
  BeforeMessageEvent,
  AfterMessageEvent,
  BeforeToolUseEvent,
  AfterToolUseEvent,
  OnErrorEvent,
  OnChannelConnectEvent,
  OnChannelDisconnectEvent,
} from "@kirie/core";

// Plugin types
export type {
  PluginDefinition,
  PluginFactory,
  PluginHookBinding,
  PluginMcpTool,
  ChannelAdapterFactory,
} from "@kirie/core";
