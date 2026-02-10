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
 * HTTP status codes that indicate a transient server error worth retrying.
 */
const TRANSIENT_HTTP_STATUS_CODES = new Set([500, 502, 503, 504, 429]);

/**
 * Check whether an error is a transient network error that should be retried.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Check Node.js-style error codes (ETIMEDOUT, ECONNREFUSED, etc.)
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_ERROR_CODES.has(code)) return true;

  // Check HTTP status code properties (used by fetch wrappers, Signal REST API, etc.)
  const errAny = err as Record<string, unknown>;
  const status = errAny.status ?? errAny.statusCode;
  if (typeof status === "number" && TRANSIENT_HTTP_STATUS_CODES.has(status)) return true;
  // Some libraries store numeric status as error.code (not a string POSIX code)
  if (typeof code === "number" && TRANSIENT_HTTP_STATUS_CODES.has(code)) return true;

  // Also match common network error messages (e.g. from Grammy/HTTP libraries)
  const msg = err.message.toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("network") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed") ||
    msg.includes("internal server error") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  );
}
