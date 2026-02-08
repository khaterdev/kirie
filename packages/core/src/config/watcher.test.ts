import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { ConfigWatcher } from "./watcher.js";
import type { ConfigChangedEvent, ChannelConfigChangedEvent, SecurityConfigChangedEvent } from "./watcher.js";

const TEST_DIR = `/tmp/kirie-watcher-test-${process.pid}`;
const TEST_CONFIG_PATH = join(TEST_DIR, "config.yaml");

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(TEST_CONFIG_PATH, stringifyYaml(data), "utf-8");
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ConfigWatcher", () => {
  describe("load", () => {
    it("loads config from disk and stores it", () => {
      writeConfig({
        agent: { maxTurns: 5, model: "claude-opus-4-6" },
      });

      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      const config = watcher.load();

      expect(config.agent.maxTurns).toBe(5);
      expect(config.agent.maxTurns).toBe(5);
      expect(watcher.getConfig()).toBe(config);
    });

    it("returns null from getConfig before any load", () => {
      writeConfig({});
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      expect(watcher.getConfig()).toBeNull();
    });
  });

  describe("reload", () => {
    it("emits configReloaded when config changes", () => {
      writeConfig({ agent: { model: "claude-opus-4-6" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const handler = vi.fn();
      watcher.on("configReloaded", handler);

      // Update the config
      writeConfig({ agent: { model: "opus" } });
      watcher.reload();

      expect(handler).toHaveBeenCalledTimes(1);
      const event: ConfigChangedEvent = handler.mock.calls[0]![0];
      expect(event.previous.agent.model).toBe("claude-opus-4-6");
      expect(event.current.agent.model).toBe("opus");
    });

    it("emits channelConfigChanged when a channel config changes", () => {
      writeConfig({
        channels: { telegram: { enabled: false } },
      });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const handler = vi.fn();
      watcher.on("channelConfigChanged", handler);

      writeConfig({
        channels: { telegram: { enabled: true, token: "new-token" } },
      });
      watcher.reload();

      expect(handler).toHaveBeenCalled();
      const events = handler.mock.calls.map(
        (call: ChannelConfigChangedEvent[]) => call[0],
      ) as ChannelConfigChangedEvent[];
      const telegramEvent = events.find((e) => e.channel === "telegram");
      expect(telegramEvent).toBeDefined();
    });

    it("emits securityConfigChanged when security config changes", () => {
      writeConfig({ security: { dmPolicy: "owner-only" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const handler = vi.fn();
      watcher.on("securityConfigChanged", handler);

      writeConfig({ security: { dmPolicy: "open" } });
      watcher.reload();

      expect(handler).toHaveBeenCalledTimes(1);
      const event: SecurityConfigChangedEvent = handler.mock.calls[0]![0];
      expect(event.previous.dmPolicy).toBe("owner-only");
      expect(event.current.dmPolicy).toBe("open");
    });

    it("does not emit channelConfigChanged when channels are unchanged", () => {
      writeConfig({
        channels: { telegram: { enabled: false } },
        agent: { model: "claude-opus-4-6" },
      });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const channelHandler = vi.fn();
      watcher.on("channelConfigChanged", channelHandler);

      // Change only agent config, channels stay the same
      writeConfig({
        channels: { telegram: { enabled: false } },
        agent: { model: "opus" },
      });
      watcher.reload();

      expect(channelHandler).not.toHaveBeenCalled();
    });

    it("does not emit securityConfigChanged when security is unchanged", () => {
      writeConfig({ security: { dmPolicy: "owner-only" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const secHandler = vi.fn();
      watcher.on("securityConfigChanged", secHandler);

      // Change only agent config
      writeConfig({
        security: { dmPolicy: "owner-only" },
        agent: { model: "opus" },
      });
      watcher.reload();

      expect(secHandler).not.toHaveBeenCalled();
    });

    it("emits error event on invalid config during reload", () => {
      writeConfig({ agent: { model: "claude-opus-4-6" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      const errorHandler = vi.fn();
      watcher.on("error", errorHandler);

      // Write invalid config
      writeFileSync(TEST_CONFIG_PATH, "- not\n- a\n- mapping\n", "utf-8");
      watcher.reload();

      expect(errorHandler).toHaveBeenCalledTimes(1);
      expect(errorHandler.mock.calls[0]![0]).toBeInstanceOf(Error);
    });

    it("returns null on error during reload", () => {
      writeConfig({ agent: { model: "claude-opus-4-6" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.load();

      watcher.on("error", () => {}); // suppress
      writeFileSync(TEST_CONFIG_PATH, "- invalid", "utf-8");
      const result = watcher.reload();

      expect(result).toBeNull();
    });

    it("does not emit events on first load (no previous config)", () => {
      writeConfig({ agent: { model: "claude-opus-4-6" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });

      const reloadHandler = vi.fn();
      watcher.on("configReloaded", reloadHandler);

      watcher.load();
      // First load should not emit configReloaded since there's no "previous"
      // Calling reload now should work as expected
      writeConfig({ agent: { model: "opus" } });
      watcher.reload();

      expect(reloadHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("start / stop", () => {
    it("starts with an initial config load", () => {
      writeConfig({ agent: { model: "haiku" } });
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });

      const config = watcher.start();
      expect(config.agent.model).toBe("haiku");
      expect(watcher.getConfig()).not.toBeNull();

      // Clean up
      void watcher.stop();
    });

    it("stop clears resources", async () => {
      writeConfig({});
      const watcher = new ConfigWatcher({ configPath: TEST_CONFIG_PATH });
      watcher.start();

      await watcher.stop();
      // Should not throw after stop
      expect(watcher.getConfig()).not.toBeNull(); // config still cached
    });
  });

  describe("credential resolver integration", () => {
    it("resolves credentials during load", () => {
      writeConfig({
        channels: {
          telegram: {
            enabled: true,
            token: "$credential:telegram.bot_token",
          },
        },
      });

      const watcher = new ConfigWatcher({
        configPath: TEST_CONFIG_PATH,
        credentialResolver: {
          get(key: string) {
            if (key === "telegram.bot_token") return "resolved-secret";
            return undefined;
          },
        },
      });

      const config = watcher.load();
      expect(config.channels.telegram.token).toBe("resolved-secret");
    });
  });
});
