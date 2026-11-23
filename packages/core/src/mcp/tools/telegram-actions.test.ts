import { describe, it, expect, vi } from "vitest";
import { createTelegramActionToolHandlers } from "./telegram-actions.js";
import { ChannelRegistry } from "../../channels/registry.js";
import type { ChannelAdapter } from "../../channels/adapter.js";

const token = (): string => ["gh", "p_", "Ws2Ed3Rf4Tg5Yh6Uj7Ik8Ol9Pq0Az1Sx2Dc3Fv4"].join("");
const MARK = "«redacted:github-token»";

function setup() {
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: 5, date: 1 })),
    editMessageText: vi.fn(async () => {}),
  };
  const adapter = {
    id: "telegram",
    capabilities: {},
    bot: { api },
    async start() {},
    async stop() {},
    getStatus: () => ({ state: "connected", failureCount: 0 }),
    onMessage() {},
    async sendText() { return []; },
    async sendTyping() {},
  } as unknown as ChannelAdapter;
  const registry = new ChannelRegistry();
  registry.register(adapter);
  vi.spyOn(registry, "isRunning").mockReturnValue(true);
  return { api, handlers: createTelegramActionToolHandlers(registry) };
}

describe("telegram_action secret scrubbing", () => {
  it("reaches the bot through the registry proxy and scrubs sendMessage text, quote and button labels", async () => {
    const { api, handlers } = setup();
    const buttons = JSON.stringify([[{ text: `k ${token()}`, callback_data: "yes" }]]);
    const result = await handlers.telegram_action.handler({
      action: "sendMessage", chatId: "1", content: `hi ${token()}`, replyTo: "3", quoteText: token(), buttons,
    });
    expect(result).toEqual({ messageId: "5", timestamp: 1000 });
    const [chatId, text, opts] = api.sendMessage.mock.calls[0] as unknown as [string, string, Record<string, any>];
    expect(chatId).toBe("1");
    expect(text).toBe(`hi ${MARK}`);
    expect(opts.reply_parameters.quote).toBe(MARK);
    expect(opts.reply_markup.inline_keyboard).toEqual([[{ text: `k ${MARK}`, callback_data: "yes" }]]);
  });

  it("scrubs editMessage text", async () => {
    const { api, handlers } = setup();
    await handlers.telegram_action.handler({ action: "editMessage", chatId: "1", messageId: "2", content: token() });
    expect((api.editMessageText.mock.calls[0] as unknown[])[2]).toBe(MARK);
  });

  it("scrubs the error message it returns", async () => {
    const { api, handlers } = setup();
    api.sendMessage.mockRejectedValueOnce(new Error(`request failed for ${token()}`));
    const result = await handlers.telegram_action.handler({ action: "sendMessage", chatId: "1", content: "x" });
    expect(result).toEqual({ error: `Telegram action failed: request failed for ${MARK}` });
  });
});
