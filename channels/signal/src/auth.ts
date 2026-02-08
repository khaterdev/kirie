/**
 * Signal auth - phone number verification and sender identity helpers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalAccountInfo {
  /** The phone number registered with signal-cli */
  phoneNumber: string;
  /** Whether the account is registered */
  registered: boolean;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Verify that the specified phone number is registered on the signal-cli instance.
 *
 * @param apiUrl - Base URL of the signal-cli REST API
 * @param phoneNumber - Phone number to verify (e.g. "+1234567890")
 * @returns Account info if found
 * @throws If the phone number is not registered
 */
export async function verifyPhoneNumber(
  apiUrl: string,
  phoneNumber: string,
): Promise<SignalAccountInfo> {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  const res = await fetch(`${baseUrl}/v1/accounts`, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(
      `Failed to fetch Signal accounts: ${res.status} ${res.statusText}`,
    );
  }

  const accounts = (await res.json()) as string[];
  const normalized = normalizePhone(phoneNumber);
  const found = accounts.some(
    (acc) => normalizePhone(acc) === normalized,
  );

  if (!found) {
    throw new Error(
      `Phone number "${phoneNumber}" is not registered with signal-cli. ` +
      `Available accounts: ${accounts.join(", ") || "(none)"}`,
    );
  }

  return { phoneNumber: normalized, registered: true };
}

/**
 * Normalize a phone number by ensuring it starts with "+"
 * and stripping whitespace/dashes.
 */
export function normalizePhone(phone: string): string {
  const stripped = phone.replace(/[\s\-()]/g, "");
  if (!stripped.startsWith("+")) {
    return `+${stripped}`;
  }
  return stripped;
}

/**
 * Build a sender ID string from a Signal phone number.
 * This is the canonical format used across Kirie for Signal identities.
 */
export function makeSenderId(phoneNumber: string): string {
  return normalizePhone(phoneNumber);
}

/**
 * Build a human-readable display name from Signal sender info.
 * Signal provides a profile name if the sender has set one.
 */
export function makeDisplayName(
  sourceName: string | undefined,
  sourceNumber: string | undefined,
): string {
  if (sourceName && sourceName.trim()) {
    return sourceName.trim();
  }
  if (sourceNumber) {
    return sourceNumber;
  }
  return "Unknown";
}
