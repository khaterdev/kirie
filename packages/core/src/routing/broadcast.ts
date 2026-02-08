import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelName } from "../channels/normalizer.js";

export interface BroadcastTarget {
  channel: string;
  chatId: string;
  accountId?: string;
}

export interface BroadcastGroup {
  name: string;
  targets: BroadcastTarget[];
}

export interface BroadcastResult {
  target: string;
  success: boolean;
  error?: string;
}

export async function broadcastMessage(
  group: BroadcastGroup,
  message: string,
  channelRegistry: ChannelRegistry,
): Promise<BroadcastResult[]> {
  const results: BroadcastResult[] = [];

  for (const target of group.targets) {
    const targetId = `${target.channel}:${target.chatId}`;
    try {
      const adapter = channelRegistry.getById(target.channel as ChannelName);
      if (!adapter) {
        results.push({ target: targetId, success: false, error: `Channel "${target.channel}" not found` });
        continue;
      }
      await adapter.sendText({
        ctx: { chatId: target.chatId },
        text: message,
      });
      results.push({ target: targetId, success: true });
    } catch (err) {
      results.push({
        target: targetId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
