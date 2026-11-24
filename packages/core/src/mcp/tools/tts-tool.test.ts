import { describe, it, expect, afterEach } from "vitest";
import { prepareTtsText } from "./tts-tool.js";
import { createScrubApp, createGatewayScrubber, setRemoteScrubber } from "../../security/remote-scrub.js";
import { SecretScrubber } from "../../security/secret-scrubber.js";

describe("TTS text is scrubbed before it leaves for a TTS service (SCRUB-N4)", () => {
  afterEach(() => setRemoteScrubber(null));
  const token = (): string => ["gh", "p_", "Zx8Cv7Bn6Mq5Wp4Ok3Ij2Uh1Yg0Tf9Rd8Es7Wa"].join("");

  it("removes pattern secrets and reads the marker as 'redacted'", async () => {
    expect(await prepareTtsText(`your key is ${token()} ok`)).toBe("your key is redacted ok");
    expect(await prepareTtsText("hello there")).toBe("hello there");
  });

  it("removes the daemon's known values in the tools subprocess", async () => {
    const KNOWN = ["9c1f", "0b7e", "44d2", "a8c3", "51e6", "f0d9", "2b74", "c6a1"].join("");
    const daemon = new SecretScrubber();
    daemon.addKnownSecret(KNOWN, "k");
    const app = createScrubApp({ scrubber: daemon, token: "t" });
    const fetchFn = (async (url: string, init: RequestInit) => app.request(new URL(url).pathname.replace(/^\/api\/scrub/, ""), init)) as unknown as typeof fetch;
    setRemoteScrubber(createGatewayScrubber("http://127.0.0.1:1", "t", { fetchFn }));
    expect(await prepareTtsText(`the code is ${KNOWN}`)).toBe("the code is redacted");
  });
});
