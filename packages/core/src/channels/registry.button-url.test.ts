import { describe, it, expect, beforeEach } from "vitest";
import { ChannelRegistry } from "./registry.js";
import { resetScrubberForTesting } from "../security/secret-scrubber.js";
import type { ChannelAdapter, SendInteractiveParams } from "./adapter.js";
import type { ChannelName } from "./normalizer.js";

describe("ChannelRegistry outbound proxy: button urls", () => {
  beforeEach(() => resetScrubberForTesting());

  it("scrubs a secret in a link button's url and leaves a clean url alone", async () => {
    const token = ["gh", "p_", "Zx8Cv7Bn6Mq5Wp4Ok3Ij2Uh1Yg0Tf9Rd8Es7Wa"].join("");
    const seen: SendInteractiveParams[] = [];
    const adapter = {
      id: "telegram" as ChannelName,
      capabilities: { maxTextLength: 4000 },
      async start() {},
      async stop() {},
      getStatus: () => ({ state: "connected", failureCount: 0 }),
      onMessage() {},
      async sendText() { return []; },
      async sendTyping() {},
      async sendInteractive(p: SendInteractiveParams) { seen.push(p); return { id: "1", timestamp: 0 }; },
    } as unknown as ChannelAdapter;
    const registry = new ChannelRegistry();
    registry.register(adapter);
    await registry.getById("telegram")!.sendInteractive!({
      ctx: { chatId: "42" },
      text: "links",
      buttons: [[
        { label: "Open", url: `https://example.com/cb?token=${token}` },
        { label: "Docs", url: "https://example.com/docs" },
      ]],
    });
    const [leaked, clean] = seen[0]!.buttons[0]!;
    expect(leaked!.url).not.toContain(token);
    expect(leaked!.url).toContain("«redacted:");
    expect(clean!.url).toBe("https://example.com/docs");
  });
});
