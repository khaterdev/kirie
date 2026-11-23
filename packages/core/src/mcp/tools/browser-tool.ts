/**
 * Browser MCP tool — controls a headless browser via Playwright CDP.
 *
 * Actions: start, stop, navigate, snapshot, screenshot, click, type, evaluate.
 *
 * Playwright is loaded via dynamic import to avoid hard dependency.
 * Gracefully returns an error if playwright-core is not installed.
 *
 * `snapshot` returns Playwright's ARIA snapshot (`locator.ariaSnapshot()`):
 * `page.accessibility` was removed from playwright-core. `screenshot` writes a
 * PNG under `<dataDir>/media/screenshots` (directory 0700, file 0600, files
 * older than 24 h pruned) and returns its path, never base64: the stdio server
 * sends every result as text, so the model could not see an inline image. The
 * agent views the file with `Read` and sends it with a `MEDIA:` line.
 *
 * The SSRF guard checks the URL before `navigate` and the page's URL again
 * after navigate, click and evaluate (also when they throw) and before
 * snapshot and screenshot. It cannot see requests that page JavaScript makes
 * itself (`fetch` inside `evaluate`): that is a known limit of `evaluate`.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { SSRFGuard } from "../../security/ssrf-guard.js";

/** playwright-core version installed by `ensurePlaywrightInstalled`. Never "latest". */
export const PLAYWRIGHT_VERSION = "1.58.2";

/** Screenshots older than this are deleted the next time a screenshot is taken. */
export const BROWSER_SCREENSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SCREENSHOT_FILE_RE = /^browser-[0-9a-f-]{36}\.png$/;

// ── Types ───────────────────────────────────────────────────────────────────

// Minimal Playwright types to avoid importing playwright-core at the module level
export interface PlaywrightBrowser {
  close(): Promise<void>;
  contexts(): PlaywrightContext[];
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
}

export interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

export interface PlaywrightLocator {
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
}

export interface PlaywrightPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  /** Present in playwright-core 1.x since 1.49; `ariaSnapshot()` replaced `page.accessibility`. */
  locator?(selector: string): PlaywrightLocator;
  /** Removed from playwright-core; kept only as a fallback for old installs. */
  accessibility?: {
    snapshot(options?: Record<string, unknown>): Promise<unknown>;
  };
  viewportSize?(): { width: number; height: number } | null;
  close(): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
}

export interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}

export interface BrowserToolDeps {
  /** Tests inject a fake Playwright. Default: the real dynamic import. */
  loadPlaywright?: () => Promise<PlaywrightModule | null>;
  /** Where screenshots go. Default: `<KIRIE_DB_DIR or ~/.kirie>/media/screenshots`. */
  screenshotDir?: string;
  ssrfGuard?: { validateAsync(url: string): Promise<void> };
  now?: () => number;
}

/** Message returned when playwright-core or Chromium is missing. */
export const PLAYWRIGHT_MISSING_MESSAGE =
  `playwright-core is not installed. Install it with: npm install --prefix ~/.kirie playwright-core@${PLAYWRIGHT_VERSION} ` +
  "&& ~/.kirie/node_modules/.bin/playwright-core install chromium";

/**
 * Dynamically import playwright-core. Returns null if not installed.
 * Checks the local project first, then falls back to ~/.kirie/node_modules/.
 */
async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return (await import("playwright-core")) as unknown as PlaywrightModule;
  } catch {
    // Fallback: check ~/.kirie/node_modules/ where ensurePlaywrightInstalled puts it
    try {
      const fallbackPath = join(homedir(), ".kirie", "node_modules", "playwright-core", "index.mjs");
      return (await import(fallbackPath)) as unknown as PlaywrightModule;
    } catch {
      return null;
    }
  }
}

function defaultScreenshotDir(): string {
  const dataDir = process.env.KIRIE_DB_DIR || join(homedir(), ".kirie");
  return join(dataDir, "media", "screenshots");
}

/** Width and height from a PNG's IHDR chunk, or null when the buffer is not a PNG. */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24 || signature.some((b, i) => buf[i] !== b)) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Delete this tool's screenshots older than `maxAgeMs`. Best effort; returns the number deleted. */
export function pruneBrowserScreenshots(dir: string, now: number, maxAgeMs = BROWSER_SCREENSHOT_MAX_AGE_MS): number {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const name of names) {
    if (!SCREENSHOT_FILE_RE.test(name)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > maxAgeMs) {
        unlinkSync(file);
        deleted++;
      }
    } catch {
      // Gone already or unreadable: nothing to prune.
    }
  }
  return deleted;
}

