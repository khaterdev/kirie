/**
 * Mock channel adapter for integration tests.
 * Simulates a channel adapter without any real platform connection.
 */

import { makeMessageId, type TestUnifiedMessage } from "./fixtures.js";

export interface MockChannelAdapter {
  readonly id: string;
  readonly sentMessages: Array<{ chatId: string; text: string; options?: unknown }>;
  readonly typingIndicators: Array<{ chatId: string }>;
  readonly started: boolean;

  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): { connected: boolean; latencyMs: number };

  sendText(chatId: string, text: string, options?: unknown): Promise<string>;
  sendTyping(chatId: string): Promise<void>;

  /** Simulate an incoming message from the platform */
  simulateIncoming(msg: Partial<TestUnifiedMessage>): TestUnifiedMessage;

  /** Register an incoming message handler */
  onMessage(handler: (msg: TestUnifiedMessage) => void): void;

  /** Reset all recorded state */
  reset(): void;
}

export function createMockChannel(channelId = "mock-channel"): MockChannelAdapter {
  let _started = false;
  const _sentMessages: Array<{ chatId: string; text: string; options?: unknown }> = [];
  const _typingIndicators: Array<{ chatId: string }> = [];
  const _handlers: Array<(msg: TestUnifiedMessage) => void> = [];

  return {
    get id() {
      return channelId;
    },
    get sentMessages() {
      return [..._sentMessages];
    },
    get typingIndicators() {
      return [..._typingIndicators];
    },
    get started() {
      return _started;
    },

    async start() {
      _started = true;
    },

    async stop() {
      _started = false;
    },

    getStatus() {
      return { connected: _started, latencyMs: _started ? 5 : -1 };
    },

    async sendText(chatId: string, text: string, options?: unknown) {
      _sentMessages.push({ chatId, text, options });
      return makeMessageId();
    },

    async sendTyping(chatId: string) {
      _typingIndicators.push({ chatId });
    },

    simulateIncoming(partial: Partial<TestUnifiedMessage> = {}): TestUnifiedMessage {
      const msg: TestUnifiedMessage = {
        id: makeMessageId(),
        channel: channelId,
        senderId: "user-test",
        senderName: "Test User",
        text: "test message",
        chatType: "dm",
        chatId: "chat-test",
        timestamp: Date.now(),
        ...partial,
      };
      for (const handler of _handlers) {
        handler(msg);
      }
      return msg;
    },

    onMessage(handler: (msg: TestUnifiedMessage) => void) {
      _handlers.push(handler);
    },

    reset() {
      _sentMessages.length = 0;
      _typingIndicators.length = 0;
      _handlers.length = 0;
      _started = false;
    },
  };
}
