/**
 * InteractionRouter - the single choke point for every button press.
 *
 * Order of checks in `handle` (each one fails closed):
 *   1. The presser must be an owner on that channel, pressing in that owner's
 *      DM (for Telegram also chatId === senderId). Otherwise: alert
 *      "Only the owner can do that.", audit record, stop.
 *   2. Decode the callback data. Unknown version or namespace: "Expired.".
 *   3. Rate limit: 20 presses per minute per sender.
 *   4. Call the namespace handler, apply its reply, always acknowledge.
 *
 * Callback data format: "k1|<ns>|<action>", at most 64 bytes (Telegram limit).
 */

import pino from "pino";
import type { ChannelAdapter } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { ChannelName, UnifiedInteraction } from "../channels/normalizer.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { interactionActor, type OwnerDirectory } from "./owners.js";

const log = pino({ name: "interaction-router" });

export interface OwnerActionEvent {
  /** Namespace and action decoded from the callback data */
  ns: string;
  action: string;
  channel: ChannelName;
  chatId: string;
  messageId: string;
  senderId: string;
}

export interface OwnerActionReply {
  /** Notice shown to the presser */
  toast?: string;
  /** Show the toast as an alert */
  alert?: boolean;
  /** Replace the message text */
  replaceText?: string;
  /** Remove the buttons from the message */
  removeButtons?: boolean;
}

export type OwnerActionHandler = (ev: OwnerActionEvent) => Promise<OwnerActionReply | void>;

/** The part of ChannelRegistry the interaction layer uses. */
export type InteractionChannelLookup = Pick<ChannelRegistry, "getById" | "isRunning">;

export interface InteractionRouterDeps {
  channelRegistry: InteractionChannelLookup;
  owners: OwnerDirectory;
  audit: AuditTrail;
  /** Presses allowed per sender per minute. Default 20 */
  maxPressesPerMinute?: number;
}

export const INTERACTION_DATA_VERSION = "k1";
export const INTERACTION_DATA_MAX_BYTES = 64;
export const INTERACTION_NOT_OWNER_TEXT = "Only the owner can do that.";
export const INTERACTION_EXPIRED_TEXT = "Expired.";
export const INTERACTION_RATE_LIMITED_TEXT = "Too many presses. Try again in a minute.";
export const INTERACTION_FAILED_TEXT = "Something went wrong.";

const NS_RE = /^[a-z]{2,6}$/;
const ACTION_RE = /^[A-Za-z0-9_:.=-]+$/;
const RATE_WINDOW_MS = 60_000;

export class InteractionRouter {
  private readonly handlers = new Map<string, OwnerActionHandler>();
  private readonly attached = new Map<ChannelName, ChannelAdapter>();
  private readonly attachedSet = new WeakSet<ChannelAdapter>();
  private readonly presses = new Map<string, number[]>();
  private readonly maxPerMinute: number;

  constructor(private readonly deps: InteractionRouterDeps) {
    this.maxPerMinute = deps.maxPressesPerMinute ?? 20;
  }

  /** Build callback data. Throws on a bad namespace or action, or when the result exceeds 64 bytes. */
  static encode(ns: string, action: string): string {
    if (!NS_RE.test(ns)) throw new Error(`Invalid interaction namespace "${ns}"`);
    if (!ACTION_RE.test(action)) throw new Error(`Invalid interaction action for namespace "${ns}"`);
    const data = `${INTERACTION_DATA_VERSION}|${ns}|${action}`;
    if (Buffer.byteLength(data, "utf8") > INTERACTION_DATA_MAX_BYTES) {
      throw new Error(`Interaction data for namespace "${ns}" exceeds ${INTERACTION_DATA_MAX_BYTES} bytes`);
    }
    return data;
  }

  /** Parse callback data. Null for anything that is not a well-formed current-version payload. */
  static decode(data: string): { ns: string; action: string } | null {
    if (typeof data !== "string") return null;
    if (Buffer.byteLength(data, "utf8") > INTERACTION_DATA_MAX_BYTES) return null;
    const first = data.indexOf("|");
    if (first === -1) return null;
    if (data.slice(0, first) !== INTERACTION_DATA_VERSION) return null;
    const second = data.indexOf("|", first + 1);
    if (second === -1) return null;
    const ns = data.slice(first + 1, second);
    const action = data.slice(second + 1);
    if (!NS_RE.test(ns) || !ACTION_RE.test(action)) return null;
    return { ns, action };
  }

