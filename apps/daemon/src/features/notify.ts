/**
 * DaemonContext.notifyOwner: one plain line to the owner's DM on the primary
 * channel (telegram, then discord, then slack). The channel registry's adapter
 * proxy scrubs it. With a key, at most one line per key per 10 minutes, unless
 * `always` is set: a notice about a real state change is always sent, and its
 * key is recorded so an identical no-change repeat is still coalesced.
 */

import { createModuleLogger, type ChannelRegistry, type OwnerDirectory } from "@kirie/core";

const log = createModuleLogger("owner-notify");

export const OWNER_NOTIFY_KEY_INTERVAL_MS = 10 * 60_000;

export function createOwnerNotifier(deps: {
  owners: Pick<OwnerDirectory, "primary">;
  channelRegistry: Pick<ChannelRegistry, "getById" | "isRunning">;
  now?: () => number;
}): (text: string, opts?: { key?: string; always?: boolean; disableLinkPreview?: boolean }) => Promise<void> {
  const now = deps.now ?? Date.now;
  const lastByKey = new Map<string, number>();
  return async (text, opts) => {
    const target = deps.owners.primary();
    if (!target) {
      log.warn("owner notice not sent: no owner identity configured");
      return;
    }
    if (opts?.key && !opts.always) {
      const last = lastByKey.get(opts.key);
      if (last !== undefined && now() - last < OWNER_NOTIFY_KEY_INTERVAL_MS) {
        log.debug({ key: opts.key }, "owner notice suppressed (rate limited)");
        return;
      }
    }
    const adapter = deps.channelRegistry.getById(target.channel);
    if (!adapter || !deps.channelRegistry.isRunning(target.channel)) {
      log.warn({ channel: target.channel }, "owner notice not sent: primary channel is not running");
      return;
    }
    try {
      await adapter.sendText({ ctx: { chatId: target.chatId }, text, plain: true, ...(opts?.disableLinkPreview ? { disableLinkPreview: true } : {}) });
      if (opts?.key) lastByKey.set(opts.key, now());
    } catch (err) {
      log.warn({ channel: target.channel, err: err instanceof Error ? err.message : String(err) }, "owner notice failed");
    }
  };
}
