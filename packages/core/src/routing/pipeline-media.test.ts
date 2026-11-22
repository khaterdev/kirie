import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";

// Redirect ~/.kirie/media into a throwaway directory for these tests.
const fakeHome = vi.hoisted(
  () => `${(process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "")}/kirie-media-test-${process.pid}-${Date.now()}`,
);
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { MessagePipeline, downloadAndSaveMedia } from "./pipeline.js";
import { wrapUserMessage } from "../engine/agent-engine.js";
import type { IncomingMessage, AgentEngine, ExecutionResult } from "../engine/agent-engine.js";
import type { UnifiedMessage, UnifiedMedia, ChannelName } from "../channels/normalizer.js";
import type { ChannelAdapter, ChannelStatus, DownloadedMedia, SentMessage } from "../channels/adapter.js";
import type { ChannelRegistry } from "../channels/registry.js";
import type { SecurityGate, GateResult } from "../security/gate.js";
import type { SessionStore } from "../engine/session-store.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TOO_BIG_ERROR = "Call to 'getFile' failed! (400: Bad Request: file is too big)";

function makeAdapter(
  download: (media: UnifiedMedia) => Promise<DownloadedMedia>,
): ChannelAdapter & { listeners: Array<(msg: UnifiedMessage) => void> } {
  const listeners: Array<(msg: UnifiedMessage) => void> = [];
  return {
    id: "telegram" as ChannelName,
    capabilities: {
      sendMedia: false, sendReaction: false, editMessage: false, deleteMessage: false,
      sendTyping: true, threads: false, multipleImages: false, reactions: false,
      replyContext: false, voiceMessages: false, maxTextLength: 4000,
    },
    async start() {},
    async stop() {},
    getStatus(): ChannelStatus { return { state: "connected", failureCount: 0 }; },
    onMessage(listener) { listeners.push(listener); },
    sendText: vi.fn(async (): Promise<SentMessage[]> => [{ id: "sent-1", timestamp: Date.now() }]),
    sendTyping: vi.fn(async () => {}),
    downloadMedia: vi.fn(download),
    listeners,
  };
}

const video: UnifiedMedia = {
  type: "video",
  url: "BAACAgQAAxkBAAINIGc",
  filename: "IMG_4021.MOV",
  mimeType: "video/quicktime",
  sizeBytes: 48 * 1024 * 1024,
};

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("downloadAndSaveMedia", () => {
  it("records a too-big download as failed with a Telegram-specific reason", async () => {
    const adapter = makeAdapter(async () => { throw new Error(TOO_BIG_ERROR); });
    const { resolved, failed } = await downloadAndSaveMedia([video], adapter);

    expect(resolved).toEqual([]);
    expect(failed).toEqual([{
      type: "video",
      filename: "IMG_4021.MOV",
      mimeType: "video/quicktime",
      sizeBytes: 48 * 1024 * 1024,
      caption: undefined,
      reason: "file is too big (Telegram bot limit 20 MB)",
      tooBig: true,
    }]);
  });

  it("records a generic download failure as failed", async () => {
    const adapter = makeAdapter(async () => { throw new Error("fetch failed: ECONNRESET"); });
    const { resolved, failed } = await downloadAndSaveMedia([video], adapter);

    expect(resolved).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.tooBig).toBe(false);
    expect(failed[0]!.reason).toBe("download failed: fetch failed: ECONNRESET");
  });

  it("records media over Kirie's own size cap as failed instead of dropping it", async () => {
    const big = Buffer.alloc(17 * 1024 * 1024); // video cap is 16 MB
    const adapter = makeAdapter(async () => ({ buffer: big, mimeType: "video/mp4", filename: "a.mp4" }));
    const { resolved, failed } = await downloadAndSaveMedia([{ type: "video", url: "id" }], adapter);

    expect(resolved).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.tooBig).toBe(true);
    expect(failed[0]!.sizeBytes).toBe(big.length);
    expect(failed[0]!.reason).toContain("size cap");
  });

  it("saves successful downloads to disk with no failures", async () => {
    const adapter = makeAdapter(async () => ({
      buffer: PNG_BYTES, mimeType: "image/png", filename: "photo.png",
    }));
    const { resolved, failed } = await downloadAndSaveMedia(
      [{ type: "photo", url: "photo-id", caption: "sunset" }],
      adapter,
    );

    expect(failed).toEqual([]);
    expect(resolved).toHaveLength(1);
    const item = resolved[0]!;
    expect(item.type).toBe("photo");
    expect(item.mimeType).toBe("image/png");
    expect(item.caption).toBe("sunset");
    expect(item.localPath.startsWith(`${fakeHome}/.kirie/media/`)).toBe(true);
    expect(item.localPath.endsWith(".png")).toBe(true);
    expect(existsSync(item.localPath)).toBe(true);
    expect(readFileSync(item.localPath).equals(PNG_BYTES)).toBe(true);
  });

  it("keeps successes and failures from the same message separate", async () => {
    const adapter = makeAdapter(async (m) => {
      if (m.type === "video") throw new Error(TOO_BIG_ERROR);
      return { buffer: PNG_BYTES, mimeType: "image/png", filename: "p.png" };
    });
    const { resolved, failed } = await downloadAndSaveMedia(
      [{ type: "photo", url: "p" }, video],
      adapter,
    );
    expect(resolved.map((r) => r.type)).toEqual(["photo"]);
    expect(failed.map((f) => f.type)).toEqual(["video"]);
  });
});

