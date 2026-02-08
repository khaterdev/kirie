/**
 * WhatsApp auth - JID (Jabber ID) utilities and phone number normalization.
 *
 * WhatsApp JIDs follow the format: {phone}@s.whatsapp.net for individuals
 * and {groupId}@g.us for groups.
 */

/** The WhatsApp server suffix for individual chats */
const WA_USER_SUFFIX = "@s.whatsapp.net";
/** The WhatsApp server suffix for group chats */
const WA_GROUP_SUFFIX = "@g.us";

/**
 * Normalize a phone number by stripping all non-digit characters.
 * WhatsApp expects phone numbers in E.164 format without the leading "+".
 *
 * @param phone - Phone number in any common format
 * @returns Digits-only phone number
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

/**
 * Convert a phone number to a WhatsApp JID.
 *
 * @param phone - Phone number (will be normalized)
 * @returns JID in the format {phone}@s.whatsapp.net
 */
export function phoneToJid(phone: string): string {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error(`Invalid phone number: "${phone}"`);
  }
  return `${normalized}${WA_USER_SUFFIX}`;
}

/**
 * Extract the phone number from a WhatsApp JID.
 *
 * @param jid - WhatsApp JID
 * @returns The phone number portion, or the full JID if not a user JID
 */
export function jidToPhone(jid: string): string {
  if (jid.endsWith(WA_USER_SUFFIX)) {
    return jid.slice(0, -WA_USER_SUFFIX.length);
  }
  // For group JIDs or other formats, return as-is
  return jid.split("@")[0] ?? jid;
}

/**
 * Determine if a JID represents a group chat.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith(WA_GROUP_SUFFIX);
}

/**
 * Extract a stable chat ID from a JID.
 * For users: the phone number
 * For groups: the group ID (without suffix)
 */
export function jidToChatId(jid: string): string {
  return jid.split("@")[0] ?? jid;
}

/**
 * Normalize a JID by removing the `:device` suffix that Baileys sometimes adds.
 * For example: "1234567890:2@s.whatsapp.net" -> "1234567890@s.whatsapp.net"
 */
export function normalizeJid(jid: string): string {
  const [user, server] = jid.split("@");
  if (!user || !server) return jid;

  // Strip device suffix (e.g., ":2")
  const phone = user.split(":")[0];
  return `${phone}@${server}`;
}
