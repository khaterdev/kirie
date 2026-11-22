/**
 * Helpers for describing inbound media that could not be downloaded.
 *
 * When a download fails (file too big for the platform's bot API, network
 * error, size cap, ...) the attachment must still be visible to the agent.
 * Otherwise a media-only message arrives as an empty user message and the
 * agent has no idea anything was sent.
 */

import type { ChannelName, MediaType, UnifiedMedia } from "./normalizer.js";
import type { FailedMedia } from "./adapter.js";

/** Telegram's cloud Bot API refuses getFile for files larger than this. */
export const TELEGRAM_CLOUD_DOWNLOAD_LIMIT_MB = 20;

const TOO_BIG_PATTERN = /file is too big|too large|exceeds .*size|payload too large|\b413\b/i;

/** Human-readable label for a media type, e.g. "Video", "Voice message". */
export function mediaTypeLabel(type: MediaType): string {
  switch (type) {
    case "photo": return "Image";
    case "video": return "Video";
    case "audio": return "Audio";
    case "voice": return "Voice message";
    case "document": return "Document";
    case "sticker": return "Sticker";
    case "animation": return "Animation";
    default: return "File";
  }
}

/** Format a byte count as a short human-readable size ("48.3 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Turn a download error into a short reason string and a too-big flag.
 */
export function describeMediaDownloadError(
  err: unknown,
  channel?: ChannelName,
): { reason: string; tooBig: boolean } {
  const message = err instanceof Error ? err.message : String(err);
  if (TOO_BIG_PATTERN.test(message)) {
    // Adapters may name their limit, e.g. "file is too big (Telegram bot limit 20 MB)".
    const statedLimit = /\(([^()]*limit[^()]*)\)/i.exec(message)?.[1];
    if (statedLimit) return { reason: `file is too big (${statedLimit})`, tooBig: true };
    const reason = channel === "telegram"
      ? `file is too big (Telegram bot limit ${TELEGRAM_CLOUD_DOWNLOAD_LIMIT_MB} MB)`
      : "file is too big for the platform's bot download limit";
    return { reason, tooBig: true };
  }
  // Keep the raw error short: it ends up in the prompt.
  const trimmed = message.replace(/\s+/g, " ").trim().slice(0, 200);
  return { reason: trimmed ? `download failed: ${trimmed}` : "download failed", tooBig: false };
}

/** Build a FailedMedia record from the original attachment and its error. */
export function toFailedMedia(
  media: UnifiedMedia,
  reason: string,
  tooBig: boolean,
): FailedMedia {
  return {
    type: media.type,
    filename: media.filename,
    mimeType: media.mimeType,
    sizeBytes: media.sizeBytes,
    caption: media.caption,
    reason,
    tooBig,
  };
}

/**
 * Render the note the agent sees in place of an attachment it can't open.
 *
 * Example:
 *   [📎 Video attached but could NOT be downloaded: file is too big (Telegram
 *   bot limit 20 MB). File: clip.mp4, 48.3 MB. Tell the sender it didn't come
 *   through and ask them to send it compressed or another way (e.g. AirDrop,
 *   a cloud link).]
 */
export function formatFailedMediaNote(failed: FailedMedia): string {
  const label = mediaTypeLabel(failed.type);
  const details: string[] = [];
  if (failed.filename) details.push(failed.filename);
  if (failed.sizeBytes !== undefined) details.push(formatBytes(failed.sizeBytes));
  const detailText = details.length > 0 ? ` File: ${details.join(", ")}.` : "";
  const captionText = failed.caption ? ` Caption: "${failed.caption}".` : "";
  const advice = failed.tooBig
    ? "Tell the sender it didn't come through and ask them to send it compressed or another way (e.g. AirDrop, a cloud link)."
    : "Tell the sender it didn't come through and ask them to resend it.";
  return `[📎 ${label} attached but could NOT be downloaded: ${failed.reason}.${detailText}${captionText} ${advice}]`;
}
