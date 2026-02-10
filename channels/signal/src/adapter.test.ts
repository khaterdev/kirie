import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock local modules
const mockSendMessage = vi.fn();
vi.mock("./client.js", () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    sendMessage: mockSendMessage,
    onMessage: vi.fn(),
    startListening: vi.fn(),
    stop: vi.fn(),
  })),
}));
vi.mock("./auth.js", () => ({
  verifyPhoneNumber: vi.fn(),
  normalizePhone: (phone: string) => phone,
}));

import { SignalAdapter } from "./adapter.js";

describe("SignalAdapter.sendText reply fallback", () => {
  let adapter: SignalAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new SignalAdapter({
      apiUrl: "http://localhost:8080",
      phoneNumber: "+1234567890",
    });

    // Set internal state to connected so sendText works
    (adapter as any).state = "connected";
    (adapter as any).client = {
      sendMessage: mockSendMessage,
      onMessage: vi.fn(),
      startListening: vi.fn(),
      stop: vi.fn(),
    };
  });

  it("sends message with quote when replyToId is provided", async () => {
    mockSendMessage.mockResolvedValue({ timestamp: "1700000000000" });

    const result = await adapter.sendText({
      ctx: { chatId: "+9876543210", replyToId: "1699999999999" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1700000000000");
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    // First call should include quote parameters
    const [chatId, text, opts] = mockSendMessage.mock.calls[0]!;
    expect(chatId).toBe("+9876543210");
    expect(text).toBe("Hello");
    expect(opts).toEqual({
      quoteTimestamp: 1699999999999,
      quoteAuthor: "+9876543210",
    });
  });

  it("falls back to sending without quote when reply fails", async () => {
    // First call (with quote) fails, second call (without) succeeds
    mockSendMessage
      .mockRejectedValueOnce(new Error("Internal Server Error"))
      .mockResolvedValueOnce({ timestamp: "1700000000001" });

    const result = await adapter.sendText({
      ctx: { chatId: "+9876543210", replyToId: "1699999999999" },
      text: "Hello",
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1700000000001");
    expect(mockSendMessage).toHaveBeenCalledTimes(2);

    // Second call should NOT include quote parameters
    const [chatId, text, opts] = mockSendMessage.mock.calls[1]!;
    expect(chatId).toBe("+9876543210");
    expect(text).toBe("Hello");
    expect(opts).toBeUndefined();
  });

  it("sends message without quote when no replyToId", async () => {
    mockSendMessage.mockResolvedValue({ timestamp: "1700000000002" });

    const result = await adapter.sendText({
      ctx: { chatId: "+9876543210" },
      text: "No reply",
    });

    expect(result).toHaveLength(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    const [, text, opts] = mockSendMessage.mock.calls[0]!;
    expect(text).toBe("No reply");
    expect(opts).toBeUndefined();
  });

  it("propagates error when fallback send also fails", async () => {
    mockSendMessage
      .mockRejectedValueOnce(new Error("Quote failed"))
      .mockRejectedValueOnce(new Error("Service Unavailable"));

    await expect(
      adapter.sendText({
        ctx: { chatId: "+9876543210", replyToId: "1699999999999" },
        text: "Hello",
      }),
    ).rejects.toThrow("Service Unavailable");

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("converts replyToId to numeric quoteTimestamp", async () => {
    mockSendMessage.mockResolvedValue({ timestamp: "1700000000003" });

    await adapter.sendText({
      ctx: { chatId: "+9876543210", replyToId: "1699999999000" },
      text: "Test",
    });

    const [, , opts] = mockSendMessage.mock.calls[0]!;
    expect(opts.quoteTimestamp).toBe(1699999999000);
    expect(typeof opts.quoteTimestamp).toBe("number");
  });
});
