/**
 * Plugin contract (PLAN C.15).
 *
 * TRUST: a plugin is JavaScript loaded into the daemon with import(). It runs
 * with the daemon's full privileges. See PLUGIN_TRUST_STATEMENT.
 */

import type { HookEventType, HookHandler } from "../hooks/types.js";

/** The statement shown in the docs, in the /plugins enable confirmation and here. */
export const PLUGIN_TRUST_STATEMENT =
  "A plugin is JavaScript loaded into the Kirie daemon with import(). It runs with the daemon's full " +
  "privileges: the decrypted bot tokens and credentials in memory, every database, and the filesystem " +
  "and network as your user. The capability list limits what Kirie passes to and accepts from the " +
  "plugin; it does not confine the plugin's code. Timeouts cannot stop a synchronous infinite loop. " +
  "The hash pin makes later changes visible (tamper-evident), but it is not tamper-proof: the agent " +
  "runs shell commands as the same user. Only enable a plugin whose source you have read.";

/** kirie-tools env key, set by the plugins feature when `plugins.dir` is not `<dataDir>/plugins`. */
export const KIRIE_PLUGINS_DIR_ENV = "KIRIE_PLUGINS_DIR";

/** `name` must match this and equal the directory name, the manifest name and the factory's name. */
export const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isValidPluginName(name: unknown): name is string {
  return typeof name === "string" && PLUGIN_NAME_RE.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

/**
 * - `hooks:observe` (always granted): receive frozen, scrubbed copies of events; return values ignored.
 * - `hooks:transform-message`: `beforeMessage` hooks may return `{ text }` to replace the text the agent sees.
 * Tool interception is not a plugin capability: blocking and rewriting tool calls belong to the gate chain.
 */
export type PluginCapability = "hooks:observe" | "hooks:transform-message";

export const PLUGIN_CAPABILITIES: readonly PluginCapability[] = ["hooks:observe", "hooks:transform-message"];

/** The `kirie` block of a plugin's package.json, validated. */
export interface PluginManifest {
  name: string;
  version: string;
  /** Entry file, relative to the plugin directory. Default "index.js" */
  entry: string;
  /** The only events the plugin may register hooks for */
  events: HookEventType[];
  /** Always includes "hooks:observe" */
  capabilities: PluginCapability[];
  description?: string;
}

/** A plugin's hook declaration binds a handler to an event type. */
export interface PluginHookBinding<T extends HookEventType = HookEventType> {
  event: T;
  handler: HookHandler<T>;
  priority?: number;
  /** "transform" needs the `hooks:transform-message` capability and is valid for beforeMessage only */
  mode?: "observe" | "transform";
}

/**
 * Not supported. A definition that carries `mcpTools` or `channelAdapters`
 * still loads, but those fields are ignored with a warning.
 */
export interface UnsupportedPluginExtensions {
  /** @deprecated Ignored: plugins cannot add MCP tools. */
  mcpTools?: unknown;
  /** @deprecated Ignored: plugins cannot add channel adapters. */
  channelAdapters?: unknown;
}

/** The value a plugin's default-export factory returns. */
export interface PluginDefinition extends UnsupportedPluginExtensions {
  /** Must equal the directory name and the manifest name */
  name: string;
  /** Must equal the manifest version */
  version: string;
  /** Hooks to register, only for events declared in the manifest */
  hooks?: PluginHookBinding[];
  /** Called once under the load timeout, before any hook is registered */
  setup?: (config: Record<string, unknown>) => void | Promise<void>;
  /** Called on unload under a timeout; a hanging teardown is abandoned */
  teardown?: () => void | Promise<void>;
}

/** The default export of a plugin's entry file. Receives `plugins.config.<name>` from config.yaml. */
export type PluginFactory = (
  config: Record<string, unknown>,
) => PluginDefinition | Promise<PluginDefinition>;
