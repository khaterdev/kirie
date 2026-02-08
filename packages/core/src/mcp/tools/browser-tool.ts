/**
 * Browser MCP tool — controls a headless browser via Playwright CDP.
 *
 * Actions: start, stop, navigate, snapshot, screenshot, click, type, evaluate.
 *
 * Playwright is loaded via dynamic import to avoid hard dependency.
 * Gracefully returns an error if playwright-core is not installed.
 */

import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────────────

// Minimal Playwright types to avoid importing playwright-core at the module level
interface PlaywrightBrowser {
  close(): Promise<void>;
  contexts(): PlaywrightContext[];
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>;
}

interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  accessibility: {
    snapshot(options?: Record<string, unknown>): Promise<unknown>;
  };
  close(): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser>;
  };
}

// ── Browser state ───────────────────────────────────────────────────────────

let browser: PlaywrightBrowser | null = null;
let currentPage: PlaywrightPage | null = null;

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

async function ensureBrowser(): Promise<{
  browser: PlaywrightBrowser;
  page: PlaywrightPage;
}> {
  if (!browser) {
    const pw = await loadPlaywright();
    if (!pw) {
      throw new Error(
        "playwright-core is not installed. Install it with: npm install playwright-core",
      );
    }

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
    await browser.close();
    browser = null;
    currentPage = null;
  }
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

  // Step 1: Install playwright-core into ~/.kirie/node_modules/ if not present
  const pw = await loadPlaywright();
  if (!pw) {
    opts?.onProgress?.("Installing playwright-core...");
    execSync(`npm install --prefix "${kirieDir}" playwright-core`, { stdio: "pipe" });
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

export function createBrowserToolHandlers() {
  return {
    browser: {
      description:
        "Control a headless browser via Playwright. Actions: start, stop, navigate, snapshot, screenshot, click, type, evaluate. Requires playwright-core installed.",
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
            const { page } = await ensureBrowser();
            await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            });
            await page.waitForLoadState("networkidle").catch(() => {
              /* timeout is okay */
            });
            return {
              status: "navigated",
              url: page.url(),
              title: await page.title(),
            };
          }

          case "snapshot": {
            const { page } = await ensureBrowser();
            const tree = await page.accessibility.snapshot({
              interestingOnly: true,
            });
            return {
              status: "snapshot",
              url: page.url(),
              title: await page.title(),
              accessibility: tree,
            };
          }

          case "screenshot": {
            const { page } = await ensureBrowser();
            const buf = await page.screenshot({
              type: "png",
              fullPage: false,
            });
            return {
              status: "screenshot",
              url: page.url(),
              image: buf.toString("base64"),
              mimeType: "image/png",
            };
          }

          case "click": {
            if (!selector) throw new Error("'selector' parameter is required for click action");
            const { page } = await ensureBrowser();
            await page.click(selector, { timeout: 10_000 });
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
            const result = await page.evaluate(text);
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
