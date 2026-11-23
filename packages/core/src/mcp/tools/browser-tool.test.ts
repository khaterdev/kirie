import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrowserToolHandlers,
  pngDimensions,
  pruneBrowserScreenshots,
  PLAYWRIGHT_VERSION,
  type PlaywrightModule,
  type PlaywrightPage,
} from "./browser-tool.js";

/** A 1x1 PNG header followed by junk: enough for the IHDR read. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

interface FakePageState {
  url: string;
  clickNavigatesTo?: string;
  evaluateNavigatesTo?: string;
  evaluateThrows?: boolean;
}

function fakePage(state: FakePageState, opts: { modern?: boolean; legacy?: boolean } = { modern: true }): PlaywrightPage & { goto: ReturnType<typeof vi.fn> } {
  const page = {
    goto: vi.fn(async (url: string) => { state.url = url; }),
    content: async () => "<html></html>",
    title: async () => "Example",
    url: () => state.url,
    screenshot: vi.fn(async () => fakePng(1280, 720)),
    click: vi.fn(async () => { if (state.clickNavigatesTo) state.url = state.clickNavigatesTo; }),
    fill: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      if (state.evaluateNavigatesTo) state.url = state.evaluateNavigatesTo;
      if (state.evaluateThrows) throw new Error("Execution context was destroyed");
      return 42;
    }) as PlaywrightPage["evaluate"],
    close: async () => {},
    waitForLoadState: async () => {},
    ...(opts.modern ? { locator: vi.fn(() => ({ ariaSnapshot: async () => "- heading \"Example\" [level=1]" })) } : {}),
    ...(opts.legacy ? { accessibility: { snapshot: async () => ({ role: "WebArea", name: "Example" }) } } : {}),
  };
  return page as unknown as PlaywrightPage & { goto: ReturnType<typeof vi.fn> };
}

function fakePlaywright(page: PlaywrightPage): PlaywrightModule {
  const context = { pages: () => [page], newPage: async () => page, close: async () => {} };
  const browser = { close: vi.fn(async () => {}), contexts: () => [context], newContext: async () => context };
  return { chromium: { launch: vi.fn(async () => browser) } };
}

/** An SSRF guard that blocks one host, like the real one blocks private ranges. */
const guard = {
  validateAsync: vi.fn(async (url: string) => {
    if (new URL(url).hostname === "169.254.169.254") throw new Error("SSRF blocked: private address");
  }),
};

