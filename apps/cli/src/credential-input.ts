/**
 * Value for `kirie credentials set <key> [value]`. When the value is omitted
 * it is typed with hidden input, so the secret never lands in shell history
 * (PLAN C.14: Twilio and Plivo tokens, the voice PIN).
 */

import { isCancel, password } from "@clack/prompts";

export type HiddenAsk = (message: string) => Promise<string | null>;

const defaultAsk: HiddenAsk = async (message) => {
  const v = await password({ message, mask: "•" });
  return isCancel(v) ? null : v;
};

export async function readCredentialValue(
  key: string,
  given: string | undefined,
  opts: { ask?: HiddenAsk; isTTY?: boolean } = {},
): Promise<{ value: string } | { error: string }> {
  if (given !== undefined && given.length > 0) return { value: given };
  const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY);
  if (!isTTY) return { error: "No value given and stdin is not a terminal. Run it in a terminal to type the value hidden." };
  const value = await (opts.ask ?? defaultAsk)(`Value for ${key} (input is hidden)`);
  if (value === null) return { error: "Cancelled." };
  if (value.trim().length === 0) return { error: "Empty value; nothing saved." };
  return { value };
}
