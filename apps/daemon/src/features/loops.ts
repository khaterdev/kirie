import { join } from "node:path";
import {
  LoopService,
  LoopStore,
  LOOPS_TOOLS_CONFIG_ENV,
  createLoopCommands,
  createModuleLogger,
  effectiveSettingFlag,
  formatDuration,
  type ChannelName,
  type HeartbeatTickEvent,
  type LoopDeliveryKind,
  type LoopRecord,
} from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

const log = createModuleLogger("feature-loops");

const ENABLED_KEY = "loops.enabled";

/**
 * /loop recurring prompts (item 8, PLAN C.8).
 *
 * Setup: opens `~/.kirie/loops.db`, registers `/loop`, and hands the boot
 * `loops` config to the kirie-tools server (for `loop_create`). Start: re-anchors
 * overdue loops and runs `LoopService.onTick` on every heartbeat tick. Loops
 * ship off (`loops.enabled: false`); `/loop on` persists the override.
 */
export const setupLoops: FeatureSetup = (ctx) => {
  const store = new LoopStore(join(ctx.dataDir, "loops.db"));
  ctx.kirieToolsEnv[LOOPS_TOOLS_CONFIG_ENV] = JSON.stringify(ctx.config.loops);

  const isEnabled = (): boolean => effectiveSettingFlag(ctx.settings, ENABLED_KEY, ctx.config.loops.enabled);
  const audit = (action: string, actor: string, loop: LoopRecord | null, detail?: Record<string, unknown>): void => {
    ctx.audit.record({
      feature: "loops",
      action,
      actor,
      detail: { ...(loop ? { id: loop.id, sessionKey: loop.sessionKey, createdBy: loop.createdBy } : {}), ...detail },
    });
  };

  const service = new LoopService({
    store,
    config: () => ctx.config.loops,
    isEnabled,
    inject: (opts) => ctx.pipeline.injectMessage(opts),
    isChatBusy: (sessionKey) => ctx.pipeline.isBusy(sessionKey),
    deliver: (loop, text, kind) => deliverToLoopChat(ctx, loop, text, kind),
    notifyOwner: (text, opts) => ctx.notifyOwner(text, opts),
    isOwnerChat: (channel, chatId) => isOwnerDm(ctx, channel, chatId),
    askOwner: (loop) => askOwnerToStart(ctx, loop),
    audit,
  });

  ctx.commands.registerAll(createLoopCommands({
    store,
    service,
    config: () => ctx.config.loops,
    isEnabled,
    setEnabled: (on, by) => ctx.settings.set(ENABLED_KEY, on, by),
    audit,
  }));

  const onTick = (event: HeartbeatTickEvent): void => {
    try {
      service.onTick(event.timestamp);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "loop tick handler failed");
    }
  };

  return {
    name: "loops",
    start() {
      service.start();
      ctx.heartbeat.on("tick", onTick);
      log.info({ enabled: isEnabled(), active: service.activeCount }, "loops started");
    },
    async stop() {
      ctx.heartbeat.off("tick", onTick);
      service.stop();
      // Result handlers already running may still write; agent turns still in flight are not waited for.
      await service.settle();
      store.close();
    },
  };
};

/** Loops run only in an owner's DM: an owner id as the chat id (Telegram), or the primary owner chat. */
function isOwnerDm(ctx: DaemonContext, channel: string, chatId: string): boolean {
  if (ctx.owners.isOwner(channel as ChannelName, chatId)) return true;
  const primary = ctx.owners.primary();
  return primary !== null && primary.channel === channel && primary.chatId === chatId;
}

async function deliverToLoopChat(ctx: DaemonContext, loop: LoopRecord, text: string, kind: LoopDeliveryKind): Promise<void> {
  const adapter = ctx.channelRegistry.getById(loop.channel);
  if (!adapter || !ctx.channelRegistry.isRunning(loop.channel)) {
    log.warn({ loopId: loop.id, channel: loop.channel }, "loop message not sent: channel is not running");
    return;
  }
  await adapter.sendText({ ctx: { chatId: loop.chatId }, text, ...(kind === "notice" ? { plain: true } : {}) });
  if (kind === "reply") {
    try {
      ctx.chatHistoryStore.append(loop.sessionKey, "assistant", text, { channel: loop.channel });
    } catch (err) {
      log.warn({ loopId: loop.id, err: err instanceof Error ? err.message : String(err) }, "loop reply not stored in chat history");
    }
  }
}

async function askOwnerToStart(ctx: DaemonContext, loop: LoopRecord): Promise<boolean> {
  const hours = Math.max(1, Math.round((loop.expiresAt - loop.createdAt) / 3_600_000));
  const res = await ctx.ownerPrompts.ask({
    kind: "loop",
    title: `Start loop ${loop.id}?`,
    body: `The agent wants to re-run this prompt in your DM every ${formatDuration(loop.baseIntervalSec * 1000)}, up to ${loop.maxRuns} runs, for at most ${hours}h${loop.backoff ? ", checking less often while nothing changes" : ""}.`,
    // Shown in full, or Start only after all of it was sent (E.3).
    content: { label: "Prompt", text: loop.prompt },
    options: [
      { id: "start", label: "Start" },
      { id: "decline", label: "Decline" },
    ],
    defaultOptionId: "decline",
    timeoutMs: ctx.config.commands.promptTimeoutSeconds * 1000,
  });
  return res.outcome === "answered" && res.optionId === "start";
}
