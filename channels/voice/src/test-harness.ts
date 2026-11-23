/**
 * Test-only harness: a VoiceService wired to fakes (ingress, settings,
 * approvals, owner notifications, pipeline hooks) and a mocked provider
 * fetch, plus request signing for both providers. Not exported.
 */

import { vi, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceConfigSchema, type UnifiedMessage, type VoiceConfig } from "@kirie/core";
import {
  CallStore,
  computePlivoV3Signature,
  computeTwilioSignature,
  withoutPlus,
  type VoiceFetch,
  type VoiceProviderName,
} from "@kirie/voice";
import type { VoiceCredentials } from "./credentials.js";
import { VoiceService, type VoiceIngress } from "./service.js";

export const OWNER = "+201001234567";
export const MOM = "+201112223333";
export const STRANGER = "+447700900123";
export const FROM = "+14155550100";
export const BASE = "https://kirie.example.com";
export const TWILIO_SID = ["AC", "9".repeat(32)].join("");
export const TWILIO_TOKEN = ["fake", "twilio", "secret", "token"].join("-");
export const PLIVO_ID = ["MA", "HARNESSFAKEID", "0000"].join("");
export const PLIVO_TOKEN = ["fake", "plivo", "secret", "token"].join("-");
export const PIN = "4826";

export function fullCredentials(): VoiceCredentials {
  return {
    twilio: { accountSid: TWILIO_SID, authToken: TWILIO_TOKEN },
    plivo: { authId: PLIVO_ID, authToken: PLIVO_TOKEN },
    pin: PIN,
    envFile: { status: "ok" },
    problems: { twilio: [], plivo: [], pin: [] },
  };
}

export class FakeSettings {
  readonly values = new Map<string, unknown>();
  get<T>(key: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): T | undefined {
    if (!this.values.has(key)) return undefined;
    const r = schema.safeParse(this.values.get(key));
    return r.success ? r.data : undefined;
  }
  set = vi.fn((key: string, value: unknown) => { this.values.set(key, value); });
  delete = vi.fn((key: string) => { this.values.delete(key); });
}

export class FakeIngress implements VoiceIngress {
  readonly mounts = new Map<string, { fetch(req: Request): Response | Promise<Response> }>();
  publicBaseUrl: string | null = BASE;
  ensureStarted = vi.fn(async () => {});
  stopIfIdle = vi.fn(async () => {});
  mount(prefix: string, app: { fetch(req: Request): Response | Promise<Response> }): void {
    if (this.mounts.has(prefix)) throw new Error("dup");
    this.mounts.set(prefix, app);
  }
  unmount(prefix: string): void { this.mounts.delete(prefix); }
  mountedPrefixes(): string[] { return [...this.mounts.keys()]; }
}

export interface HarnessOptions {
  provider?: VoiceProviderName;
  config?: Record<string, unknown>;
  credentials?: VoiceCredentials;
  fetchStatus?: number;
  approval?: "approved" | "denied" | "timeout" | "unavailable";
  busy?: boolean;
}

export interface FetchCall { url: string; method: string; body: string }

