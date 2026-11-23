import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createModuleLogger,
  createPluginsCommands,
  effectiveSettingFlag,
  HookRegistry,
  KIRIE_PLUGINS_DIR_ENV,
  PluginApprovalStore,
  pluginApprovalsPath,
  PluginHookBridge,
  PluginLoader,
  PluginManager,
} from "@kirie/core";
import type { FeatureSetup } from "./types.js";

const log = createModuleLogger("feature-plugins");

/** `plugins.dir` as an absolute path. The default `~/.kirie/plugins` maps to `<dataDir>/plugins`. */
export function resolvePluginsDir(dir: string, dataDir: string): string {
  if (dir === "~/.kirie/plugins") return join(dataDir, "plugins");
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
  return isAbsolute(dir) ? resolve(dir) : resolve(dataDir, dir);
}

/**
 * Hooks and plugins (item 15, PLAN C.15). Off by default.
 *
 * Setup builds the registry, loader, approvals store and manager, registers
 * `/plugins`, and (only when the master switch is on at boot) the one tool
 * observer, so sessions started from now on carry the PostToolUse hook.
 * Start loads the approved plugins and connects the seams. `/plugins on` does
 * the same at runtime and closes idle v2 sessions so they pick up the tool
 * observer hook; `/plugins off` and stop unload everything.
 *
 * A config hot reload does not change plugin state; use /plugins or restart.
 */
export const setupPlugins: FeatureSetup = (ctx) => {
  const cfg = ctx.config.plugins;
  const pluginsDir = resolvePluginsDir(cfg.dir, ctx.dataDir);
  if (pluginsDir !== join(ctx.dataDir, "plugins")) ctx.kirieToolsEnv[KIRIE_PLUGINS_DIR_ENV] = pluginsDir;
  if (!cfg.requireHashPin) {
    log.warn("plugins.requireHashPin: false is ignored; plugins always load only while their files match the approved hash");
  }

  const isEnabled = (): boolean => effectiveSettingFlag(ctx.settings, "plugins.enabled", cfg.enabled);

  let manager: PluginManager | null = null;
  const registry = new HookRegistry({
    hookTimeoutMs: cfg.hookTimeoutMs,
    maxConsecutiveFailures: cfg.maxConsecutiveFailures,
    maxQueuedEventsPerPlugin: cfg.maxQueuedEventsPerPlugin,
    scrubPayloads: cfg.scrubEventPayloads,
    onSuspend: (name, info) => manager?.handleSuspend(name, info),
  });
  const loader = new PluginLoader({
    pluginsDir,
    cacheDir: join(ctx.dataDir, "state", "plugin-cache"),
    hookRegistry: registry,
    loadTimeoutMs: cfg.loadTimeoutMs,
  });
  const pluginManager = new PluginManager({
    pluginsDir,
    loader,
    registry,
    approvals: new PluginApprovalStore(pluginApprovalsPath(ctx.dataDir)),
    audit: ctx.audit,
    notifyOwner: (text, opts) => ctx.notifyOwner(text, opts),
    isEnabled,
    settings: () => ({ allow: cfg.allow, config: cfg.config }),
  });
  manager = pluginManager;
  pluginManager.baseline();

  const bridge = new PluginHookBridge({
    registry,
    pipeline: ctx.pipeline,
    channelRegistry: ctx.channelRegistry,
    sdkOptions: ctx.sdkOptions,
    hookTimeoutMs: cfg.hookTimeoutMs,
  });
  if (isEnabled()) bridge.ensureToolObserver();

  const setMaster = async (on: boolean, actor: string): Promise<{ loaded: string[]; refused: string[] }> => {
    ctx.settings.set("plugins.enabled", on, actor);
    if (!on) {
      bridge.deactivate();
      await pluginManager.stop("off");
      return { loaded: [], refused: [] };
    }
    const { observerAdded } = bridge.activate();
    const r = await pluginManager.start();
    // Sessions that are not busy restart on their next turn with the PostToolUse hook installed.
    if (observerAdded) ctx.v2Sessions?.closeIdleSessions(0);
    return { loaded: r.loaded.map((p) => `${p.name} ${p.version}`), refused: r.refused };
  };

  ctx.commands.registerAll(createPluginsCommands({ manager: pluginManager, isEnabled, setMaster, pluginsDir }));

  return {
    name: "plugins",
    async start() {
      if (!isEnabled()) return;
      bridge.activate();
      await pluginManager.start();
    },
    async stop() {
      bridge.deactivate();
      await pluginManager.stop("shutdown");
    },
  };
};
