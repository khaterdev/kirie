/**
 * Baileys WebSocket client setup, auth state management, and QR code handling.
 *
 * Uses @whiskeysockets/baileys to maintain a persistent WhatsApp Web connection.
 * Auth state is persisted to disk so QR pairing only needs to happen once.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type ConnectionState,
  type proto,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { UnifiedMessage, MessageListener, ChatType, UnifiedMedia, MediaType } from "@kirie/core";
import { isGroupJid, jidToChatId, jidToPhone, normalizeJid } from "./auth.js";

/**
 * Configuration for the Baileys client.
 */
export interface BaileysClientConfig {
  /** Directory to store auth state. Defaults to ~/.kirie/whatsapp-auth/ */
  authDir?: string;
  /** QR code callback. Called with the QR string when pairing is needed. */
  onQr?: (qr: string) => void;
  /** Connection state change callback. */
  onConnectionUpdate?: (state: Partial<ConnectionState>) => void;
}

/** Default auth state directory */
const DEFAULT_AUTH_DIR = join(homedir(), ".kirie", "whatsapp-auth");

/**
 * Creates and configures a Baileys WASocket connection.
 *
 * @param config - Client configuration
 * @param listeners - Message listeners to invoke on incoming messages
 * @returns The connected WASocket and a cleanup function
 */
export async function createBaileysClient(
  config: BaileysClientConfig,
  listeners: MessageListener[],
): Promise<{ socket: WASocket; cleanup: () => void }> {
  const authDir = config.authDir ?? DEFAULT_AUTH_DIR;
  mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const socket = makeWASocket({
    auth: state,
    printQRInTerminal: !config.onQr,
    browser: ["Kirie", "Desktop", "1.0.0"],
  });

  // Persist auth state changes
  socket.ev.on("creds.update", saveCreds);

  // Handle connection updates
  socket.ev.on(
    "connection.update",
    (update: BaileysEventMap["connection.update"]) => {
      config.onConnectionUpdate?.(update);

      if (update.qr && config.onQr) {
        config.onQr(update.qr);
      }
    },
  );

  // Handle incoming messages
  socket.ev.on(
    "messages.upsert",
    (upsert: BaileysEventMap["messages.upsert"]) => {
      if (upsert.type !== "notify") return;

      for (const msg of upsert.messages) {
        // Skip status broadcast messages
        if (msg.key.remoteJid === "status@broadcast") continue;
        // Skip messages sent by us
        if (msg.key.fromMe) continue;

        const unified = normalizeMessage(msg);
        if (!unified) continue;

        for (const listener of listeners) {
          try {
            void Promise.resolve(listener(unified));
          } catch {
            // Swallow listener errors
          }
        }
      }
    },
  );

  // Handle incoming reactions
  socket.ev.on(
    "messages.reaction",
    (reactions: BaileysEventMap["messages.reaction"]) => {
      for (const reaction of reactions) {
        const remoteJid = reaction.key.remoteJid;
        if (!remoteJid) continue;
        // Skip our own reactions
        if (reaction.key.fromMe) continue;

        const reactionMsg = reaction.reaction;
        if (!reactionMsg) continue;

        const normalizedJid = normalizeJid(remoteJid);
        const senderJid = reaction.key.participant
          ? normalizeJid(reaction.key.participant)
          : normalizedJid;
        const isGroup = isGroupJid(normalizedJid);
        const chatId = jidToChatId(normalizedJid);

        const emoji = reactionMsg.text ?? "";
        const action = emoji ? "add" : "remove";

        const unified: UnifiedMessage = {
          id: `reaction-${reaction.key.id}-${Date.now()}`,
          channel: "whatsapp",
          senderId: jidToPhone(senderJid),
          senderName: jidToPhone(senderJid),
          text: "",
          chatType: isGroup ? "group" : "dm",
          chatId,
          reaction: {
            emoji: emoji || "",
            messageId: reactionMsg.key?.id ?? reaction.key.id ?? "",
            action,
          },
          timestamp: Date.now(),
          raw: reaction,
        };

        for (const listener of listeners) {
          try {
            void Promise.resolve(listener(unified));
          } catch {
            // Swallow listener errors
          }
        }
      }
    },
  );

  const cleanup = () => {
    socket.ev.removeAllListeners("creds.update");
    socket.ev.removeAllListeners("connection.update");
    socket.ev.removeAllListeners("messages.upsert");
    socket.ev.removeAllListeners("messages.reaction");
  };

  return { socket, cleanup };
}

/**
 * Check if a Baileys disconnect reason indicates we should reconnect.
 */
export function shouldReconnect(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true;
  // DisconnectReason.loggedOut means the session is invalidated
  return statusCode !== DisconnectReason.loggedOut;
}

