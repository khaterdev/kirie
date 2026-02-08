import { describe, it, expect } from "vitest";
import { makeSessionKey, parseSessionKey, channelFromKey } from "./session-key.js";

describe("makeSessionKey", () => {
  it("creates key from channel, chatType, chatId", () => {
    expect(
      makeSessionKey({ channel: "telegram", chatType: "dm", chatId: "12345" }),
    ).toBe("telegram:dm:12345");
  });

  it("creates key for group chats", () => {
    expect(
      makeSessionKey({ channel: "discord", chatType: "group", chatId: "guild-channel-789" }),
    ).toBe("discord:group:guild-channel-789");
  });

  it("creates key for threads", () => {
    expect(
      makeSessionKey({ channel: "slack", chatType: "thread", chatId: "C04ABCDEF" }),
    ).toBe("slack:thread:C04ABCDEF");
  });

  it("throws for empty channel", () => {
    expect(() =>
      makeSessionKey({ channel: "", chatType: "dm", chatId: "123" }),
    ).toThrow("Invalid session key parts");
  });

  it("throws for empty chatId", () => {
    expect(() =>
      makeSessionKey({ channel: "telegram", chatType: "dm", chatId: "" }),
    ).toThrow("Invalid session key parts");
  });
});

describe("parseSessionKey", () => {
  it("parses a valid dm key", () => {
    const result = parseSessionKey("telegram:dm:12345");
    expect(result).toEqual({
      channel: "telegram",
      chatType: "dm",
      chatId: "12345",
    });
  });

  it("parses a valid group key", () => {
    const result = parseSessionKey("discord:group:guild-channel");
    expect(result).toEqual({
      channel: "discord",
      chatType: "group",
      chatId: "guild-channel",
    });
  });

  it("parses a valid thread key", () => {
    const result = parseSessionKey("slack:thread:C04ABC");
    expect(result).toEqual({
      channel: "slack",
      chatType: "thread",
      chatId: "C04ABC",
    });
  });

  it("handles chatId containing colons", () => {
    const result = parseSessionKey("telegram:dm:chat:with:colons");
    expect(result).not.toBeNull();
    expect(result!.chatId).toBe("chat:with:colons");
  });

  it("returns null for malformed key with too few parts", () => {
    expect(parseSessionKey("telegram:dm")).toBeNull();
    expect(parseSessionKey("telegram")).toBeNull();
    expect(parseSessionKey("")).toBeNull();
  });

  it("returns null for invalid chatType", () => {
    expect(parseSessionKey("telegram:private:123")).toBeNull();
    expect(parseSessionKey("telegram:unknown:123")).toBeNull();
  });
});

describe("channelFromKey", () => {
  it("extracts channel from key", () => {
    expect(channelFromKey("telegram:dm:12345")).toBe("telegram");
    expect(channelFromKey("discord:group:456")).toBe("discord");
  });

  it("returns null for malformed key", () => {
    expect(channelFromKey("nocolon")).toBeNull();
    expect(channelFromKey("")).toBeNull();
  });

  it("returns null for key starting with separator", () => {
    expect(channelFromKey(":dm:123")).toBeNull();
  });
});
