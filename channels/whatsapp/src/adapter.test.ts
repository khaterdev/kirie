import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Baileys
const mockSendMessage = vi.fn();
vi.mock("@whiskeysockets/baileys", () => ({}));

// Mock local modules
vi.mock("./baileys-client.js", () => ({
  createBaileysClient: vi.fn(),
  shouldReconnect: vi.fn(),
}));
vi.mock("./auth.js", () => ({
  phoneToJid: (phone: string) => `${phone}@s.whatsapp.net`,
}));

import { WhatsAppAdapter } from "./adapter.js";

describe("WhatsAppAdapter.sendText reply fallback", () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new WhatsAppAdapter();

    // Set internal state to connected so sendText works
    (adapter as any).state = "connected";
    (adapter as any).socket = {
      sendMessage: mockSendMessage,
      sendPresenceUpdate: vi.fn(),
      end: vi.fn(),
    };
  });

  it("sends message with quoted reply when replyToId is provided", async () => {
    mockSendMessage.mockResolvedValue({ key: { id: "sent-1" } });

    const result = await adapter.sendText({
      ctx: { chatId: "1234567890", replyToId: "msg-42" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sent-1");
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // First call should include quoted parameter
    const [jid, content, opts] = mockSendMessage.mock.calls[0]!;
    expect(jid).toBe("1234567890@s.whatsapp.net");
    expect(content).toEqual({ text: "Hello" });
    expect(opts).toBeDefined();
    expect(opts.quoted).toBeDefined();
    expect(opts.quoted.key.id).toBe("msg-42");
  });

  it("falls back to sending without quote when reply fails", async () => {
    // First call (with quoted) fails, second call (without) succeeds
    mockSendMessage
      .mockRejectedValueOnce(new Error("Quoted message not found"))
      .mockResolvedValueOnce({ key: { id: "sent-2" } });

    const result = await adapter.sendText({
      ctx: { chatId: "1234567890", replyToId: "msg-deleted" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("sent-2");
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    // Second call should NOT include quoted parameter
    const [jid, content, opts] = mockSendMessage.mock.calls[1]!;
    expect(jid).toBe("1234567890@s.whatsapp.net");
    expect(content).toEqual({ text: "Hello" });
    expect(opts).toBeUndefined();
  });

  it("sends message without quote when no replyToId", async () => {
    mockSendMessage.mockResolvedValue({ key: { id: "sent-3" } });

    const result = await adapter.sendText({
      ctx: { chatId: "1234567890" },
      text: "No reply",
    });

    expect(result).toHaveLength(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    const [, content, opts] = mockSendMessage.mock.calls[0]!;
    expect(content).toEqual({ text: "No reply" });
    expect(opts).toBeUndefined();
  });

  it("propagates error when fallback send also fails", async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error("Quote failed"))
      .mockRejectedValueOnce(new Error("Connection closed"));

    await expect(
      adapter.sendText({
        ctx: { chatId: "1234567890", replyToId: "msg-bad" },
        text: "Hello",
      }),
    ).rejects.toThrow("Connection closed");

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("resolves JID with @ as-is", async () => {
    mockSendMessage.mockResolvedValue({ key: { id: "sent-4" } });

    await adapter.sendText({
      ctx: { chatId: "user@s.whatsapp.net" },
      text: "Test",
    });

    expect(mockSendMessage.mock.calls[0]![0]).toBe("user@s.whatsapp.net");
  });
});
