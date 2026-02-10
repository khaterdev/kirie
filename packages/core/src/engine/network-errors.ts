/**
 * Utility to detect transient network errors that should be retried.
 *
 * Used by the message pipeline and notification manager to decide whether
 * a failed send should be queued for retry via the HeartbeatService.
 */

/**
 * Network/transient error codes that warrant a retry rather than giving up.
 */
const TRANSIENT_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * Check whether an error is a transient network error that should be retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;
  // Also match common network error messages (e.g. from Grammy/HTTP libraries)
  const msg = err.message.toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed")
  );
}
