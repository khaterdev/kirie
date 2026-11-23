/**
 * Error for a failed provider REST call. The message names the provider, the
 * operation and the HTTP status, plus the provider's numeric error code when
 * it sent one. It never contains credentials, URLs with ids, or response
 * bodies, so it is safe to log and to show the owner.
 */
export class VoiceProviderHttpError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly providerCode?: string;

  constructor(provider: string, operation: string, status: number, providerCode?: string) {
    super(`${provider} ${operation} failed: HTTP ${status}${providerCode ? ` (provider code ${providerCode})` : ""}`);
    this.name = "VoiceProviderHttpError";
    this.provider = provider;
    this.status = status;
    if (providerCode) this.providerCode = providerCode;
  }
}

/** Read a numeric `code` field from a JSON error body, if any. Never throws. */
export async function readProviderCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "code" in body) {
      const code = (body as { code: unknown }).code;
      if (typeof code === "number" || (typeof code === "string" && /^\d{1,8}$/.test(code))) return String(code);
    }
  } catch {
    // Not JSON: no code.
  }
  return undefined;
}

/** Rejects ids that could change the request path. */
export function assertSafeId(kind: string, id: string): void {
  if (typeof id !== "string" || id.trim().length === 0) throw new Error(`${kind} is empty`);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error(`${kind} has an invalid format`);
}