/** Write a screenshot to `<dir>/browser-<uuid>.png` (dir 0700, file 0600). */
function writeScreenshot(dir: string, buf: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `browser-${randomUUID()}.png`);
  writeFileSync(file, buf, { mode: 0o600, flag: "wx" });
  return file;
}

// ── Status & auto-install ───────────────────────────────────────────────────

/**
 * Check if playwright-core is installed and Chromium binary is available.
 */
export async function checkPlaywrightStatus(): Promise<{
  installed: boolean;
  browserReady: boolean;
}> {
  const pw = await loadPlaywright();
  if (!pw) return { installed: false, browserReady: false };

  // Try launching with a timeout — if Chromium binary is missing, launch can hang
  try {
    const launchPromise = pw.chromium.launch({ headless: true });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("launch timeout")), 10_000),
    );
    const b = await Promise.race([launchPromise, timeout]);
    await b.close();
    return { installed: true, browserReady: true };
  } catch {
    return { installed: true, browserReady: false };
  }
}

/**
 * Install playwright-core and download Chromium browser binary.
 * Called during setup or first daemon run when browser is enabled.
 */
export async function ensurePlaywrightInstalled(opts?: {
  onProgress?: (step: string) => void;
}): Promise<void> {
  const { execSync } = await import("node:child_process");

  const kirieDir = join(homedir(), ".kirie");

  // Step 1: Install the pinned playwright-core into ~/.kirie/node_modules/ if not present
  const pw = await loadPlaywright();
  if (!pw) {
    opts?.onProgress?.("Installing playwright-core...");
    execSync(`npm install --prefix "${kirieDir}" playwright-core@${PLAYWRIGHT_VERSION}`, { stdio: "pipe" });
  }

  // Step 2: Download Chromium browser binary
  opts?.onProgress?.("Downloading Chromium browser...");
  const pwBin = join(kirieDir, "node_modules", ".bin", "playwright-core");
  execSync(`"${pwBin}" install chromium`, {
    stdio: "pipe",
    timeout: 5 * 60 * 1000, // 5 min timeout for download
  });
}

// ── Tool handler ────────────────────────────────────────────────────────────

/** Everything the page may legitimately be on without an SSRF check. */
function needsUrlCheck(url: string): boolean {
  return url !== "about:blank" && url !== "";
}