describe("browser tool", () => {
  let dir: string;
  let shots: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kirie-browser-"));
    shots = join(dir, "media", "screenshots");
    guard.validateAsync.mockClear();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function tool(page: PlaywrightPage, loaded = true) {
    return createBrowserToolHandlers({
      loadPlaywright: async () => (loaded ? fakePlaywright(page) : null),
      screenshotDir: shots,
      ssrfGuard: guard,
    }).browser;
  }

  it("snapshot uses ariaSnapshot (page.accessibility no longer exists)", async () => {
    const page = fakePage({ url: "https://example.com/" });
    const res = await tool(page).handler({ action: "snapshot" });
    expect(res.status).toBe("snapshot");
    expect(res.format).toBe("aria-yaml");
    expect(res.snapshot).toContain("heading");
    expect(page.locator).toHaveBeenCalledWith("body");
  });

  it("snapshot falls back to page.accessibility on an old install, else reports an error", async () => {
    const legacy = await tool(fakePage({ url: "https://example.com/" }, { legacy: true })).handler({ action: "snapshot" });
    expect(legacy.format).toBe("accessibility-tree");
    const neither = await tool(fakePage({ url: "https://example.com/" }, {})).handler({ action: "snapshot" });
    expect(neither.error).toMatch(/neither/);
  });

  it("screenshot writes a 0600 file in a 0700 dir and returns its path, never base64", async () => {
    const page = fakePage({ url: "https://example.com/" });
    const res = await tool(page).handler({ action: "screenshot" });
    expect(res.status).toBe("screenshot");
    expect(res.width).toBe(1280);
    expect(res.height).toBe(720);
    expect(res).not.toHaveProperty("image");
    expect(JSON.stringify(res)).not.toMatch(/iVBOR/);
    const path = res.path as string;
    expect(path.startsWith(shots)).toBe(true);
    expect(path).toMatch(/browser-[0-9a-f-]{36}\.png$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(shots).mode & 0o777).toBe(0o700);
  });

  it("screenshot prunes this tool's files older than 24 h and nothing else", async () => {
    mkdirSync(shots, { recursive: true });
    const old = join(shots, "browser-00000000-0000-4000-8000-000000000000.png");
    const fresh = join(shots, "browser-11111111-1111-4111-8111-111111111111.png");
    const other = join(shots, "notes.png");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    utimesSync(other, dayAgo, dayAgo);
    await tool(fakePage({ url: "https://example.com/" })).handler({ action: "screenshot" });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(readdirSync(shots).length).toBe(3);
  });

  it("pruneBrowserScreenshots tolerates a missing directory", () => {
    expect(pruneBrowserScreenshots(join(dir, "missing"), Date.now())).toBe(0);
  });

  it("re-runs the SSRF check after a click that navigated and blanks the page", async () => {
    const state: FakePageState = { url: "https://example.com/", clickNavigatesTo: "http://169.254.169.254/latest/meta-data" };
    const page = fakePage(state);
    const res = await tool(page).handler({ action: "click", selector: "a" });
    expect(res.error).toMatch(/SSRF blocked/);
    expect(page.goto).toHaveBeenCalledWith("about:blank");
    expect(state.url).toBe("about:blank");
  });

  it("re-runs the SSRF check after evaluate", async () => {
    const state: FakePageState = { url: "https://example.com/", evaluateNavigatesTo: "http://169.254.169.254/" };
    const page = fakePage(state);
    const res = await tool(page).handler({ action: "evaluate", text: "location.href='x'" });
    expect(res.error).toMatch(/SSRF blocked/);
    expect(res).not.toHaveProperty("result");
    expect(state.url).toBe("about:blank");
  });

  it("re-checks even when evaluate throws because the navigation destroyed its context", async () => {
    const state: FakePageState = { url: "https://example.com/", evaluateNavigatesTo: "http://169.254.169.254/", evaluateThrows: true };
    const res = await tool(fakePage(state)).handler({ action: "evaluate", text: "location='x'" });
    expect(res.error).toMatch(/SSRF blocked/);
    expect(state.url).toBe("about:blank");
  });

  it("snapshot and screenshot re-check a page that moved on its own", async () => {
    const state: FakePageState = { url: "http://169.254.169.254/" };
    const snap = await tool(fakePage(state)).handler({ action: "snapshot" });
    expect(snap.error).toMatch(/SSRF blocked/);
    state.url = "http://169.254.169.254/";
    const shot = await tool(fakePage(state)).handler({ action: "screenshot" });
    expect(shot.error).toMatch(/SSRF blocked/);
    expect(shot).not.toHaveProperty("path");
  });

  it("a click that stays on a safe page passes", async () => {
    const res = await tool(fakePage({ url: "https://example.com/" })).handler({ action: "click", selector: "button" });
    expect(res.status).toBe("clicked");
    expect(guard.validateAsync).toHaveBeenCalledWith("https://example.com/");
  });

  it("no check is needed while the page is about:blank", async () => {
    const res = await tool(fakePage({ url: "about:blank" })).handler({ action: "evaluate", text: "1+1" });
    expect(res.status).toBe("evaluated");
    expect(guard.validateAsync).not.toHaveBeenCalled();
  });

  it("navigate checks the URL before and after loading", async () => {
    const state: FakePageState = { url: "about:blank" };
    const page = fakePage(state);
    await expect(tool(page).handler({ action: "navigate", url: "http://169.254.169.254/" })).rejects.toThrow(/SSRF/);
    expect(page.goto).not.toHaveBeenCalled();
    const ok = await tool(page).handler({ action: "navigate", url: "https://example.com/" });
    expect(ok.status).toBe("navigated");
    expect(guard.validateAsync).toHaveBeenCalledTimes(3);
  });

  it("returns the pinned install hint when Playwright is missing", async () => {
    await expect(tool(fakePage({ url: "about:blank" }), false).handler({ action: "start" })).rejects.toThrow(
      new RegExp(`playwright-core@${PLAYWRIGHT_VERSION.replace(/\./g, "\\.")}`),
    );
  });

  it("each handler set has its own browser state", async () => {
    const page = fakePage({ url: "https://example.com/" });
    const pw = fakePlaywright(page);
    const a = createBrowserToolHandlers({ loadPlaywright: async () => pw, screenshotDir: shots, ssrfGuard: guard }).browser;
    await a.handler({ action: "start" });
    await a.handler({ action: "start" });
    expect(pw.chromium.launch).toHaveBeenCalledTimes(1);
    expect(await a.handler({ action: "stop" })).toEqual({ status: "stopped" });
  });

  it("pngDimensions reads IHDR and rejects non-PNG data", () => {
    expect(pngDimensions(fakePng(10, 20))).toEqual({ width: 10, height: 20 });
    expect(pngDimensions(Buffer.from("not a png at all, not a png at all"))).toBeNull();
  });
});
