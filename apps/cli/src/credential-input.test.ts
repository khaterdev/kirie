import { describe, it, expect, vi } from "vitest";
import { readCredentialValue } from "./credential-input.js";

describe("readCredentialValue", () => {
  it("uses a value given on the command line without prompting", async () => {
    const ask = vi.fn();
    expect(await readCredentialValue("twilio.auth_token", "given-value", { ask, isTTY: true })).toEqual({ value: "given-value" });
    expect(ask).not.toHaveBeenCalled();
  });

  it("prompts with hidden input when the value is omitted", async () => {
    const ask = vi.fn(async () => "typed-hidden-value");
    expect(await readCredentialValue("plivo.auth_token", undefined, { ask, isTTY: true })).toEqual({ value: "typed-hidden-value" });
    expect(ask).toHaveBeenCalledWith("Value for plivo.auth_token (input is hidden)");
  });

  it("refuses without a terminal, on cancel, and on an empty value", async () => {
    expect(await readCredentialValue("voice.pin", undefined, { ask: vi.fn(), isTTY: false })).toHaveProperty("error");
    expect(await readCredentialValue("voice.pin", undefined, { ask: async () => null, isTTY: true })).toEqual({ error: "Cancelled." });
    expect(await readCredentialValue("voice.pin", undefined, { ask: async () => "  ", isTTY: true })).toHaveProperty("error");
  });
});
