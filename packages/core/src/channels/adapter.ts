/**
 * ChannelAdapter - abstract interface that every channel must implement.
 * Provides a uniform contract for lifecycle management and message I/O.
 */

import type { ChannelName, MessageListener, MediaType, UnifiedMedia } from "./normalizer.js";

// ---------------------------------------------------------------------------
// Capability flags
// ---------------------------------------------------------------------------

/** Declares what a channel adapter supports */
export interface ChannelCapabilities {
  /** Can send media attachments */
  readonly sendMedia: boolean;
  /** Can add reactions/emoji to messages */
  readonly sendReaction: boolean;
  /** Can edit previously sent messages */
  readonly editMessage: boolean;
  /** Can delete previously sent messages */
  readonly deleteMessage: boolean;
  /** Can send typing indicators */
  readonly sendTyping: boolean;
  /** Can operate in threads */
  readonly threads: boolean;
  /** Can send multiple images in a single message (media group) */
  readonly multipleImages: boolean;
  /** Can add/receive emoji reactions */
  readonly reactions: boolean;
  /** Can include reply context (quoted message) */
  readonly replyContext: boolean;
  /** Can send/receive voice messages */
  readonly voiceMessages: boolean;
  /** Maximum text length before chunking (0 = unlimited) */
  readonly maxTextLength: number;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Runtime status of a channel adapter */
export type ChannelState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface ChannelStatus {
  /** Current connection state */
  readonly state: ChannelState;
  /** When the adapter last connected successfully (ms epoch) */
  readonly connectedAt?: number;
  /** Consecutive failure count */
  readonly failureCount: number;
  /** Last error message, if any */
  readonly lastError?: string;
  /** Last error timestamp (ms epoch) */
  readonly lastErrorAt?: number;
}

// ---------------------------------------------------------------------------
// Operation parameter types
// ---------------------------------------------------------------------------

/** Context for addressing a reply */
export interface ChannelContext {
  /** Chat/conversation to target */
  readonly chatId: string;
  /** Thread to reply in, if applicable */
  readonly threadId?: string;
  /** Message to reply to, if applicable */
  readonly replyToId?: string;
}

/** Parameters for sending a text message */
export interface SendTextParams {
  readonly ctx: ChannelContext;
  readonly text: string;
}

/** Parameters for sending a typing indicator */
export interface SendTypingParams {
  readonly ctx: ChannelContext;
  /** Duration in milliseconds to show typing (adapter may clamp) */
  readonly durationMs?: number;
}

/** Parameters for sending a media attachment */
export interface SendMediaParams {
  readonly ctx: ChannelContext;
  readonly media: UnifiedMedia;
}

/** Parameters for adding a reaction */
export interface SendReactionParams {
  readonly ctx: ChannelContext;
  /** ID of the message to react to */
  readonly messageId: string;
  /** Emoji string (unicode or platform-specific) */
  readonly emoji: string;
}

/** Parameters for editing a previously sent message */
export interface EditMessageParams {
  readonly ctx: ChannelContext;
  /** ID of the message to edit */
  readonly messageId: string;
  /** New text content */
  readonly text: string;
}

/** Result of downloading a media file from a channel */
export interface DownloadedMedia {
  /** Raw file data */
  readonly buffer: Buffer;
  /** MIME type of the downloaded file */
  readonly mimeType: string;
  /** Suggested filename */
  readonly filename: string;
}

/** A resolved media item with a local file path */
export interface ResolvedMedia {
  /** Absolute path to the file on disk */
  readonly localPath: string;
  /** Media type */
  readonly type: MediaType;
  /** MIME type */
  readonly mimeType: string;
  /** Caption from the original message */
  readonly caption?: string;
  /** Original filename */
  readonly filename?: string;
  /** Transcription text (for audio/voice media, if auto-transcription is enabled) */
  readonly transcript?: string;
}

/** A sent message receipt */
export interface SentMessage {
  /** Platform-assigned message ID */
  readonly id: string;
  /** Timestamp of the sent message (ms epoch) */
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * The core contract every channel adapter must fulfill.
 *
 * Lifecycle:
 *   1. Construct with config
 *   2. Call `onMessage(listener)` to register message handler
 *   3. Call `start(signal)` to connect
 *   4. Use `sendText`, `sendTyping`, etc. to send outbound messages
 *   5. Call `stop()` to disconnect gracefully
 */
export interface ChannelAdapter {
  /** Unique identifier for this adapter instance (e.g. "telegram", "discord") */
  readonly id: ChannelName;

  /** Capability flags for this channel */
  readonly capabilities: ChannelCapabilities;

  /**
   * Start the adapter (connect to the platform).
   * @param signal - AbortSignal for cooperative cancellation
   */
  start(signal: AbortSignal): Promise<void>;

  /** Stop the adapter gracefully, releasing resources. */
  stop(): Promise<void>;

  /** Return the current connection status. */
  getStatus(): ChannelStatus;

  /**
   * Register a listener for inbound messages.
   * Multiple listeners may be registered; all will be called.
   */
  onMessage(listener: MessageListener): void;

  /**
   * Send a text message. Long texts should be chunked according to
   * `capabilities.maxTextLength`.
   * @returns Receipt(s) for each chunk sent
   */
  sendText(params: SendTextParams): Promise<SentMessage[]>;

  /**
   * Show a typing indicator in the target chat.
   */
  sendTyping(params: SendTypingParams): Promise<void>;

  // --- Optional capabilities (check `capabilities` before calling) ---

  /**
   * Send a media attachment.
   * Only available if `capabilities.sendMedia` is true.
   */
  sendMedia?(params: SendMediaParams): Promise<SentMessage>;

  /**
   * Add a reaction to a message.
   * Only available if `capabilities.sendReaction` is true.
   */
  sendReaction?(params: SendReactionParams): Promise<void>;

  /**
   * Edit a previously sent message.
   * Only available if `capabilities.editMessage` is true.
   */
  editMessage?(params: EditMessageParams): Promise<void>;

  /**
   * Delete a previously sent message.
   * Only available if `capabilities.deleteMessage` is true.
   */
  deleteMessage?(params: { ctx: ChannelContext; messageId: string }): Promise<void>;

  /**
   * Download a media file from the channel platform.
   * Each channel has platform-specific download logic (e.g. Telegram file_id, Slack auth headers).
   * Default behavior: HTTP fetch from media.url.
   */
  downloadMedia?(media: UnifiedMedia): Promise<DownloadedMedia>;

  /**
   * Send multiple media items in a single message (media group).
   * Only available if `capabilities.multipleImages` is true.
   * Falls back to sequential sendMedia() calls if not implemented.
   */
  sendMediaBatch?(params: { ctx: ChannelContext; media: UnifiedMedia[] }): Promise<SentMessage[]>;

  /**
   * Register slash commands with the platform (e.g. Telegram's setMyCommands).
   * Called after startup with the list of available commands.
   */
  registerCommands?(commands: Array<{ command: string; description: string }>): Promise<void>;
}
