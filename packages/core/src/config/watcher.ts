import { watch, type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { loadConfig, DEFAULT_CONFIG_PATH } from "./loader.js";
import type { KirieConfig } from "./schema.js";
import type { CredentialResolver } from "./loader.js";

const DEBOUNCE_MS = 500;

export interface ConfigChangedEvent {
  previous: KirieConfig;
  current: KirieConfig;
}

export interface ChannelConfigChangedEvent {
  channel: string;
  previous: Record<string, unknown>;
  current: Record<string, unknown>;
}

export interface SecurityConfigChangedEvent {
  previous: KirieConfig["security"];
  current: KirieConfig["security"];
}

export interface ConfigWatcherEvents {
  configReloaded: [ConfigChangedEvent];
  channelConfigChanged: [ChannelConfigChangedEvent];
  securityConfigChanged: [SecurityConfigChangedEvent];
  error: [Error];
}

export interface ConfigWatcherOptions {
  configPath?: string;
  credentialResolver?: CredentialResolver;
  debounceMs?: number;
}

/**
 * ConfigWatcher watches the config.yaml file for changes and emits typed
 * events when the configuration is updated. It performs diff-based detection
 * so downstream consumers (e.g., channel adapters) only restart when their
 * specific config section changes.
 */
export class ConfigWatcher extends EventEmitter<ConfigWatcherEvents> {
  private configPath: string;
  private credentialResolver?: CredentialResolver;
  private debounceMs: number;
  private fsWatcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private currentConfig: KirieConfig | null = null;

  constructor(options: ConfigWatcherOptions = {}) {
    super();
    this.configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    this.credentialResolver = options.credentialResolver;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  /**
   * Get the current loaded config. Returns null if config hasn't been loaded yet.
   */
  getConfig(): KirieConfig | null {
    return this.currentConfig;
  }

  /**
   * Load the config file once (without starting the watcher).
   */
  load(): KirieConfig {
    this.currentConfig = loadConfig({
      configPath: this.configPath,
      credentialResolver: this.credentialResolver,
    });
    return this.currentConfig;
  }

  /**
   * Start watching the config file for changes.
   * Performs an initial load.
   */
  start(): KirieConfig {
    const config = this.load();

    this.fsWatcher = watch(this.configPath, {
      persistent: false,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
    });

    this.fsWatcher.on("change", () => {
      this.scheduleReload();
    });

    this.fsWatcher.on("error", (error) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });

    return config;
  }

  /**
   * Stop watching the config file.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.fsWatcher) {
      await this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  /**
   * Force a reload of the config file. Can be triggered programmatically
   * (e.g., from a gateway POST /config/reload endpoint).
   */
  reload(): KirieConfig | null {
    try {
      return this.performReload();
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private scheduleReload(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      try {
        this.performReload();
      } catch (error) {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
      }
    }, this.debounceMs);
  }

  private performReload(): KirieConfig {
    const previous = this.currentConfig;

    const current = loadConfig({
      configPath: this.configPath,
      credentialResolver: this.credentialResolver,
    });

    this.currentConfig = current;

    if (!previous) {
      return current;
    }

    // Emit the top-level config change event
    this.emit("configReloaded", { previous, current });

    // Diff channel configs
    this.diffChannels(previous, current);

    // Diff security config
    if (!deepEqual(previous.security, current.security)) {
      this.emit("securityConfigChanged", {
        previous: previous.security,
        current: current.security,
      });
    }

    return current;
  }

  private diffChannels(previous: KirieConfig, current: KirieConfig): void {
    const channelNames = new Set([
      ...Object.keys(previous.channels),
      ...Object.keys(current.channels),
    ]);

    for (const channel of channelNames) {
      const prev = (previous.channels as Record<string, unknown>)[channel] ?? {};
      const curr = (current.channels as Record<string, unknown>)[channel] ?? {};

      if (!deepEqual(prev, curr)) {
        this.emit("channelConfigChanged", {
          channel,
          previous: prev as Record<string, unknown>,
          current: curr as Record<string, unknown>,
        });
      }
    }
  }
}

/**
 * Simple deep equality check for plain JSON-serializable objects.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (typeof a !== "object") return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  if (Array.isArray(b)) return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;

  return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
}
