/**
 * Unified message format for cross-channel normalization.
 * All channel adapters convert their native message types into UnifiedMessage.
 */

/** Supported media types */
export type MediaType = "photo" | "video" | "audio" | "voice" | "document" | "sticker" | "animation";

/** Media attachment within a unified message */
export interface UnifiedMedia {
  /** Type of media */
  readonly type: MediaType;
  /** URL or file path to the media */
  readonly url: string;
  /** Original filename if available */
  readonly filename?: string;
  /** MIME type if known */
  readonly mimeType?: string;
  /** File size in bytes if known */
  readonly sizeBytes?: number;
  /** Caption or alt text */
  readonly caption?: string;
}

/** Chat context type */
export type ChatType = "dm" | "group" | "thread";

/** Channel identifier used across the system */
export type ChannelName = "telegram" | "discord" | "slack" | "whatsapp" | "signal" | string;

/**
 * The canonical message format used throughout Kirie.
 * Every inbound message from any channel is normalized to this shape
 * before being passed to the security gate and agent engine.
 */
export interface UnifiedMessage {
  /** Unique message ID (channel-specific format) */
  readonly id: string;
  /** Which channel this message originated from */
  readonly channel: ChannelName;
  /** Platform-specific sender ID */
  readonly senderId: string;
  /** Human-readable sender name */
  readonly senderName: string;
  /** Text content of the message (may be empty if media-only) */
  readonly text: string;
  /** Whether this is a DM, group chat, or thread */
  readonly chatType: ChatType;
  /** Chat/conversation ID */
  readonly chatId: string;
  /** Thread ID if the message is part of a thread */
  readonly threadId?: string;
  /** ID of the message being replied to, if this is a reply */
  readonly replyToId?: string;
  /** Attached media items */
  readonly media?: readonly UnifiedMedia[];
  /** Unix timestamp in milliseconds */
  readonly timestamp: number;
  /** Rich reply context (includes text/sender info from the replied-to message) */
  readonly replyTo?: {
    readonly messageId: string;
    readonly text?: string;
    readonly senderId?: string;
    readonly senderName?: string;
  };
  /** Whether this message is an edit of a previously sent message */
  readonly isEdited?: boolean;
  /** Reaction event (add or remove an emoji on a message) */
  readonly reaction?: {
    readonly emoji: string;
    readonly messageId: string;
    readonly action: "add" | "remove";
  };
  /** Original platform-specific message object for passthrough */
  readonly raw: unknown;
}

/**
 * Listener callback type for incoming messages.
 * Channel adapters emit UnifiedMessage instances to registered listeners.
 */
export type MessageListener = (message: UnifiedMessage) => void | Promise<void>;