export async function makeHarness(opts: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kirie-voice-harness-"));
  const provider = opts.provider ?? "twilio";
  let clock = new Date(2026, 10, 23, 12, 0, 0).getTime();
  const config: VoiceConfig = VoiceConfigSchema.parse({
    enabled: true,
    provider,
    ownerNumbers: [OWNER],
    contacts: { mom: MOM },
    outbound: { enabled: true },
    twilio: { fromNumber: FROM },
    plivo: { fromNumber: FROM },
    ...(opts.config ?? {}),
  });
  const fetchCalls: FetchCall[] = [];
  const fetchFn: Mock<VoiceFetch> = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
    const status = opts.fetchStatus ?? (init?.method === "DELETE" ? 204 : 201);
    const body = url.includes("api.plivo.com")
      ? { message: "call fired", request_uuid: "rq-0000-1111", api_id: "x" }
      : { sid: "CA00000000000000000000000000000001", status: "queued" };
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  });
  const settings = new FakeSettings();
  const ingress = new FakeIngress();
  const notifyOwner = vi.fn(async (_text: string, _o?: { key?: string }) => {});
  const requestApproval = vi.fn(async () => ({ outcome: opts.approval ?? "approved", optionId: opts.approval === "approved" || !opts.approval ? "approve" : "deny", code: "K7Q2" }));
  const addNextTurnNote = vi.fn();
  const audit = { record: vi.fn() };
  const watchdogs: Array<() => void> = [];
  const store = new CallStore(join(dir, "voice-calls"), () => clock);
  const service = await VoiceService.create({
    config,
    loadCredentials: async () => opts.credentials ?? fullCredentials(),
    fetch: fetchFn,
    ingress,
    settings: settings as never,
    store,
    approvals: { requestApproval: requestApproval as never },
    notifyOwner,
    audit: audit as never,
    pipeline: { isBusy: () => opts.busy ?? false, addNextTurnNote },
    now: () => clock,
    holdMs: 40,
    setTimer: (fn, ms) => {
      if (ms > 5_000) { watchdogs.push(fn); return setTimeout(() => {}, 0); }
      return setTimeout(fn, ms);
    },
    clearTimer: (h) => clearTimeout(h),
  });
  const emitted: UnifiedMessage[] = [];
  service.adapter.onMessage((m) => { emitted.push(m); });
  await service.start();

  const prefix = `/voice/${provider}`;

  function sign(path: string, params: Record<string, string>, which: VoiceProviderName = provider): Record<string, string> {
    const url = `${BASE}${path}`;
    if (which === "twilio") return { "x-twilio-signature": computeTwilioSignature(TWILIO_TOKEN, url, params) };
    const nonce = String(Math.floor(Math.random() * 1e12));
    return { "x-plivo-signature-v3": computePlivoV3Signature(PLIVO_TOKEN, url, params, nonce), "x-plivo-signature-v3-nonce": nonce };
  }

  /** Provider-dialect webhook fields. */
  function payload(p: { callId: string; from?: string | null; to?: string; status?: string; speech?: string; digits?: string; duration?: number; direction?: "inbound" | "outbound" }): Record<string, string> {
    const from = p.from === undefined ? OWNER : p.from;
    const to = p.to ?? FROM;
    if (provider === "twilio") {
      return {
        CallSid: p.callId,
        AccountSid: TWILIO_SID,
        From: from ?? "anonymous",
        To: to,
        CallStatus: p.status ?? "in-progress",
        Direction: p.direction === "outbound" ? "outbound-api" : "inbound",
        ...(p.speech !== undefined ? { SpeechResult: p.speech, Confidence: "0.9" } : {}),
        ...(p.digits !== undefined ? { Digits: p.digits } : {}),
        ...(p.duration !== undefined ? { CallDuration: String(p.duration) } : {}),
      };
    }
    return {
      CallUUID: p.callId,
      From: from ? withoutPlus(from) : "anonymous",
      To: withoutPlus(to),
      CallStatus: p.status ?? "in-progress",
      Direction: p.direction ?? "inbound",
      ...(p.speech !== undefined ? { InputType: "speech", Speech: p.speech, SpeechConfidenceScore: "0.9" } : {}),
      ...(p.digits !== undefined ? { InputType: "dtmf", Digits: p.digits } : {}),
      ...(p.duration !== undefined ? { Duration: String(p.duration), Event: "Hangup" } : {}),
    };
  }

  async function post(path: string, params: Record<string, string>, o: { headers?: Record<string, string>; unsigned?: boolean; method?: string; body?: string; contentType?: string } = {}): Promise<Response> {
    const app = ingress.mounts.get(prefix);
    const target = app ?? service.routesFor(provider);
    const headers: Record<string, string> = {
      "content-type": o.contentType ?? "application/x-www-form-urlencoded",
      ...(o.unsigned ? {} : sign(path, params)),
      ...(o.headers ?? {}),
    };
    const method = o.method ?? "POST";
    return target.fetch(new Request(`http://127.0.0.1:18787${path}`, {
      method,
      headers,
      ...(method === "GET" || method === "HEAD" ? {} : { body: o.body ?? new URLSearchParams(params).toString() }),
    }));
  }

  return {
    dir, provider, prefix, config, service, store, settings, ingress, notifyOwner, requestApproval, addNextTurnNote, audit,
    fetchFn, fetchCalls, emitted, watchdogs, sign, payload, post,
    advance(ms: number) { clock += ms; },
    now: () => clock,
    cleanup() { service.flow.shutdown(); rmSync(dir, { recursive: true, force: true }); },
  };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** The token in an action URL of the markup ("/turn/<32 hex>"). */
export function tokenIn(markup: string, kind: string): string | null {
  const m = new RegExp(`/${kind}/([0-9a-f]{32})`).exec(markup);
  return m ? m[1]! : null;
}
