/**
 * Known-value scrubbing for the kirie-tools subprocess (SCRUB-N1).
 *
 * The daemon holds the known secret values (credential store, config secrets,
 * `~/.kirie/secrets/*.env`, voice and webhook secrets). The stdio subprocess
 * that runs the agent's tools never gets them, so before this, an agent write
 * (memory_store, memory_store_document, daily_note_append, learning_propose)
 * was pattern-scrubbed only, and a value with no prefix and no label was
 * stored and embedded raw.
 *
 * Now the subprocess sends text it is about to persist to the daemon's
 * loopback route `POST /api/scrub/text`, which runs the daemon's scrubber
 * (known values plus patterns) and returns only the scrubbed text and a count.
 * The route needs a per-boot token passed in the subprocess env and is rate
 * limited. If the daemon cannot be reached, the write is refused (fail closed).
 *
 * The route never returns a secret. It does answer "would this text be
 * redacted", so a caller holding the token could test guesses of a known
 * value; the rate limit bounds that, and a weak value is better rotated.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ScrubSink, SecretScrubber } from "./secret-scrubber.js";

export type RemoteScrubber = (text: string, sink: ScrubSink) => Promise<{ text: string; count: number }>;

/** Header carrying the per-boot token. */
export const SCRUB_TOKEN_HEADER = "x-kirie-scrub-token";
/** Largest text accepted by the route, in characters. */
export const SCRUB_API_MAX_CHARS = 1_000_000;
/** Requests per minute the route answers. */
export const SCRUB_API_MAX_PER_MINUTE = 600;
/** Sinks a subprocess may ask for: the stores it writes, and "channel" for text it sends out (TTS). */
const REMOTE_SINKS: ReadonlySet<ScrubSink> = new Set<ScrubSink>(["memory", "proposal", "chat-history", "task-result", "heartbeat-log", "channel"]);

let remote: RemoteScrubber | null = null;

/** Install (or clear) the daemon scrubber used by `scrubBeforeStore`. The stdio server calls this at start. */
export function setRemoteScrubber(fn: RemoteScrubber | null): void {
  remote = fn;
}

export function hasRemoteScrubber(): boolean {
  return remote !== null;
}

/**
 * Scrub text a process is about to persist with the daemon's known values.
 * In the daemon (no remote scrubber set) the text is returned unchanged: its own
 * scrubber already holds the values and the stores scrub on write.
 * Rejects when the daemon cannot be asked; callers refuse the write.
 */
export async function scrubBeforeStore(text: string, sink: ScrubSink): Promise<{ text: string; count: number }> {
  if (!remote || typeof text !== "string" || text.length === 0) return { text, count: 0 };
  return remote(text, sink);
}

/** A RemoteScrubber that calls the daemon's `POST /api/scrub/text`. */
export function createGatewayScrubber(
  baseUrl: string,
  token: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): RemoteScrubber {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return async (text, sink) => {
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/api/scrub/text`, {
        method: "POST",
        headers: { "content-type": "application/json", [SCRUB_TOKEN_HEADER]: token },
        body: JSON.stringify({ text, sink }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`the known-secret check is unavailable (${err instanceof Error ? err.name : "error"})`);
    }
    if (!res.ok) throw new Error(`the known-secret check failed (HTTP ${res.status})`);
    const body = (await res.json()) as { text?: unknown; count?: unknown };
    if (typeof body?.text !== "string" || typeof body.count !== "number") throw new Error("the known-secret check returned a bad answer");
    return { text: body.text, count: body.count };
  };
}

/**
 * The daemon side: `POST /text` with `{ text, sink }` and the token header.
 * Answers `{ text, count }`, the text scrubbed by the daemon's scrubber.
 */
export function createScrubApp(deps: { scrubber: Pick<SecretScrubber, "scrubWithCount">; token: string; now?: () => number }): Hono {
  const app = new Hono();
  const expected = Buffer.from(deps.token, "utf8");
  const now = deps.now ?? Date.now;
  let windowStart = 0;
  let inWindow = 0;
  app.post("/text", async (c) => {
    const got = Buffer.from(c.req.header(SCRUB_TOKEN_HEADER) ?? "", "utf8");
    if (expected.length === 0 || got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return c.json({ error: "forbidden" }, 403);
    }
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      inWindow = 0;
    }
    if (++inWindow > SCRUB_API_MAX_PER_MINUTE) return c.json({ error: "rate limited" }, 429);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > SCRUB_API_MAX_CHARS * 6) return c.json({ error: "too large" }, 413);
    let body: { text?: unknown; sink?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    if (typeof body?.text !== "string") return c.json({ error: "text is required" }, 400);
    if (body.text.length > SCRUB_API_MAX_CHARS) return c.json({ error: "too large" }, 413);
    const sink = body.sink as ScrubSink;
    if (!REMOTE_SINKS.has(sink)) return c.json({ error: "bad sink" }, 400);
    try {
      const r = deps.scrubber.scrubWithCount(body.text, { sink });
      return c.json({ text: r.text, count: r.count });
    } catch {
      return c.json({ error: "scrub failed" }, 500);
    }
  });
  return app;
}
