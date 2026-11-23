/**
 * Public webhook routes for one provider, mounted on the PublicIngress under
 * the provider's routePrefix ("/voice/twilio" or "/voice/plivo"). The same
 * route set serves both providers (PLAN C.14):
 *
 *   /inbound          the number's voice URL (Plivo: the application's answer URL)
 *   /pin/:token       DTMF PIN
 *   /turn/:token      a spoken turn for the agent (long-polls)
 *   /wait/:token      continuation of the long-poll
 *   /outbound/:token  first markup of an outbound call once answered
 *   /vm/:token        a one-way call's reply or a voicemail
 *   /status/:token    per-call status / hangup callback
 *   /status           tokenless status callback (Plivo application hangup URL), looked up by call id
 *
 * Every request runs the same preamble: POST only; body at most 16 KB;
 * form-encoded; `provider.verifyWebhook` over ingress.publicBaseUrl + path +
 * raw query and the form fields; for token routes a known token whose live
 * call has the same provider call id and expects this route. Any failure is
 * 403 with an empty body, whatever the reason.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createModuleLogger } from "@kirie/core";
import type { VoiceCallEvent, VoiceCallProvider, VoiceWebhookRequest } from "@kirie/voice";
import type { FlowResult, VoiceCallFlow } from "./flow.js";
import type { LivePhase } from "./session.js";

type Logger = ReturnType<typeof createModuleLogger>;

export const VOICE_MAX_BODY_BYTES = 16 * 1024;

export interface VoiceRouteDeps {
  /** The provider for this prefix. A getter, so reloaded credentials apply to the next request. */
  provider(): VoiceCallProvider;
  flow: VoiceCallFlow;
  publicBaseUrl(): string | null;
  /** Called for every refused request (reason is for logs and counters, never sent). */
  onRejected?(reason: string): void;
  /** Called for every request that passed the signature check. */
  onAccepted?(): void;
  log?: Logger;
  /** Per-prefix request budget. Default 300 per minute. */
  maxRequestsPerMinute?: number;
  now?: () => number;
}

const TOKEN_ROUTES: Record<string, { phases: readonly LivePhase[] | "any"; direction: "inbound" | "outbound" | "either" }> = {
  pin: { phases: ["pin"], direction: "either" },
  turn: { phases: ["listening"], direction: "either" },
  wait: { phases: ["thinking"], direction: "either" },
  outbound: { phases: ["dialing"], direction: "outbound" },
  vm: { phases: ["say-reply", "voicemail"], direction: "either" },
  status: { phases: "any", direction: "either" },
};

function forbidden(): Response {
  return new Response(null, { status: 403 });
}

function toParams(body: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}

function headersOf(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  req.headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

export function createVoiceRoutes(prefix: string, deps: VoiceRouteDeps): Hono {
  const log = deps.log ?? createModuleLogger("voice-routes");
  const now = deps.now ?? Date.now;
  const budget = deps.maxRequestsPerMinute ?? 300;
  let windowStart = 0;
  let windowCount = 0;

  const reject = (reason: string): Response => {
    deps.onRejected?.(reason);
    log.warn({ prefix, reason }, "voice webhook refused");
    return forbidden();
  };

  const respond = (provider: VoiceCallProvider, r: FlowResult): Response => {
    if (r.status === 403) return reject("flow refused");
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(r.markup, { status: 200, headers: { "content-type": `${provider.markup.contentType}; charset=utf-8` } });
  };

  /** The shared preamble. Returns the verified request and the provider, or a 403 response. */
  const verify = async (c: Context): Promise<{ provider: VoiceCallProvider; req: VoiceWebhookRequest } | Response> => {
    const t = now();
    if (t - windowStart >= 60_000) { windowStart = t; windowCount = 0; }
    if (++windowCount > budget) return new Response(null, { status: 429 });

    if (c.req.method !== "POST") return reject("method");
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) return reject("content-type");
    const base = deps.publicBaseUrl();
    if (!base) return reject("no public base url");
    let body: string;
    try {
      body = await c.req.text();
    } catch {
      return reject("body");
    }
    if (Buffer.byteLength(body, "utf8") > VOICE_MAX_BODY_BYTES) return reject("body too large");
    const u = new URL(c.req.url);
    const req: VoiceWebhookRequest = {
      method: c.req.method,
      url: `${base}${u.pathname}${u.search}`,
      headers: headersOf(c.req.raw),
      params: toParams(body),
    };
    const provider = deps.provider();
    if (!provider.verifyWebhook(req)) return reject("signature");
    deps.onAccepted?.();
    return { provider, req };
  };

  const app = new Hono().basePath(prefix);
  app.use("*", bodyLimit({ maxSize: VOICE_MAX_BODY_BYTES, onError: () => reject("body too large") }));

  app.post("/inbound", async (c) => {
    const v = await verify(c);
    if (v instanceof Response) return v;
    const event = v.provider.parseEvent(v.req, "inbound");
    return respond(v.provider, deps.flow.inbound(v.provider, event));
  });

  app.post("/status", async (c) => {
    const v = await verify(c);
    if (v instanceof Response) return v;
    const event = v.provider.parseEvent(v.req, "inbound");
    const call = deps.flow.findLive(v.provider.name, event.providerCallId);
    return respond(v.provider, deps.flow.status(v.provider, call, event));
  });

  app.post("/:kind/:token", async (c) => {
    const kind = c.req.param("kind");
    const spec = TOKEN_ROUTES[kind];
    if (!spec) return reject("unknown route");
    const v = await verify(c);
    if (v instanceof Response) return v;
    const token = c.req.param("token");
    const parsedInbound = v.provider.parseEvent(v.req, "inbound");
    const call = deps.flow.authorize(token, v.provider.name, parsedInbound, spec.phases);
    if (!call) return reject("token, call id or phase");
    if (spec.direction !== "either" && call.direction !== spec.direction) return reject("direction");
    const event: VoiceCallEvent = { ...parsedInbound, direction: call.direction };
    switch (kind) {
      case "pin": return respond(v.provider, deps.flow.pin(v.provider, call, event));
      case "turn": return respond(v.provider, await deps.flow.turn(v.provider, call, event));
      case "wait": return respond(v.provider, await deps.flow.wait(v.provider, call));
      case "outbound": return respond(v.provider, deps.flow.outbound(v.provider, call));
      case "vm": return respond(v.provider, deps.flow.voicemail(v.provider, call, event));
      default: return respond(v.provider, deps.flow.status(v.provider, call, event));
    }
  });

  app.all("*", () => reject("route"));
  return app;
}
