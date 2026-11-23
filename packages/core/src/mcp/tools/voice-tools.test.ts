import { describe, it, expect, vi, afterEach } from "vitest";
import { createVoiceTools, VOICE_TOOLS_ENV_FLAG } from "./voice-tools.js";

const GW = "http://127.0.0.1:28789";

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("voice tools", () => {
  it("register nothing unless the daemon set the voice flag and a gateway URL exists", () => {
    expect(createVoiceTools({ dbDir: "/tmp", env: {} })).toEqual({});
    expect(createVoiceTools({ dbDir: "/tmp", gatewayUrl: GW, env: {} })).toEqual({});
    expect(createVoiceTools({ dbDir: "/tmp", env: { [VOICE_TOOLS_ENV_FLAG]: "1" } })).toEqual({});
    expect(Object.keys(createVoiceTools({ dbDir: "/tmp", gatewayUrl: GW, env: { [VOICE_TOOLS_ENV_FLAG]: "1" } })).sort())
      .toEqual(["voice_call_hangup", "voice_call_initiate", "voice_call_list", "voice_call_status"]);
  });

  it("the factory does no I/O", () => {
    const fn = stubFetch(200, {});
    createVoiceTools({ dbDir: "/tmp", gatewayUrl: GW, env: { [VOICE_TOOLS_ENV_FLAG]: "1" } });
    expect(fn).not.toHaveBeenCalled();
  });

  const tools = () => createVoiceTools({ dbDir: "/tmp", gatewayUrl: GW, env: { [VOICE_TOOLS_ENV_FLAG]: "1" } });

  it("initiate posts alias, message and mode to /api/voice/calls", async () => {
    const fn = stubFetch(200, { callId: "call-1", status: "dialing", provider: "plivo" });
    const res = await tools().voice_call_initiate!.handler({ to: "me", message: "Your build finished.", mode: "talk" });
    expect(res).toEqual({ callId: "call-1", status: "dialing", provider: "plivo" });
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe(`${GW}/api/voice/calls`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(String(init!.body))).toEqual({ to: "me", message: "Your build finished.", mode: "talk" });
  });

  it("initiate validates its input before any request", async () => {
    const fn = stubFetch(200, {});
    expect(await tools().voice_call_initiate!.handler({ message: "x" })).toHaveProperty("error");
    expect(await tools().voice_call_initiate!.handler({ to: "me", message: "  " })).toHaveProperty("error");
    expect(fn).not.toHaveBeenCalled();
  });

  it("a mode other than talk is sent as say", async () => {
    const fn = stubFetch(200, {});
    await tools().voice_call_initiate!.handler({ to: "me", message: "hi", mode: "shell" });
    expect(JSON.parse(String(fn.mock.calls[0]![1]!.body)).mode).toBe("say");
  });

  it("status, list and hangup hit the right paths", async () => {
    const fn = stubFetch(200, { ok: true });
    await tools().voice_call_status!.handler({ callId: "call-a/b" });
    await tools().voice_call_list!.handler({});
    await tools().voice_call_hangup!.handler({ callId: "call-2" });
    expect(fn.mock.calls.map(([u, i]) => `${i!.method} ${u}`)).toEqual([
      `GET ${GW}/api/voice/calls/call-a%2Fb`,
      `GET ${GW}/api/voice/calls`,
      `POST ${GW}/api/voice/calls/call-2/hangup`,
    ]);
  });

  it("surfaces API errors", async () => {
    stubFetch(403, { error: "Calls go only to configured aliases." });
    expect(await tools().voice_call_initiate!.handler({ to: "+201001234567", message: "x" })).toEqual({ error: "Calls go only to configured aliases." });
    stubFetch(503, {});
    expect(await tools().voice_call_list!.handler({})).toEqual({ error: "HTTP 503" });
  });

  it("surfaces an unreachable daemon", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));
    const res = (await tools().voice_call_list!.handler({})) as { error: string };
    expect(res.error).toMatch(/unreachable/);
  });
});
