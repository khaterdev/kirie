import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One shared fake grammY Bot: records constructor args and exposes a mockable api.
const { BotMock, getFile, getMe } = vi.hoisted(() => {
  const getFile = vi.fn();
  const getMe = vi.fn(async () => ({ id: 42, username: "kirie_bot", first_name: "Kirie" }));
  const BotMock = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    catch: vi.fn(),
    api: { getFile, getMe },
  }));
  return { BotMock, getFile, getMe };
});
vi.mock("grammy", () => ({ Bot: BotMock, InputFile: vi.fn() }));

import { TelegramAdapter, resolveTelegramFileSource, DEFAULT_TELEGRAM_API_ROOT } from "./adapter.js";

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
});
