import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One shared fake grammY Bot: records constructor args and exposes a mockable api.
const { BotMock, getFile, getMe, api, botStart, botOn } = vi.hoisted(() => {
  const getFile = vi.fn();
  const getMe = vi.fn(async () => ({ id: 42, username: "kirie_bot", first_name: "Kirie" }));
  let nextId = 500;
  const api = {
    sendMessage: vi.fn(async (..._args: unknown[]) => ({ message_id: nextId++, date: 1700000000 })),
    editMessageText: vi.fn(async () => true),
    editMessageReplyMarkup: vi.fn(async () => true),
    answerCallbackQuery: vi.fn(async () => true),
    setMyCommands: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
  };
  const botStart = vi.fn();
  const botOn = vi.fn();
  const BotMock = vi.fn().mockImplementation(() => ({
    on: botOn,
    start: botStart,
    stop: vi.fn(async () => {}),
    catch: vi.fn(),
    api: { getFile, getMe, ...api },
  }));
  return { BotMock, getFile, getMe, api, botStart, botOn };
});
vi.mock("grammy", () => ({ Bot: BotMock, InputFile: vi.fn() }));

import { TelegramAdapter, resolveTelegramFileSource, DEFAULT_TELEGRAM_API_ROOT, toInlineKeyboard } from "./adapter.js";

const TOKEN = "123:abc";

describe("resolveTelegramFileSource", () => {
  it("uses api.telegram.org for relative paths by default (cloud)", () => {
    expect(resolveTelegramFileSource("videos/file_1.mp4", TOKEN)).toEqual({
      kind: "url",
      url: `${DEFAULT_TELEGRAM_API_ROOT}/file/bot${TOKEN}/videos/file_1.mp4`,
    });
  });

  it("uses the custom apiRoot for relative paths (self-hosted, non-local mode)", () => {
    expect(resolveTelegramFileSource("videos/file_1.mp4", TOKEN, "http://127.0.0.1:8081/")).toEqual({
      kind: "url",
      url: `http://127.0.0.1:8081/file/bot${TOKEN}/videos/file_1.mp4`,
    });
  });

  it("reads absolute paths from disk (self-hosted --local mode)", () => {
    const p = `/Users/x/.kirie/telegram-bot-api/${TOKEN}/videos/file_1.mp4`;
    expect(resolveTelegramFileSource(p, TOKEN, "http://127.0.0.1:8081")).toEqual({ kind: "disk", path: p });
  });
});

