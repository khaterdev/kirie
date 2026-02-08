/**
 * Chat type for session key generation.
 */
export type ChatType = "dm" | "group" | "thread";

/**
 * Components that make up a session key.
 */
export interface SessionKeyParts {
  /** Channel identifier (e.g. "telegram", "discord") */
  channel: string;
  /** Chat type */
  chatType: ChatType;
  /** Platform-specific chat/conversation ID */
  chatId: string;
}

/**
 * Session key separator. Using colon as it's a standard key separator
 * and none of the component values should contain colons.
 */
const SEPARATOR = ":";

/**
 * Generates a session key from its component parts.
 *
 * Session keys follow the pattern: {channel}:{chatType}:{chatId}
 *
 * Examples:
 *   telegram:dm:12345
 *   discord:group:987654321
 *   slack:thread:C04ABCDEF
 *
 * @param parts - The channel, chat type, and chat ID
 * @returns The composed session key string
 */
export function makeSessionKey(parts: SessionKeyParts): string {
  const { channel, chatType, chatId } = parts;

  if (!channel || !chatType || !chatId) {
    throw new Error(
      `Invalid session key parts: channel="${channel}", chatType="${chatType}", chatId="${chatId}"`,
    );
  }

  return [channel, chatType, chatId].join(SEPARATOR);
}

/**
 * Parses a session key back into its component parts.
 *
 * @param key - A session key string in the format {channel}:{chatType}:{chatId}
 * @returns The parsed session key parts, or null if the key is malformed
 */
export function parseSessionKey(key: string): SessionKeyParts | null {
  const parts = key.split(SEPARATOR);

  if (parts.length < 3) {
    return null;
  }

  const channel = parts[0];
  const chatType = parts[1];
  // Join remaining parts in case chatId contains colons
  const chatId = parts.slice(2).join(SEPARATOR);

  if (!channel || !isValidChatType(chatType) || !chatId) {
    return null;
  }

  return { channel, chatType, chatId };
}

/**
 * Type guard for valid chat types.
 */
function isValidChatType(value: string | undefined): value is ChatType {
  return value === "dm" || value === "group" || value === "thread";
}

/**
 * Extracts the channel name from a session key without full parsing.
 *
 * @param key - A session key string
 * @returns The channel name, or null if the key is malformed
 */
export function channelFromKey(key: string): string | null {
  const idx = key.indexOf(SEPARATOR);
  if (idx <= 0) return null;
  return key.substring(0, idx);
}

/**
 * Generates a topic-aware session key.
 *
 * When a topicId is provided, the key follows the pattern:
 *   {channel}:{chatType}:{chatId}:topic:{topicId}
 *
 * Without a topicId, falls back to the standard session key format.
 *
 * @param channel - Channel identifier
 * @param chatType - Chat type (dm, group, thread)
 * @param chatId - Platform-specific chat ID
 * @param topicId - Optional topic/thread ID within the chat
 * @returns The composed session key string
 */
export function makeTopicSessionKey(
  channel: string,
  chatType: ChatType,
  chatId: string,
  topicId?: string,
): string {
  if (topicId) {
    return `${channel}${SEPARATOR}${chatType}${SEPARATOR}${chatId}${SEPARATOR}topic${SEPARATOR}${topicId}`;
  }
  return makeSessionKey({ channel, chatType, chatId });
}
