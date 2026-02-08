import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { PluginDefinition, PluginFactory } from "./types.js";
import type { HookRegistry } from "../hooks/registry.js";

const PLUGINS_DIR = join(homedir(), ".kirie", "plugins");

export interface LoadedPlugin {
  definition: PluginDefinition;
  config: Record<string, unknown>;
}

export interface PluginLoaderOptions {
  pluginsDir?: string;
  hookRegistry?: HookRegistry;
}

/**
 * Discover and load plugins from the plugins directory and from config entries.
 *
 * Plugins can be:
 * 1. npm packages specified in config.yaml `plugins[].package`
 * 2. Local directories under ~/.kirie/plugins/ with a package.json
 *
 * Each plugin module must default-export a PluginFactory function.
 */
export class PluginLoader {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private pluginsDir: string;
  private hookRegistry?: HookRegistry;

  constructor(options: PluginLoaderOptions = {}) {
    this.pluginsDir = options.pluginsDir ?? PLUGINS_DIR;
    this.hookRegistry = options.hookRegistry;
  }

  /**
   * Load a plugin from an npm package name or absolute path.
   * The module must default-export a PluginFactory.
   */
  async loadPlugin(
    packageName: string,
    config: Record<string, unknown> = {},
  ): Promise<PluginDefinition> {
    if (this.plugins.has(packageName)) {
      return this.plugins.get(packageName)!.definition;
    }

    let modulePath: string;

    // Check if it's a local plugin directory
    const localPath = join(this.pluginsDir, packageName);
    if (existsSync(localPath)) {
      const entryPoint = join(localPath, "index.js");
      if (!existsSync(entryPoint)) {
        throw new Error(`Local plugin ${packageName} missing index.js at ${localPath}`);
      }
      modulePath = pathToFileURL(entryPoint).href;
    } else {
      // Assume it's an npm package resolvable from the plugins dir or node_modules
      modulePath = packageName;
    }

    const mod = (await import(modulePath)) as { default?: PluginFactory };
    const factory = mod.default;

    if (typeof factory !== "function") {
      throw new Error(
        `Plugin ${packageName} must default-export a function, got ${typeof factory}`,
      );
    }

    const definition = await factory(config);

    if (!definition.name || !definition.version) {
      throw new Error(`Plugin ${packageName} must provide name and version`);
    }

    // Register hooks if a HookRegistry is available
    if (this.hookRegistry && definition.hooks) {
      for (const binding of definition.hooks) {
        this.hookRegistry.register(binding.event, binding.handler, {
          priority: binding.priority,
          pluginName: definition.name,
        });
      }
    }

    // Run setup if provided
    if (definition.setup) {
      await definition.setup(config);
    }

    const loaded: LoadedPlugin = { definition, config };
    this.plugins.set(definition.name, loaded);

    return definition;
  }

  /**
   * Discover and load all plugins from the plugins directory.
   * Only loads directories that have a package.json.
   */
  async discoverPlugins(): Promise<PluginDefinition[]> {
    if (!existsSync(this.pluginsDir)) {
      return [];
    }

    const entries = readdirSync(this.pluginsDir, { withFileTypes: true });
    const definitions: PluginDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = join(this.pluginsDir, entry.name);
      const packageJsonPath = join(pluginPath, "package.json");

      if (!existsSync(packageJsonPath)) continue;

      try {
        const def = await this.loadPlugin(entry.name);
        definitions.push(def);
      } catch (error) {
        console.error(`[PluginLoader] Failed to load plugin ${entry.name}:`, error);
      }
    }

    return definitions;
  }

  /**
   * Load all plugins listed in the config.yaml plugins array.
   */
  async loadConfigPlugins(
    plugins: Array<{ package: string; enabled: boolean; config: Record<string, unknown> }>,
  ): Promise<PluginDefinition[]> {
    const definitions: PluginDefinition[] = [];

    for (const entry of plugins) {
      if (!entry.enabled) continue;

      try {
        const def = await this.loadPlugin(entry.package, entry.config);
        definitions.push(def);
      } catch (error) {
        console.error(`[PluginLoader] Failed to load plugin ${entry.package}:`, error);
      }
    }

    return definitions;
  }

  /**
   * Unload a plugin by name, running its teardown hook.
   */
  async unloadPlugin(name: string): Promise<boolean> {
    const loaded = this.plugins.get(name);
    if (!loaded) return false;

    if (this.hookRegistry) {
      this.hookRegistry.unregisterPlugin(name);
    }

    if (loaded.definition.teardown) {
      await loaded.definition.teardown();
    }

    this.plugins.delete(name);
    return true;
  }

  /**
   * Unload all plugins gracefully.
   */
  async unloadAll(): Promise<void> {
    const names = [...this.plugins.keys()];
    for (const name of names) {
      await this.unloadPlugin(name);
    }
  }

  /**
   * Get a loaded plugin by name.
   */
  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all loaded plugins.
   */
  getAllPlugins(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }
}
