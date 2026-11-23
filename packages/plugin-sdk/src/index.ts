// @kirie/plugin-sdk - Public API for extension authors (types only, no runtime code).
//
// A Kirie plugin is a directory under ~/.kirie/plugins/<name>/ with a package.json
// (name, version, "kirie": { entry, events, capabilities }) and an ES module whose
// default export is a PluginFactory. Plugins are hooks only. See docs/plugins.md.
//
// TRUST: a plugin runs inside the Kirie daemon with its full privileges. The
// capability list limits what Kirie passes to and accepts from it; it does not
// confine the plugin's code.

// Hook types
export type {
  HookEvent,
  HookEventType,
  HookEventPayload,
  HookHandler,
  HookMode,
  MessageTransformResult,
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
  PluginCapability,
  PluginManifest,
} from "@kirie/core";

// Message types (for reference; plugins receive plain copies, not these objects)
export type { UnifiedMessage, UnifiedMedia } from "@kirie/core";