  /** Register the handler for a namespace. Throws on a bad or duplicate namespace. */
  registerNamespace(ns: string, handler: OwnerActionHandler): void {
    if (!NS_RE.test(ns)) throw new Error(`Invalid interaction namespace "${ns}"`);
    if (this.handlers.has(ns)) throw new Error(`Interaction namespace "${ns}" is already registered`);
    this.handlers.set(ns, handler);
  }

  hasNamespace(ns: string): boolean {
    return this.handlers.has(ns);
  }

  /** Route this adapter's button presses through `handle`. Idempotent per adapter. */
  attach(adapter: ChannelAdapter): void {
    this.attached.set(adapter.id, adapter);
    if (this.attachedSet.has(adapter)) return;
    if (!adapter.onInteraction) return;
    this.attachedSet.add(adapter);
    adapter.onInteraction((i) => this.handle(i));
  }

  /** Process one press. Never throws. */
  async handle(i: UnifiedInteraction): Promise<void> {
    const adapter = this.deps.channelRegistry.getById(i.channel) ?? this.attached.get(i.channel);
    let acked = false;
    const ack = async (text?: string, alert?: boolean): Promise<void> => {
      if (acked) return;
      acked = true;
      if (!adapter?.ackInteraction) return;
      try {
        await adapter.ackInteraction({ interactionId: i.id, text, alert });
      } catch {
        // Acks fail for old queries; nothing to do.
      }
    };

    try {
      // 1. Owner, in the owner's own DM.
      const denial = this.denialReason(i);
      if (denial) {
        this.deps.audit.record({
          feature: "interaction",
          action: "press.denied",
          actor: interactionActor(this.deps.owners, i.channel, i.senderId),
          detail: { channel: i.channel, chatType: i.chatType, reason: denial },
        });
        log.warn({ channel: i.channel, senderId: i.senderId, chatType: i.chatType, reason: denial }, "button press denied");
        await ack(INTERACTION_NOT_OWNER_TEXT, true);
        return;
      }

      // 2. Decode.
      const decoded = InteractionRouter.decode(i.data);
      const handler = decoded ? this.handlers.get(decoded.ns) : undefined;
      if (!decoded || !handler) {
        await ack(INTERACTION_EXPIRED_TEXT);
        return;
      }

      // 3. Rate limit.
      if (!this.allowPress(`${i.channel}:${i.senderId}`)) {
        await ack(INTERACTION_RATE_LIMITED_TEXT, true);
        return;
      }

      // 4. Namespace handler.
      let reply: OwnerActionReply | void;
      try {
        reply = await handler({
          ns: decoded.ns,
          action: decoded.action,
          channel: i.channel,
          chatId: i.chatId,
          messageId: i.messageId,
          senderId: i.senderId,
        });
      } catch (err) {
        log.error({ ns: decoded.ns, err: err instanceof Error ? err.message : String(err) }, "interaction handler failed");
        this.deps.audit.record({
          feature: "interaction",
          action: "press.failed",
          actor: interactionActor(this.deps.owners, i.channel, i.senderId),
          detail: { ns: decoded.ns },
        });
        await ack(INTERACTION_FAILED_TEXT, true);
        return;
      }

      if (reply && (reply.replaceText !== undefined || reply.removeButtons) && adapter?.updateInteractive) {
        try {
          await adapter.updateInteractive({
            ctx: { chatId: i.chatId },
            messageId: i.messageId,
            text: reply.replaceText,
            buttons: reply.removeButtons ? null : undefined,
            plain: true,
          });
        } catch (err) {
          log.warn({ ns: decoded.ns, err: err instanceof Error ? err.message : String(err) }, "interaction message update failed");
        }
      }
      await ack(reply ? reply.toast : undefined, reply ? reply.alert : undefined);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "interaction routing failed");
    } finally {
      await ack();
    }
  }

  private denialReason(i: UnifiedInteraction): string | null {
    if (!this.deps.owners.isOwner(i.channel, i.senderId)) return "not-owner";
    if (i.chatType !== "dm") return "not-dm";
    if (i.channel === "telegram" && i.chatId !== i.senderId) return "not-own-dm";
    return null;
  }

  private allowPress(key: string): boolean {
    const now = Date.now();
    const list = (this.presses.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (list.length >= this.maxPerMinute) {
      this.presses.set(key, list);
      return false;
    }
    list.push(now);
    this.presses.set(key, list);
    return true;
  }
}
