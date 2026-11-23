import { describe, it, expect, vi } from "vitest";
import { TwilioClient } from "./twilio/client.js";
import { PlivoClient } from "./plivo/client.js";
import { createPlivoProvider } from "./plivo/provider.js";
import { createTwilioProvider } from "./twilio/provider.js";
import type { VoiceFetch } from "./provider.js";

const SID = ["AC", "0".repeat(32)].join("");
const TOKEN = ["fake", "voice", "auth", "token"].join("-");
const AUTH_ID = ["MA", "FAKEAUTHID", "0000000"].join("");

function mockFetch(status: number, body: unknown = {}): { fn: VoiceFetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fn, calls };
}

const CALL = {
  to: "+201001234567",
  from: "+14155550100",
  answerUrl: "https://k.example/voice/x/outbound/tok",
  statusUrl: "https://k.example/voice/x/status/tok",
  timeLimitSeconds: 300,
  ringTimeoutSeconds: 30,
};

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("TwilioClient", () => {
  it("createCall posts the form fields with Basic auth", async () => {
    const m = mockFetch(201, { sid: "CA11111111111111111111111111111111", status: "queued" });
    const c = new TwilioClient({ accountSid: SID, authToken: TOKEN }, m.fn);
    const res = await c.createCall({ ...CALL, machineDetection: true });
    expect(res.callSid).toBe("CA11111111111111111111111111111111");
    const { url, init } = m.calls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(basic(SID, TOKEN));
    const form = new URLSearchParams(String(init.body));
    expect(form.get("To")).toBe(CALL.to);
    expect(form.get("From")).toBe(CALL.from);
    expect(form.get("Url")).toBe(CALL.answerUrl);
    expect(form.get("StatusCallback")).toBe(CALL.statusUrl);
    expect(form.getAll("StatusCallbackEvent")).toEqual(["initiated", "ringing", "answered", "completed"]);
    expect(form.get("TimeLimit")).toBe("300");
    expect(form.get("Timeout")).toBe("30");
    expect(form.get("MachineDetection")).toBe("Enable");
    expect(String(init.body)).not.toContain(TOKEN);
  });

  it("a non-2xx response throws an error without the token", async () => {
    const m = mockFetch(401, { code: 20003, message: `Authenticate ${TOKEN}` });
    const c = new TwilioClient({ accountSid: SID, authToken: TOKEN }, m.fn);
    const err = await c.createCall(CALL).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).toContain("20003");
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(SID);
  });

  it("endCall posts Status=completed and throws on failure", async () => {
    const ok = mockFetch(200, {});
    await new TwilioClient({ accountSid: SID, authToken: TOKEN }, ok.fn).endCall("CA22222222222222222222222222222222");
    expect(ok.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/CA22222222222222222222222222222222.json`);
    expect(new URLSearchParams(String(ok.calls[0]!.init.body)).get("Status")).toBe("completed");
    const bad = mockFetch(500, {});
    await expect(new TwilioClient({ accountSid: SID, authToken: TOKEN }, bad.fn).endCall("CA22222222222222222222222222222222")).rejects.toThrow(/500/);
  });

  it("endCall refuses an empty or malformed sid before any request", async () => {
    const m = mockFetch(200);
    const c = new TwilioClient({ accountSid: SID, authToken: TOKEN }, m.fn);
    await expect(c.endCall("")).rejects.toThrow();
    await expect(c.endCall("../../Accounts")).rejects.toThrow();
    expect(m.fn).not.toHaveBeenCalled();
  });
});

describe("PlivoClient", () => {
  it("createCall posts JSON to /Call/ with Basic auth and numbers without +", async () => {
    const m = mockFetch(201, { message: "call fired", request_uuid: "9834029e-58b6-11e1-b8b7-a5bd0e4e126f", api_id: "x" });
    const c = new PlivoClient({ authId: AUTH_ID, authToken: TOKEN }, m.fn);
    const res = await c.createCall({ ...CALL, machineDetection: true });
    expect(res.requestUuid).toBe("9834029e-58b6-11e1-b8b7-a5bd0e4e126f");
    const { url, init } = m.calls[0]!;
    expect(url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(basic(AUTH_ID, TOKEN));
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      from: "14155550100",
      to: "201001234567",
      answer_url: CALL.answerUrl,
      answer_method: "POST",
      hangup_url: CALL.statusUrl,
      hangup_method: "POST",
      time_limit: 300,
      ring_timeout: 30,
      machine_detection: "true",
    });
  });

  it("a non-2xx response throws an error without the token", async () => {
    const m = mockFetch(401, { error: `bad ${TOKEN}` });
    const err = await new PlivoClient({ authId: AUTH_ID, authToken: TOKEN }, m.fn).createCall(CALL).catch((e: Error) => e);
    expect((err as Error).message).toContain("401");
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(AUTH_ID);
  });

  it("endCall('') throws and performs no request", async () => {
    const m = mockFetch(204);
    const c = new PlivoClient({ authId: AUTH_ID, authToken: TOKEN }, m.fn);
    await expect(c.endCall("")).rejects.toThrow();
    await expect(c.endCall("   ")).rejects.toThrow();
    await expect(c.endCall("a/b")).rejects.toThrow();
    expect(m.fn).not.toHaveBeenCalled();
  });

  it("endCall(id) issues DELETE .../Call/<id>/", async () => {
    const m = mockFetch(204);
    await new PlivoClient({ authId: AUTH_ID, authToken: TOKEN }, m.fn).endCall("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(m.calls[0]!.url).toBe(`https://api.plivo.com/v1/Account/${AUTH_ID}/Call/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/`);
    expect(m.calls[0]!.init.method).toBe("DELETE");
  });

  it("endCall throws on a non-2xx response", async () => {
    const m = mockFetch(404, {});
    await expect(new PlivoClient({ authId: AUTH_ID, authToken: TOKEN }, m.fn).endCall("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).rejects.toThrow(/404/);
  });
});

describe("provider endCall guards", () => {
  it("Plivo provider endCall('') throws and performs no request", async () => {
    const m = mockFetch(204);
    const p = createPlivoProvider({ authId: AUTH_ID, authToken: TOKEN, fromNumber: "+14155550100", apiBaseUrl: "https://api.plivo.com", voice: "WOMAN" }, { fetch: m.fn });
    await expect(p.endCall("")).rejects.toThrow();
    expect(m.fn).not.toHaveBeenCalled();
  });

  it("Twilio provider endCall('') throws and performs no request", async () => {
    const m = mockFetch(200);
    const p = createTwilioProvider({ accountSid: SID, authToken: TOKEN, fromNumber: "+14155550100", apiBaseUrl: "https://api.twilio.com", voice: "Polly.Joanna-Neural" }, { fetch: m.fn });
    await expect(p.endCall("")).rejects.toThrow();
    expect(m.fn).not.toHaveBeenCalled();
  });

  it("createCall without credentials throws before any request", async () => {
    const m = mockFetch(200);
    const p = createPlivoProvider({ apiBaseUrl: "https://api.plivo.com", voice: "WOMAN" }, { fetch: m.fn });
    await expect(p.createCall(CALL)).rejects.toThrow();
    expect(m.fn).not.toHaveBeenCalled();
  });
});
