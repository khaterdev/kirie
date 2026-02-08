/**
 * DiscordAdapter - implements ChannelAdapter for Discord using discord.js.
 *
 * Supports:
 *   - Gateway WebSocket connection via discord.js Client
 *   - Text chunking at 2000 characters
 *   - Media sending (file attachments)
 *   - Message reactions (emoji)
 *   - Message editing
 *   - Typing indicators
 *   - Thread support
 */

import {
  AttachmentBuilder,
  type Client,
  type TextChannel,
  type DMChannel,
  type NewsChannel,
  type ThreadChannel,
} from "discord.js";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  ChannelState,
  SendTextParams,
  SendTypingParams,
  SendMediaParams,
  SendReactionParams,
  EditMessageParams,
  SentMessage,
  MessageListener,
  DownloadedMedia,
  UnifiedMedia,
} from "@kirie/core";
import { createBot, type DiscordBotConfig } from "./bot.js";
import { validateBotToken } from "./auth.js";

/** Channel types that support .send(), .sendTyping(), .messages.fetch() */
type SendableChannel = TextChannel | DMChannel | NewsChannel | ThreadChannel;

const MAX_TEXT_LENGTH = 2000;

/** Configuration for the Discord adapter */
export interface DiscordAdapterConfig {
  /** Bot token */
  token: string;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly capabilities: ChannelCapabilities = {
    sendMedia: true,
    sendReaction: true,
    editMessage: true,
    deleteMessage: false,
    sendTyping: true,
    threads: true,
    multipleImages: true,
    reactions: true,
    replyContext: true,
    voiceMessages: true,
    maxTextLength: MAX_TEXT_LENGTH,
  };

  private client: Client | null = null;
  private state: ChannelState = "disconnected";
  private connectedAt: number | undefined;
  private failureCount = 0;
  private lastError: string | undefined;
  private lastErrorAt: number | undefined;
  private readonly listeners: MessageListener[] = [];
  private readonly config: DiscordAdapterConfig;
  private botId: string | undefined;

  constructor(config: DiscordAdapterConfig) {
    this.config = config;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;

    this.state = "connecting";

    try {
      // Validate token and get bot info
      const botInfo = await validateBotToken(this.config.token);
      this.botId = botInfo.id;

      const botConfig: DiscordBotConfig = {
        token: this.config.token,
        botId: this.botId,
      };

      this.client = createBot(botConfig, this.listeners);

      // Login to Discord Gateway
      await this.client.login(this.config.token);

      // Listen for abort signal to stop the client
      signal.addEventListener(
        "abort",
        () => {
          void this.stop();
        },
        { once: true },
      );

      this.state = "connected";
      this.connectedAt = Date.now();
      this.failureCount = 0;
      this.lastError = undefined;
      this.lastErrorAt = undefined;
    } catch (err) {
      this.state = "error";
      this.failureCount++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastErrorAt = Date.now();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "disconnected") return;

    try {
      if (this.client) {
        this.client.destroy();
      }
    } finally {
      this.client = null;
      this.state = "disconnected";
      this.connectedAt = undefined;
    }
  }

  getStatus(): ChannelStatus {
    return {
      state: this.state,
      connectedAt: this.connectedAt,
      failureCount: this.failureCount,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  async sendText(params: SendTextParams): Promise<SentMessage[]> {
    const channel = await this.resolveChannel(params.ctx.chatId, params.ctx.threadId);
    const chunks = chunkText(params.text, MAX_TEXT_LENGTH);
    const results: SentMessage[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const sent = await channel.send({
        content: chunk,
        // Only reply to the original message on the first chunk
        ...(i === 0 && params.ctx.replyToId
          ? { reply: { messageReference: params.ctx.replyToId } }
          : {}),
      });

      results.push({
        id: sent.id,
        timestamp: sent.createdTimestamp,
      });
    }

    return results;
  }

  async sendTyping(params: SendTypingParams): Promise<void> {
    const channel = await this.resolveChannel(params.ctx.chatId, params.ctx.threadId);
    await channel.sendTyping();
  }

  async sendMedia(params: SendMediaParams): Promise<SentMessage> {
    const channel = await this.resolveChannel(
      params.ctx.chatId,
      params.ctx.threadId,
    );

    const attachment = new AttachmentBuilder(params.media.url, {
      name: params.media.filename,
      description: params.media.caption,
    });

    const sent = await channel.send({
      content: params.media.caption ?? undefined,
      files: [attachment],
      ...(params.ctx.replyToId
        ? { reply: { messageReference: params.ctx.replyToId } }
        : {}),
    });

    return {
      id: sent.id,
      timestamp: sent.createdTimestamp,
    };
  }

  async sendReaction(params: SendReactionParams): Promise<void> {
    const channel = await this.resolveChannel(
      params.ctx.chatId,
      params.ctx.threadId,
    );

    const message = await channel.messages.fetch(params.messageId);
    await message.react(params.emoji);
  }

  async editMessage(params: EditMessageParams): Promise<void> {
    const channel = await this.resolveChannel(
      params.ctx.chatId,
      params.ctx.threadId,
    );

    const message = await channel.messages.fetch(params.messageId);
    await message.edit(params.text);
  }

  /**
   * Resolve a Discord channel by ID, optionally fetching a thread.
   */
  private async resolveChannel(
    chatId: string,
    threadId?: string,
  ): Promise<SendableChannel> {
    this.ensureConnected();

    const targetId = threadId ?? chatId;
    const channel = await this.client!.channels.fetch(targetId);

    if (!channel || !("send" in channel)) {
      throw new Error(`Channel ${targetId} not found or is not text-based`);
    }

    return channel as SendableChannel;
  }

  async sendMediaBatch(params: { ctx: import("@kirie/core").ChannelContext; media: import("@kirie/core").UnifiedMedia[] }): Promise<SentMessage[]> {
    const channel = await this.resolveChannel(params.ctx.chatId, params.ctx.threadId);
    const { ctx, media } = params;

    // Build all attachments and send in a single message
    const attachments = media.map((m) => new AttachmentBuilder(m.url, {
      name: m.filename,
      description: m.caption,
    }));

    const sent = await channel.send({
      content: media[0]?.caption ?? undefined,
      files: attachments,
      ...(ctx.replyToId ? { reply: { messageReference: ctx.replyToId } } : {}),
    });

    return [{ id: sent.id, timestamp: sent.createdTimestamp }];
  }

  async downloadMedia(media: UnifiedMedia): Promise<DownloadedMedia> {
    // Discord URLs are direct CDN links — just fetch them
    const resp = await fetch(media.url);
    if (!resp.ok) throw new Error(`Failed to download Discord media: ${resp.statusText}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const filename = media.filename ?? `discord-${Date.now()}`;
    const mimeType = media.mimeType ?? resp.headers.get("content-type") ?? "application/octet-stream";

    return { buffer, mimeType, filename };
  }

  /**
   * Get the underlying discord.js Client instance.
   * Returns null if the adapter is not connected.
   */
  getClient(): Client | null {
    return this.client;
  }

  private ensureConnected(): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("Discord adapter is not connected");
    }
  }
}

/**
 * Split text into chunks that fit within the Discord message limit.
 * Tries to split on newlines or spaces to avoid breaking words.
 */
function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0 || splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