describe("TelegramAdapter", () => {
  let tmp: string;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "kirie-tg-test-"));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function started(config: ConstructorParameters<typeof TelegramAdapter>[0]) {
    const adapter = new TelegramAdapter(config);
    await adapter.start(new AbortController().signal);
    return adapter;
  }

  it("constructs grammY bots with default options when no apiRoot is configured", async () => {
    await started({ token: TOKEN });
    expect(BotMock).toHaveBeenCalled();
    for (const call of BotMock.mock.calls) {
      expect(call).toEqual([TOKEN]);
    }
  });

  it("passes apiRoot to every grammY bot (token validation and polling)", async () => {
    await started({ token: TOKEN, apiRoot: "http://127.0.0.1:8081" });
    expect(BotMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of BotMock.mock.calls) {
      expect(call).toEqual([TOKEN, { client: { apiRoot: "http://127.0.0.1:8081" } }]);
    }
    expect(getMe).toHaveBeenCalled();
  });

  it("downloads via HTTPS from api.telegram.org in cloud mode (unchanged behavior)", async () => {
    getFile.mockResolvedValue({ file_id: "f", file_unique_id: "u", file_path: "photos/file_9.jpg" });
    fetchMock.mockResolvedValue(new Response(Buffer.from("jpeg-bytes")));
    const adapter = await started({ token: TOKEN });

    const result = await adapter.downloadMedia({ type: "photo", url: "f" });

    expect(fetchMock).toHaveBeenCalledWith(`https://api.telegram.org/file/bot${TOKEN}/photos/file_9.jpg`);
    expect(result.buffer.toString()).toBe("jpeg-bytes");
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("reads the file from disk when a local Bot API server returns an absolute path", async () => {
    const localFile = join(tmp, "file_7.mp4");
    writeFileSync(localFile, "big-video-bytes");
    getFile.mockResolvedValue({ file_id: "f", file_unique_id: "u", file_path: localFile });
    const adapter = await started({ token: TOKEN, apiRoot: "http://127.0.0.1:8081" });

    const result = await adapter.downloadMedia({ type: "video", url: "f", filename: "clip.mp4" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.buffer.toString()).toBe("big-video-bytes");
    expect(result.mimeType).toBe("video/mp4");
    expect(result.filename).toBe("clip.mp4");
  });

  it("names the 20 MB cloud limit when getFile says the file is too big", async () => {
    getFile.mockRejectedValue(new Error("Call to 'getFile' failed! (400: Bad Request: file is too big)"));
    const adapter = await started({ token: TOKEN });

    await expect(adapter.downloadMedia({ type: "video", url: "f" }))
      .rejects.toThrow("file is too big (Telegram bot limit 20 MB)");
  });

  it("names the 2 GB limit when a local Bot API server says the file is too big", async () => {
    getFile.mockRejectedValue(new Error("Call to 'getFile' failed! (400: Bad Request: file is too big)"));
    const adapter = await started({ token: TOKEN, apiRoot: "http://127.0.0.1:8081" });

    await expect(adapter.downloadMedia({ type: "video", url: "f" }))
      .rejects.toThrow("file is too big (Telegram bot limit 2 GB, local Bot API server)");
  });

  it("rethrows other getFile errors untouched", async () => {
    getFile.mockRejectedValue(new Error("Network request for 'getFile' failed!"));
    const adapter = await started({ token: TOKEN });

    await expect(adapter.downloadMedia({ type: "video", url: "f" }))
      .rejects.toThrow("Network request for 'getFile' failed!");
  });

  describe("interactive buttons and commands", () => {
    const ctx = { chatId: "1001" };

    it("advertises buttons and message deletion", () => {
      const adapter = new TelegramAdapter({ token: TOKEN });
      expect(adapter.capabilities.interactiveButtons).toBe(true);
      expect(adapter.capabilities.deleteMessage).toBe(true);
    });

    it("polls for callback queries alongside the existing update types", async () => {
      await started({ token: TOKEN });
      expect(botStart).toHaveBeenCalledWith(expect.objectContaining({
        allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
      }));
    });

    it("feeds button presses to onInteraction listeners", async () => {
      const adapter = new TelegramAdapter({ token: TOKEN });
      const listener = vi.fn();
      adapter.onInteraction(listener);
      await adapter.start(new AbortController().signal);
      const call = botOn.mock.calls.find((c) => c[0] === "callback_query:data");
      expect(call).toBeDefined();
      await (call![1] as (c: unknown) => void)({
        answerCallbackQuery: vi.fn(),
        callbackQuery: { id: "q", from: { id: 1001, first_name: "O" }, data: "k1|ask|x", message: { message_id: 3, date: 1, chat: { id: 1001, type: "private" } } },
      });
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "q", senderId: "1001", messageId: "3", data: "k1|ask|x" }));
    });

    it("returns its own id and username after start", async () => {
      const adapter = new TelegramAdapter({ token: TOKEN });
      expect(adapter.getSelf()).toBeNull();
      await adapter.start(new AbortController().signal);
      expect(adapter.getSelf()).toEqual({ id: "42", username: "kirie_bot" });
    });

    it("sendText with plain skips the Markdown parse mode", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.sendText({ ctx, text: "use /goal_start now", plain: true });
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
      expect(api.sendMessage).toHaveBeenCalledWith("1001", "use /goal_start now", {});
    });

    it("sendText without plain still tries Markdown first (unchanged)", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.sendText({ ctx, text: "hello" });
      expect(api.sendMessage).toHaveBeenCalledWith("1001", "hello", { parse_mode: "Markdown" });
    });

    it("plain sendText retries without the reply when replying fails", async () => {
      const adapter = await started({ token: TOKEN });
      api.sendMessage.mockRejectedValueOnce(new Error("message to be replied not found"));
      const sent = await adapter.sendText({ ctx: { chatId: "1001", replyToId: "9" }, text: "x", plain: true });
      expect(sent).toHaveLength(1);
      expect(api.sendMessage).toHaveBeenNthCalledWith(1, "1001", "x", { reply_parameters: { message_id: 9 } });
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, "1001", "x", {});
    });

    it("disableLinkPreview maps to link_preview_options on every send attempt (HOOK-B1)", async () => {
      const off = { link_preview_options: { is_disabled: true } };
      const adapter = await started({ token: TOKEN });
      await adapter.sendText({ ctx, text: "see evil.example/x", plain: true, disableLinkPreview: true });
      expect(api.sendMessage).toHaveBeenLastCalledWith("1001", "see evil.example/x", off);

      api.sendMessage.mockClear();
      api.sendMessage.mockRejectedValueOnce(new Error("message to be replied not found"));
      await adapter.sendText({ ctx: { chatId: "1001", replyToId: "9" }, text: "x", plain: true, disableLinkPreview: true });
      expect(api.sendMessage).toHaveBeenNthCalledWith(1, "1001", "x", { reply_parameters: { message_id: 9 }, ...off });
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, "1001", "x", off);

      api.sendMessage.mockClear();
      await adapter.sendText({ ctx, text: "md", disableLinkPreview: true });
      expect(api.sendMessage).toHaveBeenLastCalledWith("1001", "md", { parse_mode: "Markdown", ...off });

      api.sendMessage.mockClear();
      api.sendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
      await adapter.sendText({ ctx, text: "md_", disableLinkPreview: true });
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, "1001", "md_", off);

      api.sendMessage.mockClear();
      api.sendMessage.mockRejectedValueOnce(new Error("message to be replied not found"));
      await adapter.sendText({ ctx: { chatId: "1001", replyToId: "9" }, text: "r", disableLinkPreview: true });
      expect(api.sendMessage).toHaveBeenNthCalledWith(2, "1001", "r", { parse_mode: "Markdown", ...off });
    });

    it("without disableLinkPreview no link_preview_options is sent (unchanged)", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.sendText({ ctx, text: "a", plain: true });
      await adapter.sendText({ ctx, text: "b" });
      await adapter.sendText({ ctx, text: "c", disableLinkPreview: false });
      for (const call of api.sendMessage.mock.calls) expect(call[2]).not.toHaveProperty("link_preview_options");
    });

    it("sendInteractive builds an inline_keyboard", async () => {
      const adapter = await started({ token: TOKEN });
      const sent = await adapter.sendInteractive({
        ctx,
        text: "Approve?",
        buttons: [[{ label: "Approve", data: "k1|ask|a" }, { label: "Deny", data: "k1|ask|d" }], [{ label: "Docs", url: "https://example.test" }]],
        plain: true,
      });
      expect(sent.id).toMatch(/^\d+$/);
      expect(api.sendMessage).toHaveBeenCalledWith("1001", "Approve?", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Approve", callback_data: "k1|ask|a" }, { text: "Deny", callback_data: "k1|ask|d" }],
            [{ text: "Docs", url: "https://example.test" }],
          ],
        },
      });
    });

    it("sendInteractive falls back to plain text on a Markdown parse error", async () => {
      const adapter = await started({ token: TOKEN });
      api.sendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
      await adapter.sendInteractive({ ctx, text: "a_b", buttons: [[{ label: "X", data: "k1|ask|x" }]] });
      expect(api.sendMessage).toHaveBeenCalledTimes(2);
      expect(api.sendMessage.mock.calls[0]![2]).toMatchObject({ parse_mode: "Markdown" });
      expect(api.sendMessage.mock.calls[1]![2]).not.toHaveProperty("parse_mode");
      expect(api.sendMessage.mock.calls[1]![2]).toHaveProperty("reply_markup");
    });

    it("sendInteractive puts the buttons on the last chunk of a long text", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.sendInteractive({ ctx, text: "word ".repeat(1500), buttons: [[{ label: "X", data: "k1|ask|x" }]], plain: true });
      const calls = api.sendMessage.mock.calls;
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.slice(0, -1).every((c) => !("reply_markup" in (c[2] as object)))).toBe(true);
      expect(calls.at(-1)![2]).toHaveProperty("reply_markup");
    });

    it("rejects buttons with neither or both of data/url, or data over 64 bytes", () => {
      expect(() => toInlineKeyboard([[{ label: "X" }]])).toThrow(/exactly one/);
      expect(() => toInlineKeyboard([[{ label: "X", data: "a", url: "https://e.test" }]])).toThrow(/exactly one/);
      expect(() => toInlineKeyboard([[{ label: "X", data: "x".repeat(65) }]])).toThrow(/64 bytes/);
      expect(toInlineKeyboard([[], [{ label: "X", data: "x".repeat(64) }]])).toEqual({ inline_keyboard: [[{ text: "X", callback_data: "x".repeat(64) }]] });
    });

    it("updateInteractive edits text and removes the keyboard", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.updateInteractive({ ctx, messageId: "77", text: "Approved 23:41", buttons: null, plain: true });
      expect(api.editMessageText).toHaveBeenCalledWith("1001", 77, "Approved 23:41", { reply_markup: { inline_keyboard: [] } });
    });

    it("updateInteractive changes only the keyboard when no text is given", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.updateInteractive({ ctx, messageId: "77", buttons: [[{ label: "Undo", data: "k1|prop|u:1:ab" }]] });
      expect(api.editMessageReplyMarkup).toHaveBeenCalledWith("1001", 77, {
        reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: "k1|prop|u:1:ab" }]] },
      });
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    it("updateInteractive ignores 'message is not modified' and rethrows other errors", async () => {
      const adapter = await started({ token: TOKEN });
      api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: message is not modified"));
      await expect(adapter.updateInteractive({ ctx, messageId: "1", text: "same", plain: true })).resolves.toBeUndefined();
      api.editMessageText.mockRejectedValueOnce(new Error("Bad Request: message to edit not found"));
      await expect(adapter.updateInteractive({ ctx, messageId: "1", text: "x", plain: true })).rejects.toThrow(/not found/);
    });

    it("ackInteraction answers the callback query and swallows errors", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.ackInteraction({ interactionId: "q1", text: "Only the owner can do that.", alert: true });
      expect(api.answerCallbackQuery).toHaveBeenCalledWith("q1", { text: "Only the owner can do that.", show_alert: true });
      await adapter.ackInteraction({ interactionId: "q2" });
      expect(api.answerCallbackQuery).toHaveBeenLastCalledWith("q2", {});
      api.answerCallbackQuery.mockRejectedValueOnce(new Error("query is too old"));
      await expect(adapter.ackInteraction({ interactionId: "q3" })).resolves.toBeUndefined();
    });

    it("ackInteraction is a no-op before start", async () => {
      const adapter = new TelegramAdapter({ token: TOKEN });
      await expect(adapter.ackInteraction({ interactionId: "q" })).resolves.toBeUndefined();
      expect(api.answerCallbackQuery).not.toHaveBeenCalled();
    });

    it("registerCommands uses the default scope, or a chat scope for one chat", async () => {
      const adapter = await started({ token: TOKEN });
      const cmds = [{ command: "help", description: "List commands" }];
      await adapter.registerCommands(cmds);
      expect(api.setMyCommands).toHaveBeenLastCalledWith(cmds);
      await adapter.registerCommands(cmds, { chatId: "1001" });
      expect(api.setMyCommands).toHaveBeenLastCalledWith(cmds, { scope: { type: "chat", chat_id: 1001 } });
    });

    it("deleteMessage deletes by numeric id", async () => {
      const adapter = await started({ token: TOKEN });
      await adapter.deleteMessage({ ctx, messageId: "88" });
      expect(api.deleteMessage).toHaveBeenCalledWith("1001", 88);
    });
  });
});