export function createBrowserToolHandlers(deps: BrowserToolDeps = {}) {
  const load = deps.loadPlaywright ?? loadPlaywright;
  const guard = deps.ssrfGuard ?? new SSRFGuard();
  const now = deps.now ?? Date.now;
  const screenshotDir = deps.screenshotDir ?? defaultScreenshotDir();

  let browser: PlaywrightBrowser | null = null;
  let currentPage: PlaywrightPage | null = null;

  async function ensureBrowser(): Promise<{ browser: PlaywrightBrowser; page: PlaywrightPage }> {
    if (!browser) {
      const pw = await load();
      if (!pw) throw new Error(PLAYWRIGHT_MISSING_MESSAGE);
      browser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }

    if (!currentPage) {
      const ctx =
        browser.contexts()[0] ?? (await browser.newContext({
          userAgent:
            "Kirie-Bot/1.0 (AI Assistant Browser; +https://github.com/kirie-ai)",
        }));
      currentPage = ctx.pages()[0] ?? (await ctx.newPage());
    }

    return { browser, page: currentPage };
  }

  async function closeBrowser(): Promise<void> {
    if (browser) {
      const b = browser;
      browser = null;
      currentPage = null;
      await b.close();
    }
  }

  /**
   * Re-run the SSRF check on the page's current URL after an action that can
   * navigate on its own (a click on a link, arbitrary JavaScript). A blocked
   * URL sends the page to about:blank and returns the error to the agent.
   */
  async function recheckPageUrl(page: PlaywrightPage): Promise<string | null> {
    const current = page.url();
    if (!needsUrlCheck(current)) return null;
    try {
      await guard.validateAsync(current);
      return null;
    } catch (err) {
      await page.goto("about:blank").catch(() => {
        /* the error below is what matters */
      });
      return err instanceof Error ? err.message : String(err);
    }
  }

  return {
    browser: {
      description:
        "Control a headless browser via Playwright. Actions: start, stop, navigate, snapshot, screenshot, click, type, evaluate. " +
        "snapshot returns the page's ARIA tree as text. screenshot saves a PNG and returns its file path: view it with Read, " +
        "send it with a MEDIA: line. Requires playwright-core installed.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            description:
              "Action: start|stop|navigate|snapshot|screenshot|click|type|evaluate",
          },
          url: {
            type: "string" as const,
            description: "URL for navigate action",
          },
          selector: {
            type: "string" as const,
            description: "CSS selector for click/type actions",
          },
          text: {
            type: "string" as const,
            description:
              "Text for type action or JS code for evaluate action",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: {
        action: string;
        url?: string;
        selector?: string;
        text?: string;
      }): Promise<Record<string, unknown>> {
        const { action, url, selector, text } = params;

        switch (action) {
          case "start": {
            const { page } = await ensureBrowser();
            return {
              status: "started",
              url: page.url(),
            };
          }

          case "stop": {
            await closeBrowser();
            return { status: "stopped" };
          }

          case "navigate": {
            if (!url) throw new Error("'url' parameter is required for navigate action");
            await guard.validateAsync(url);
            const { page } = await ensureBrowser();
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await page.waitForLoadState("networkidle").catch(() => {
              /* timeout is okay */
            });
            // A redirect can land somewhere the first check never saw.
            const blocked = await recheckPageUrl(page);
            if (blocked) return { error: blocked, url: "about:blank" };
            return {
              status: "navigated",
              url: page.url(),
              title: await page.title(),
            };
          }

          case "snapshot": {
            const { page } = await ensureBrowser();
            // The page may have moved on its own (a delayed redirect) since the last check.
            const moved = await recheckPageUrl(page);
            if (moved) return { error: moved, url: "about:blank" };
            if (typeof page.locator === "function") {
              const tree = await page.locator("body").ariaSnapshot();
              return {
                status: "snapshot",
                url: page.url(),
                title: await page.title(),
                format: "aria-yaml",
                snapshot: tree,
              };
            }
            if (page.accessibility && typeof page.accessibility.snapshot === "function") {
              const tree = await page.accessibility.snapshot({ interestingOnly: true });
              return {
                status: "snapshot",
                url: page.url(),
                title: await page.title(),
                format: "accessibility-tree",
                accessibility: tree,
              };
            }
            return { error: "This playwright-core version supports neither ariaSnapshot nor accessibility snapshots." };
          }

          case "screenshot": {
            const { page } = await ensureBrowser();
            const moved = await recheckPageUrl(page);
            if (moved) return { error: moved, url: "about:blank" };
            const buf = await page.screenshot({
              type: "png",
              fullPage: false,
            });
            pruneBrowserScreenshots(screenshotDir, now());
            const path = writeScreenshot(screenshotDir, buf);
            const size = pngDimensions(buf) ?? page.viewportSize?.() ?? null;
            return {
              status: "screenshot",
              url: page.url(),
              path,
              mimeType: "image/png",
              ...(size ? { width: size.width, height: size.height } : {}),
            };
          }

          case "click": {
            if (!selector) throw new Error("'selector' parameter is required for click action");
            const { page } = await ensureBrowser();
            let clickError: unknown;
            try {
              await page.click(selector, { timeout: 10_000 });
              await page.waitForLoadState("domcontentloaded").catch(() => {
                /* no navigation is fine */
              });
            } catch (err) {
              clickError = err;
            }
            // Checked whether the click succeeded or threw (a navigation can destroy the context mid-click).
            const blocked = await recheckPageUrl(page);
            if (blocked) return { error: blocked, url: "about:blank" };
            if (clickError) throw clickError;
            return {
              status: "clicked",
              selector,
              url: page.url(),
            };
          }

          case "type": {
            if (!selector) throw new Error("'selector' parameter is required for type action");
            if (!text) throw new Error("'text' parameter is required for type action");
            const { page } = await ensureBrowser();
            await page.fill(selector, text);
            return {
              status: "typed",
              selector,
              text,
              url: page.url(),
            };
          }

          case "evaluate": {
            if (!text) throw new Error("'text' parameter is required for evaluate action");
            const { page } = await ensureBrowser();
            let result: unknown;
            let evalError: unknown;
            try {
              result = await page.evaluate(text);
              await page.waitForLoadState("domcontentloaded").catch(() => {
                /* no navigation is fine */
              });
            } catch (err) {
              // `location = ...` destroys the execution context and throws: still check where the page went.
              evalError = err;
            }
            const blocked = await recheckPageUrl(page);
            if (blocked) return { error: blocked, url: "about:blank" };
            if (evalError) throw evalError;
            return {
              status: "evaluated",
              result,
              url: page.url(),
            };
          }

          default:
            throw new Error(
              `Unknown browser action: "${action}". Valid actions: start, stop, navigate, snapshot, screenshot, click, type, evaluate`,
            );
        }
      },
    },
  };
}
