import type { MediaKind } from "./types.js";

/** Default per-kind size caps in bytes */
export const DEFAULT_SIZE_CAPS: Record<MediaKind, number> = {
  image: 6 * 1024 * 1024,      // 6MB
  audio: 16 * 1024 * 1024,     // 16MB
  video: 16 * 1024 * 1024,     // 16MB
  document: 100 * 1024 * 1024, // 100MB
  unknown: 10 * 1024 * 1024,   // 10MB
};

/**
 * Check whether `sizeBytes` is within the cap for the given media kind.
 * Returns `true` if the size is within the limit, `false` if it exceeds.
 */
export function checkSizeCap(
  kind: MediaKind,
  sizeBytes: number,
  caps?: Partial<Record<MediaKind, number>>,
): boolean {
  const limit = caps?.[kind] ?? DEFAULT_SIZE_CAPS[kind];
  return sizeBytes <= limit;
}
