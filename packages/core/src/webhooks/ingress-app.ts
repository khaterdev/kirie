/**
 * The webhook sub-app mounted on the public ingress at `/hooks` (PLAN B.9, C.6).
 *
 * It has exactly one route, `POST /hooks/:id`. Everything else under `/hooks`
 * answers the same 404 as an unknown hook. It shares nothing with the control
 * plane (`gateway/routes.ts`). Checks run cheapest first:
 *
 *  1. id format                 -> 404
 *  2. pre-auth rate limit (per client IP and global) -> 429
 *  3. Content-Length required (411) and capped (413); the raw body is read as
 *     bytes with a streaming cap and kept as a Buffer
 *  4+ hook lookup, IP allowlist, signature, timestamp, replay, parse, ping,
 *     event filter, post-auth limits, async hand-off: `WebhookDeliveryHandler`
 *
 * Unknown hook, disabled hook, IP mismatch, bad signature and stale timestamp
 * all return the byte-identical `404 {"status":"not_found"}`. No response ever
 * carries payload data, hook names, agent output or error text.
 */

import { Hono } from "hono";
import { WebhookRateLimiter } from "./limits.js";
import { WEBHOOK_ID_RE } from "./store.js";

/** The one 404 body. Byte-identical for every refusal that must not be an oracle. */
export const WEBHOOK_NOT_FOUND_BODY = '{"status":"not_found"}';

export interface WebhookIncomingRequest {
  hookId: string;
  headers: Headers;
  rawBody: Buffer;
  /** From the trusted IP header when configured and present, else null */
  clientIp: string | null;
}

export type WebhookIngressOutcome =
  | { status: "not_found" }
  | { status: "duplicate" }
  | { status: "pong" }
  | { status: "ignored" }
  | { status: "throttled" }
  | { status: "bad_request" }
  | { status: "accepted"; delivery: number }
  | { status: "test_ok" }
  | { status: "error" };

/**
 * In-process only: `/webhook test` passes this as the Hono env binding. A
 * request that arrives through the listener never has an env, so it can never
 * be a dry run.
 */
export interface WebhookTestBinding {
  kirieWebhookTest: {
    /** true: verify and render only; no dedupe row, no action. Disabled hooks are allowed */
    dryRun: boolean;
    report: string[];
  };
}

export interface WebhookDeliveryHandler {
  handleDelivery(req: WebhookIncomingRequest, test?: WebhookTestBinding["kirieWebhookTest"]): Promise<WebhookIngressOutcome>;
}

export interface WebhookIngressAppOptions {
  handler: WebhookDeliveryHandler;
  maxBodyBytes: number;
  perIpPerMinute: number;
  globalPerMinute: number;
  /** Lower-case header name, e.g. "cf-connecting-ip". Empty disables */
  trustedIpHeader: string;
  log?: { warn(obj: object, msg: string): void };
  now?: () => number;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: JSON_HEADERS });
}

export function webhookNotFound(): Response {
  return jsonResponse(404, WEBHOOK_NOT_FOUND_BODY);
}

function outcomeResponse(outcome: WebhookIngressOutcome): Response {
  switch (outcome.status) {
    case "not_found": return webhookNotFound();
    case "accepted": return jsonResponse(202, JSON.stringify({ status: "accepted", delivery: outcome.delivery }));
    case "duplicate":
    case "pong":
    case "ignored":
    case "test_ok":
      return jsonResponse(200, JSON.stringify({ status: outcome.status }));
    case "throttled": return jsonResponse(429, '{"status":"throttled"}');
    case "bad_request": return jsonResponse(400, '{"status":"bad_request"}');
    case "error": return jsonResponse(500, '{"status":"error"}');
  }
}

function clientIpFrom(headers: Headers, trustedHeader: string): string | null {
  if (!trustedHeader) return null;
  const raw = headers.get(trustedHeader);
  if (!raw) return null;
  const first = raw.split(",")[0]!.trim();
  return /^[0-9a-fA-F:.]{2,45}$/.test(first) ? first : null;
}

/** Reads at most `max` bytes. Returns null when the body is larger. */
async function readCappedBody(request: Request, max: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** Build the `/hooks` sub-app. Mount it with `ingress.mount("/hooks", app)`. */
export function createWebhookIngressApp(opts: WebhookIngressAppOptions): Hono<{ Bindings: Partial<WebhookTestBinding> }> {
  const now = opts.now ?? Date.now;
  const perIp = new WebhookRateLimiter({ limit: opts.perIpPerMinute, windowMs: 60_000 });
  const global = new WebhookRateLimiter({ limit: opts.globalPerMinute, windowMs: 60_000, maxKeys: 1 });
  const trustedHeader = opts.trustedIpHeader.trim().toLowerCase();
  const app = new Hono<{ Bindings: Partial<WebhookTestBinding> }>().basePath("/hooks");

  app.post("/:id", async (c) => {
    const test = c.env?.kirieWebhookTest;
    const id = c.req.param("id");
    if (!WEBHOOK_ID_RE.test(id)) return webhookNotFound();

    const headers = c.req.raw.headers;
    const clientIp = clientIpFrom(headers, trustedHeader);
    if (!test) {
      const t = now();
      if (!global.take("all", t) || !perIp.take(clientIp ?? "unknown", t)) {
        return jsonResponse(429, '{"status":"throttled"}');
      }
    }

    const lenHeader = headers.get("content-length");
    if (!lenHeader || !/^\d{1,10}$/.test(lenHeader.trim())) return jsonResponse(411, '{"status":"length_required"}');
    if (Number(lenHeader) > opts.maxBodyBytes) return jsonResponse(413, '{"status":"too_large"}');
    const rawBody = await readCappedBody(c.req.raw, opts.maxBodyBytes);
    if (rawBody === null) return jsonResponse(413, '{"status":"too_large"}');

    try {
      return outcomeResponse(await opts.handler.handleDelivery({ hookId: id, headers, rawBody, clientIp }, test));
    } catch (err) {
      opts.log?.warn({ err: err instanceof Error ? err.name : "error" }, "webhook delivery handler failed");
      return jsonResponse(500, '{"status":"error"}');
    }
  });

  app.all("*", () => webhookNotFound());
  app.notFound(() => webhookNotFound());
  app.onError(() => jsonResponse(500, '{"status":"error"}'));
  return app;
}