/**
 * Normalize a Baileys WebMessageInfo into a UnifiedMessage.
 */
function normalizeMessage(
  msg: proto.IWebMessageInfo,
): UnifiedMessage | null {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid) return null;

  const normalizedJid = normalizeJid(remoteJid);
  const senderJid = msg.key.participant
    ? normalizeJid(msg.key.participant)
    : normalizedJid;

  const text = extractText(msg.message);
  const media = extractMedia(msg.message);

  // Skip empty messages
  if (!text && !media) return null;

  const isGroup = isGroupJid(normalizedJid);
  const chatType: ChatType = isGroup ? "group" : "dm";
  const chatId = jidToChatId(normalizedJid);

  // Extract rich reply context from contextInfo (available on multiple message types)
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo
    || msg.message?.imageMessage?.contextInfo
    || msg.message?.videoMessage?.contextInfo
    || msg.message?.audioMessage?.contextInfo
    || msg.message?.documentMessage?.contextInfo;

  let replyTo: UnifiedMessage["replyTo"];
  let replyToId: string | undefined;

  if (contextInfo?.stanzaId) {
    const quotedMsg = contextInfo.quotedMessage;
    let quotedText: string | undefined;
    if (quotedMsg) {
      quotedText = quotedMsg.conversation
        || quotedMsg.extendedTextMessage?.text
        || quotedMsg.imageMessage?.caption
        || quotedMsg.videoMessage?.caption
        || undefined;
    }
    const participant = contextInfo.participant;
    const quotedSenderId = participant?.split("@")[0];

    replyTo = {
      messageId: contextInfo.stanzaId,
      text: quotedText ? quotedText.slice(0, 500) : undefined,
      senderId: quotedSenderId,
      senderName: undefined, // WhatsApp doesn't provide display name in contextInfo
    };
    replyToId = contextInfo.stanzaId;
  }

  return {
    id: msg.key.id ?? `${Date.now()}`,
    channel: "whatsapp",
    senderId: jidToPhone(senderJid),
    senderName: msg.pushName ?? jidToPhone(senderJid),
    text: text ?? "",
    chatType,
    chatId,
    threadId: undefined,
    replyToId,
    replyTo,
    media: media ? [media] : undefined,
    timestamp: (msg.messageTimestamp as number) * 1000 || Date.now(),
    raw: msg,
  };
}

/**
 * Extract text content from a Baileys message.
 */
function extractText(
  message: proto.IMessage | null | undefined,
): string | null {
  if (!message) return null;

  // Regular text message
  if (message.conversation) return message.conversation;

  // Extended text (with URL preview, reply context, etc.)
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;

  // Image/video/document captions
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  if (message.documentMessage?.caption) return message.documentMessage.caption;

  return null;
}

/**
 * Extract media from a Baileys message.
 */
function extractMedia(
  message: proto.IMessage | null | undefined,
): UnifiedMedia | null {
  if (!message) return null;

  if (message.imageMessage) {
    return {
      type: "photo",
      url: message.imageMessage.url ?? "",
      mimeType: message.imageMessage.mimetype ?? undefined,
      sizeBytes: message.imageMessage.fileLength
        ? Number(message.imageMessage.fileLength)
        : undefined,
      caption: message.imageMessage.caption ?? undefined,
    };
  }

  if (message.videoMessage) {
    return {
      type: "video",
      url: message.videoMessage.url ?? "",
      mimeType: message.videoMessage.mimetype ?? undefined,
      sizeBytes: message.videoMessage.fileLength
        ? Number(message.videoMessage.fileLength)
        : undefined,
      caption: message.videoMessage.caption ?? undefined,
    };
  }

  if (message.audioMessage) {
    const type: MediaType = message.audioMessage.ptt ? "voice" : "audio";
    return {
      type,
      url: message.audioMessage.url ?? "",
      mimeType: message.audioMessage.mimetype ?? undefined,
      sizeBytes: message.audioMessage.fileLength
        ? Number(message.audioMessage.fileLength)
        : undefined,
    };
  }

  if (message.documentMessage) {
    return {
      type: "document",
      url: message.documentMessage.url ?? "",
      filename: message.documentMessage.fileName ?? undefined,
      mimeType: message.documentMessage.mimetype ?? undefined,
      sizeBytes: message.documentMessage.fileLength
        ? Number(message.documentMessage.fileLength)
        : undefined,
      caption: message.documentMessage.caption ?? undefined,
    };
  }

  if (message.stickerMessage) {
    return {
      type: "sticker",
      url: message.stickerMessage.url ?? "",
      mimeType: message.stickerMessage.mimetype ?? undefined,
      sizeBytes: message.stickerMessage.fileLength
        ? Number(message.stickerMessage.fileLength)
        : undefined,
    };
  }

  return null;
}