describe("wrapUserMessage with failed media", () => {
  const base: IncomingMessage = {
    id: "3360",
    channel: "telegram",
    senderName: "Mostafa",
    senderId: "6261124645",
    text: "",
    chatType: "dm",
    chatId: "6261124645",
  };

  it("renders a note for each attachment that could not be downloaded", () => {
    const prompt = wrapUserMessage({
      ...base,
      failedMedia: [{
        type: "video",
        filename: "IMG_4021.MOV",
        sizeBytes: 48 * 1024 * 1024,
        reason: "file is too big (Telegram bot limit 20 MB)",
        tooBig: true,
      }],
    });
    expect(prompt).toContain(
      "[📎 Video attached but could NOT be downloaded: file is too big (Telegram bot limit 20 MB). " +
        "File: IMG_4021.MOV, 48.0 MB.",
    );
    // The note sits inside the user message, not after it.
    expect(prompt.indexOf("could NOT be downloaded")).toBeLessThan(prompt.indexOf("</user_message>"));
  });

  it("leaves successfully downloaded media rendering unchanged", () => {
    const prompt = wrapUserMessage({
      ...base,
      text: "look",
      media: [{ localPath: "/tmp/x.png", type: "photo", mimeType: "image/png" }],
    });
    expect(prompt).toContain("[📎 Image attached: /tmp/x.png]");
    expect(prompt).toContain("(Use the Read tool to view attached images)");
    expect(prompt).not.toContain("could NOT be downloaded");
  });
});

describe("MessagePipeline media failures", () => {
  let pipeline: MessagePipeline;
  let engine: AgentEngine;

  function setup(adapter: ReturnType<typeof makeAdapter>) {
    const registry = {
      getAll: vi.fn(() => new Map([["telegram", adapter]])),
      getById: vi.fn(() => adapter),
      on: vi.fn(),
    } as unknown as ChannelRegistry;
    const gate = {
      check: vi.fn((): GateResult => ({
        passed: true,
        identity: { canonicalId: "u", senderId: "u", role: "owner" as const, channel: "telegram" },
        wrappedText: "",
      })),
    } as unknown as SecurityGate;
    engine = {
      execute: vi.fn(async (): Promise<ExecutionResult> => ({
        response: "ok", sessionId: "s", costUsd: 0, numTurns: 1, isError: false,
      })),
    } as unknown as AgentEngine;
    pipeline = new MessagePipeline({
      channelRegistry: registry,
      securityGate: gate,
      sessionStore: { get: vi.fn(() => null), set: vi.fn() } as unknown as SessionStore,
      agentEngine: engine,
      debounceMs: 0,
    });
    pipeline.start();
  }

  function mediaOnlyMessage(): UnifiedMessage {
    return {
      id: "3360",
      channel: "telegram" as ChannelName,
      senderName: "Mostafa",
      senderId: "u",
      text: "",
      chatType: "dm",
      chatId: "c",
      media: [video],
      timestamp: Date.now(),
      raw: {},
    } as UnifiedMessage;
  }

  afterEach(() => pipeline.stop());
  beforeEach(() => vi.clearAllMocks());

  it("passes failed attachments to the agent instead of an empty message", async () => {
    const adapter = makeAdapter(async () => { throw new Error(TOO_BIG_ERROR); });
    setup(adapter);
    adapter.listeners[0]!(mediaOnlyMessage());

    await vi.waitFor(() => expect(engine.execute).toHaveBeenCalled(), { timeout: 3000 });
    const incoming = (engine.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as IncomingMessage;
    expect(incoming.media).toEqual([]);
    expect(incoming.failedMedia).toHaveLength(1);
    expect(incoming.failedMedia![0]!.reason).toBe("file is too big (Telegram bot limit 20 MB)");
    expect(wrapUserMessage(incoming)).toContain("Video attached but could NOT be downloaded");
  });

  it("does not set failedMedia when every download succeeds", async () => {
    const adapter = makeAdapter(async () => ({
      buffer: PNG_BYTES, mimeType: "image/png", filename: "p.png",
    }));
    setup(adapter);
    adapter.listeners[0]!({ ...mediaOnlyMessage(), media: [{ type: "photo", url: "p" }] });

    await vi.waitFor(() => expect(engine.execute).toHaveBeenCalled(), { timeout: 3000 });
    const incoming = (engine.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as IncomingMessage;
    expect(incoming.failedMedia).toBeUndefined();
    expect(incoming.media).toHaveLength(1);
  });
});
