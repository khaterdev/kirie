/**
 * Test-only fake channel adapter and registry for the interaction layer.
 * Records every send, update and ack; never touches a network.
 */

import { vi } from "vitest";
import type {
  AckInteractionParams,
  ChannelAdapter,
  SendInteractiveParams,
  SendTextParams,
  UpdateInteractiveParams,
} from "../channels/adapter.js";
import type { ChannelName, InteractionListener, UnifiedInteraction } from "../channels/normalizer.js";
import type { InteractionChannelLookup } from "./router.js";

export interface FakeAdapter extends ChannelAdapter {
  sentText: SendTextParams[];
  sentInteractive: SendInteractiveParams[];
  updates: UpdateInteractiveParams[];
  edits: Array<{ chatId: string; messageId: string; text: string }>;
  acks: AckInteractionParams[];
  interactionListeners: InteractionListener[];
  /** Deliver a press to the registered listeners and wait for them */
  press(i: Partial<UnifiedInteraction> & { data: string }): Promise<void>;
}

export function makeFakeAdapter(id: ChannelName = "telegram", opts: { buttons?: boolean; dmChatId?: string } = {}): FakeAdapter {
  const buttons = opts.buttons ?? true;
  let nextId = 100;
  const a: FakeAdapter = {
    id,
    capabilities: {
      sendMedia: false,
      sendReaction: false,
      editMessage: true,
      deleteMessage: false,
      sendTyping: false,
      threads: false,
      multipleImages: false,
      reactions: false,
      replyContext: false,
      voiceMessages: false,
      maxTextLength: 4000,
      interactiveButtons: buttons,
    },
    sentText: [],
    sentInteractive: [],
    updates: [],
    edits: [],
    acks: [],
    interactionListeners: [],
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getStatus: () => ({ state: "connected", failureCount: 0 }),
    onMessage: () => {},
    sendTyping: async () => {},
    sendText: vi.fn(async (p: SendTextParams) => {
      a.sentText.push(p);
      return [{ id: String(nextId++), timestamp: Date.now(), ...(opts.dmChatId ? { chatId: opts.dmChatId } : {}) }];
    }),
    editMessage: vi.fn(async (p) => {
      a.edits.push({ chatId: p.ctx.chatId, messageId: p.messageId, text: p.text });
    }),
    ackInteraction: vi.fn(async (p: AckInteractionParams) => {
      a.acks.push(p);
    }),
    onInteraction: (l: InteractionListener) => {
      a.interactionListeners.push(l);
    },
    async press(i) {
      const full: UnifiedInteraction = {
        id: `cb-${nextId++}`,
        channel: id,
        senderId: "1001",
        senderName: "Owner",
        chatId: "1001",
        chatType: "dm",
        messageId: "0",
        timestamp: Date.now(),
        raw: null,
        ...i,
      };
      await Promise.all(a.interactionListeners.map((l) => l(full)));
    },
  };
  if (buttons) {
    a.sendInteractive = vi.fn(async (p: SendInteractiveParams) => {
      a.sentInteractive.push(p);
      return { id: String(nextId++), timestamp: Date.now() };
    });
    a.updateInteractive = vi.fn(async (p: UpdateInteractiveParams) => {
      a.updates.push(p);
    });
  }
  return a;
}

export function makeFakeRegistry(adapters: FakeAdapter[], running = true): InteractionChannelLookup & { running: Set<string> } {
  const byId = new Map(adapters.map((a) => [a.id, a]));
  const runningSet = new Set(running ? adapters.map((a) => a.id) : []);
  return {
    running: runningSet,
    getById: (id: ChannelName) => byId.get(id),
    isRunning: (id: ChannelName) => runningSet.has(id),
  };
}
