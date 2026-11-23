/**
 * OwnerDirectory - the single answer to "is this sender the owner?".
 *
 * Owner identity comes only from `security.owner.identities` in the config.
 * Ids are compared as trimmed strings (Telegram ids may be numbers in YAML).
 * A channel with no configured owner has no owner: every check fails closed.
 */

import type { SecurityConfig } from "../config/schema.js";
import type { ChannelName } from "../channels/normalizer.js";

/** Owner identities per channel, as in `security.owner.identities`. */
export type OwnerIdentities = SecurityConfig["owner"]["identities"];

/** Order used to pick the owner's primary DM (same as lifecycle.ts for proactive). */
const PRIMARY_ORDER: readonly ChannelName[] = ["telegram", "discord", "slack"];

export class OwnerDirectory {
  private readonly ids = new Map<ChannelName, ReadonlySet<string>>();
  private readonly firstId = new Map<ChannelName, string>();

  constructor(identities: OwnerIdentities | Partial<Record<ChannelName, ReadonlyArray<string | number>>> | null | undefined) {
    if (!identities) return;
    for (const [channel, list] of Object.entries(identities)) {
      if (!Array.isArray(list)) continue;
      const set = new Set<string>();
      for (const raw of list as ReadonlyArray<unknown>) {
        if (typeof raw !== "string" && typeof raw !== "number") continue;
        const id = String(raw).trim();
        if (!id) continue;
        if (!this.firstId.has(channel)) this.firstId.set(channel, id);
        set.add(id);
      }
      if (set.size > 0) this.ids.set(channel, set);
    }
  }

  /** True only when `senderId` is a configured owner id on `channel`. */
  isOwner(channel: ChannelName, senderId: string): boolean {
    if (typeof senderId !== "string" && typeof senderId !== "number") return false;
    const id = String(senderId).trim();
    if (!id) return false;
    return this.ids.get(channel)?.has(id) ?? false;
  }

  /** True when at least one owner id is configured for `channel`. */
  hasOwner(channel: ChannelName): boolean {
    return this.ids.has(channel);
  }

  /** The owner's DM to use for prompts and notices: telegram, then discord, then slack. */
  primary(): { channel: ChannelName; chatId: string } | null {
    for (const channel of PRIMARY_ORDER) {
      const id = this.firstId.get(channel);
      if (id) return { channel, chatId: id };
    }
    return null;
  }
}

/** Actor string for audit records: "owner:<channel>:<id>" for owners, "user:<channel>:<id>" otherwise. */
export function interactionActor(owners: OwnerDirectory, channel: ChannelName, senderId: string): string {
  return `${owners.isOwner(channel, senderId) ? "owner" : "user"}:${channel}:${senderId}`;
}
