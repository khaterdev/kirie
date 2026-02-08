import { fileTypeFromBuffer } from "file-type";
import type { MediaKind } from "./types.js";

/** Extension-to-MIME fallback map for common types */
const EXT_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

/**
 * Derive a MediaKind from a MIME type string.
 */
export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    mime.startsWith("application/") ||
    mime.startsWith("text/")
  ) {
    return "document";
  }
  return "unknown";
}

/**
 * Detect the MIME type of a buffer using magic-byte detection (file-type)
 * with a filename-extension fallback.
 */
export async function detectMimeType(
  buffer: Buffer,
  filename?: string,
): Promise<{ mime: string; kind: MediaKind }> {
  // Try magic-byte detection first
  const detected = await fileTypeFromBuffer(buffer);
  if (detected) {
    return { mime: detected.mime, kind: kindFromMime(detected.mime) };
  }

  // Fall back to extension-based lookup
  if (filename) {
    const dotIdx = filename.lastIndexOf(".");
    if (dotIdx !== -1) {
      const ext = filename.slice(dotIdx).toLowerCase();
      const mime = EXT_MIME_MAP[ext];
      if (mime) {
        return { mime, kind: kindFromMime(mime) };
      }
    }
  }

  return { mime: "application/octet-stream", kind: "unknown" };
}
