import type { ChannelAdapter } from "../channels/adapter.js";
import type { HookEventType, HookHandler } from "../hooks/types.js";

/**
 * A plugin's hook declaration binds a handler to an event type.
 */
export interface PluginHookBinding<T extends HookEventType = HookEventType> {
  event: T;
  handler: HookHandler<T>;
  priority?: number;
}

/**
 * An MCP tool provided by a plugin.
 */
export interface PluginMcpTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
  };
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

/**
 * A factory function that creates a channel adapter given its plugin-specific config.
 */
export type ChannelAdapterFactory = (
  config: Record<string, unknown>,
) => ChannelAdapter;

/**
 * The contract every Kirie plugin must satisfy.
 * Plugins are loaded from ~/.kirie/plugins/ and can extend Kirie in three ways:
 * - Register lifecycle hooks
 * - Provide MCP tools
 * - Provide channel adapters
 */
export interface PluginDefinition {
  /** Unique plugin name (npm package name or short identifier) */
  name: string;

  /** Semver version */
  version: string;

  /** Lifecycle hooks to register */
  hooks?: PluginHookBinding[];

  /** MCP tools to register */
  mcpTools?: PluginMcpTool[];

  /** Channel adapter factories keyed by channel name */
  channelAdapters?: Record<string, ChannelAdapterFactory>;

  /**
   * Optional setup hook called when the plugin is loaded.
   * Receives the plugin's configuration from the main config.yaml.
   */
  setup?: (config: Record<string, unknown>) => void | Promise<void>;

  /**
   * Optional teardown hook called during shutdown.
   */
  teardown?: () => void | Promise<void>;
}

/**
 * The default export signature expected from a plugin package.
 * A plugin module should export a function that returns a PluginDefinition.
 */
export type PluginFactory = (
  config: Record<string, unknown>,
) => PluginDefinition | Promise<PluginDefinition>;
