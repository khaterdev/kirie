import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry, OwnerDirectory, VoiceConfigSchema, type UnifiedMessage } from "@kirie/core";
import { createTwilioProvider } from "@kirie/voice";
import { FROM, MOM, OWNER, PIN, PLIVO_ID, PLIVO_TOKEN, TWILIO_SID, TWILIO_TOKEN, fullCredentials, makeHarness, type Harness } from "./test-harness.js";
import { createVoiceCommands, parseCallArgs } from "./commands.js";
import { createVoiceInternalApi } from "./internal-api.js";
import { resolveVoiceReadiness } from "./readiness.js";
import { applyVoiceToolProfile, voicePromptAddendum, VOICE_CHAT_PROFILE_DISALLOWED } from "./profile.js";
import { loadVoiceCredentials } from "./credentials.js";
import { VoiceAdapter } from "./adapter.js";

let h: Harness | null = null;
afterEach(() => { h?.cleanup(); h = null; });

const SECRETS = [TWILIO_SID, TWILIO_TOKEN, PLIVO_ID, PLIVO_TOKEN, PIN];

describe("VoiceService.placeCall refusals happen before any provider request", () => {
  const cases: Array<[string, Record<string, unknown>, Parameters<Harness["service"]["placeCall"]>[0], RegExp]> = [
    ["raw number", {}, { alias: "+201112223333", text: "hi", mode: "say", requestedBy: "owner-command" }, /raw phone numbers/],
    ["talk to a non-owner", {}, { alias: "mom", text: "", mode: "talk", requestedBy: "owner-command" }, /only allowed with the owner/],
    ["unknown alias", {}, { alias: "boss", text: "hi", mode: "say", requestedBy: "owner-command" }, /Unknown contact alias "boss"/],
    ["empty message", {}, { alias: "mom", text: "  ", mode: "say", requestedBy: "owner-command" }, /empty/],
    ["too long", {}, { alias: "mom", text: "x".repeat(1001), mode: "say", requestedBy: "owner-command" }, /longer than 1000/],
    ["outbound disabled", { outbound: { enabled: false } }, { alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" }, /Outbound calls are disabled/],
    ["daily calls cap", { limits: { maxCallsPerDay: 0 } }, { alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" }, /daily call limit/],
    ["daily minutes cap", { limits: { maxMinutesPerDay: 0 } }, { alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" }, /minutes is used up/],
    ["agent calls off", { outbound: { enabled: true, agentCalls: "off" } }, { alias: "mom", text: "hi", mode: "say", requestedBy: "agent-tool" }, /Agent-initiated calls are disabled/],
  ];
  it.each(cases)("%s", async (_name, config, req, re) => {
    h = await makeHarness({ config });
    const r = await h.service.placeCall(req);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(re);
    expect(h.fetchFn).not.toHaveBeenCalled();
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it("switch off refuses", async () => {
    h = await makeHarness();
    await h.service.switchOff("owner:t");
    const r = await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" });
    expect(r.ok ? "" : r.reason).toMatch(/switched off/);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("a second call while one is live is refused", async () => {
    h = await makeHarness();
    expect((await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" })).ok).toBe(true);
    const r = await h.service.placeCall({ alias: "me", text: "hi", mode: "say", requestedBy: "owner-command" });
    expect(r.ok ? "" : r.reason).toMatch(/another call is in progress/);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe.each(["twilio", "plivo"] as const)("VoiceService outbound (%s)", (provider) => {
  it("owner-command dials without approval, through the active provider", async () => {
    h = await makeHarness({ provider });
    const r = await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" });
    expect(r).toMatchObject({ ok: true, provider, status: "dialing" });
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.fetchCalls[0]!.url).toContain(provider === "twilio" ? "api.twilio.com" : "api.plivo.com");
    expect(h.fetchCalls[0]!.body).toContain(provider === "twilio" ? "voice%2Ftwilio%2Foutbound%2F" : "/voice/plivo/outbound/");
  });

  it("agent-tool with ask dials only after approval and shows destination, provider and exact words", async () => {
    h = await makeHarness({ provider, approval: "approved" });
    const r = await h.service.placeCall({ alias: "mom", text: "Your parcel arrived.", mode: "say", requestedBy: "agent-tool" });
    expect(r.ok).toBe(true);
    const req = (h.requestApproval.mock.calls[0] as unknown[])[0] as { kind: string; title: string; body: string; timeoutMs: number };
    expect(req.kind).toBe("voice");
    expect(req.title).toContain("mom");
    expect(req.title).toContain("…3333");
    expect(req.title).toContain(provider === "twilio" ? "Twilio" : "Plivo");
    expect(req.body).toContain("«Your parcel arrived.»");
    expect(req.timeoutMs).toBe(120_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(["denied", "timeout", "unavailable"] as const)("agent-tool with ask: %s does not dial", async (outcome) => {
    h = await makeHarness({ provider, approval: outcome });
    const r = await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "agent-tool" });
    expect(r.ok ? "" : r.reason).toContain(outcome);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("agent-tool with allow dials without asking", async () => {
    h = await makeHarness({ provider, config: { outbound: { enabled: true, agentCalls: "allow" } } });
    expect((await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "agent-tool" })).ok).toBe(true);
    expect(h.requestApproval).not.toHaveBeenCalled();
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("a provider error is reported without credentials and closes the record", async () => {
    h = await makeHarness({ provider, fetchStatus: 401 });
    const r = await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" });
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason).toContain("401");
    for (const s of SECRETS) expect(reason).not.toContain(s);
    expect(h.service.live.size).toBe(0);
    expect(h.store.recent(1)[0]).toMatchObject({ state: "failed", endReason: "create-failed" });
  });

  it("hangup ends live calls through the provider", async () => {
    h = await makeHarness({ provider, config: { inbound: { mode: "agent", requirePin: false } } });
    const callId = provider === "twilio" ? "CA0000000000000000000000000000hu01" : "aaaaaaaa-9999-2222-3333-444444444444";
    await h.post(`${h.prefix}/inbound`, h.payload({ callId }));
    expect(h.service.live.size).toBe(1);
    expect(await h.service.hangupAll("test")).toBe(1);
    const last = h.fetchCalls.at(-1)!;
    if (provider === "plivo") {
      expect(last.method).toBe("DELETE");
      expect(last.url).toMatch(new RegExp(`/Call/${callId}/$`));
    } else {
      expect(last.body).toBe("Status=completed");
    }
    expect(h.service.live.size).toBe(0);
  });
});

describe("provider selection", () => {
  it("/voice provider plivo is refused when Plivo is not ready", async () => {
    const creds = fullCredentials();
    creds.plivo = {};
    h = await makeHarness({ provider: "twilio", credentials: creds });
    const r = await h.service.setProvider("plivo", "owner:t");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("plivo.authId");
    expect(r.message).toContain("plivo.authToken");
    expect(h.ingress.mountedPrefixes()).toEqual(["/voice/twilio"]);
    expect(h.settings.set).not.toHaveBeenCalled();
  });

  it("is refused while a call is live", async () => {
    h = await makeHarness({ provider: "twilio" });
    await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" });
    const r = await h.service.setProvider("plivo", "owner:t");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/call is live/);
    expect(h.ingress.mountedPrefixes()).toEqual(["/voice/twilio"]);
  });

  it("/voice off closes a Plivo call that is still ringing (no id yet) without calling the hangup endpoint", async () => {
    h = await makeHarness({ provider: "plivo" });
    expect((await h.service.placeCall({ alias: "mom", text: "hi", mode: "say", requestedBy: "owner-command" })).ok).toBe(true);
    await h.service.switchOff("owner:t");
    expect(h.service.live.size).toBe(0);
    expect(h.fetchCalls.filter((c) => c.method === "DELETE")).toEqual([]);
    expect(h.store.recent(1)[0]).toMatchObject({ state: "canceled", endReason: "switched-off" });
  });

  it("on success unmounts /voice/twilio, mounts /voice/plivo, persists the override; reset returns to config", async () => {
    h = await makeHarness({ provider: "twilio" });
    const r = await h.service.setProvider("plivo", "owner:telegram:1");
    expect(r.ok).toBe(true);
    expect(h.ingress.mountedPrefixes()).toEqual(["/voice/plivo"]);
    expect(h.settings.set).toHaveBeenCalledWith("voice.provider", "plivo", "owner:telegram:1");
    expect(h.service.activeProvider()).toBe("plivo");
    expect(h.audit.record).toHaveBeenCalledWith(expect.objectContaining({ feature: "voice", action: "provider.switched", detail: { from: "twilio", to: "plivo" } }));
    // A Twilio-signed request no longer reaches anything.
    expect(h.ingress.mounts.get("/voice/twilio")).toBeUndefined();
    const back = await h.service.setProvider("reset", "owner:telegram:1");
    expect(back.ok).toBe(true);
    expect(h.settings.delete).toHaveBeenCalledWith("voice.provider", "owner:telegram:1");
    expect(h.ingress.mountedPrefixes()).toEqual(["/voice/twilio"]);
  });

  it("a provider with no credentials stays disabled and mounts nothing", async () => {
    const creds = fullCredentials();
    creds.twilio = {};
    h = await makeHarness({ provider: "twilio", credentials: creds });
    expect(h.service.isActive()).toBe(false);
    expect(h.ingress.mountedPrefixes()).toEqual([]);
    expect(h.ingress.stopIfIdle).toHaveBeenCalled();
  });
});

describe("/voice and /call commands", () => {
  function msg(senderId: string, text: string): UnifiedMessage {
    return { id: "m1", channel: "telegram", senderId, senderName: "x", text, chatType: "dm", chatId: senderId, timestamp: 0, raw: null };
  }
  async function dispatch(x: Harness, text: string, senderId = "1001"): Promise<string> {
    const registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: ["1001"] }) });
    registry.registerAll(createVoiceCommands(x.service, { includeCall: true }));
    const replies: string[] = [];
    await registry.dispatch({
      message: msg(senderId, text),
      identity: { role: "owner", canonicalId: `telegram:${senderId}`, channel: "telegram", senderId },
      source: "channel",
      send: async (r) => { replies.push(r.text); },
    });
    return replies.join("\n");
  }

  it("are owner-only DM commands; a non-owner is refused and nothing is dialled", async () => {
    h = await makeHarness();
    for (const def of createVoiceCommands(h.service, { includeCall: true })) {
      expect(def.ownerOnly).toBe(true);
      expect(def.scope).toBe("dm");
      expect(def.category).toBe("media");
    }
    const reply = await dispatch(h, "/call mom hello", "2002");
    expect(reply).not.toMatch(/Calling/);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("/voice status prints both providers' readiness and never a credential", async () => {
    h = await makeHarness();
    const text = await dispatch(h, "/voice status");
    expect(text).toContain("Active provider: Twilio");
    expect(text).toContain("Twilio: ready");
    expect(text).toContain("Plivo: ready");
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(MOM);
  });

  it("/voice on when not ready lists what is missing", async () => {
    const creds = fullCredentials();
    creds.twilio = { accountSid: TWILIO_SID };
    h = await makeHarness({ credentials: creds });
    const text = await dispatch(h, "/voice on");
    expect(text).toContain("Missing: twilio.authToken");
    expect(h.settings.set).not.toHaveBeenCalled();
  });

  it("/voice off persists the switch and /voice on restores it", async () => {
    h = await makeHarness();
    expect(await dispatch(h, "/voice off")).toContain("Voice is off");
    expect(h.settings.values.get("voice.switch")).toBe(false);
    expect(h.ingress.mountedPrefixes()).toEqual([]);
    expect(await dispatch(h, "/voice on")).toContain("Voice is on");
    expect(h.settings.values.get("voice.switch")).toBe(true);
    expect(h.ingress.mountedPrefixes()).toEqual(["/voice/twilio"]);
  });

  it("/voice provider shows both and switches", async () => {
    h = await makeHarness();
    expect(await dispatch(h, "/voice provider")).toMatch(/twilio: ready[\s\S]*plivo: ready/);
    expect(await dispatch(h, "/voice provider plivo")).toContain("Active provider: Plivo");
    expect(await dispatch(h, "/voice provider skype")).toContain("Unknown provider");
  });

  it("/call lists aliases and dials", async () => {
    h = await makeHarness();
    expect(await dispatch(h, "/call")).toContain("me, mom");
    expect(await dispatch(h, '/call mom "Dinner at eight"')).toContain("Calling mom via twilio");
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("parses /call arguments", () => {
    expect(parseCallArgs([])).toEqual({ kind: "list" });
    expect(parseCallArgs(["mom", "hello", "there"])).toEqual({ kind: "call", alias: "mom", mode: "say", text: "hello there" });
    expect(parseCallArgs(["me", "--talk"])).toEqual({ kind: "call", alias: "me", mode: "talk", text: "" });
    expect(parseCallArgs(["me", "--talk", "plan", "tomorrow"])).toEqual({ kind: "call", alias: "me", mode: "talk", text: "plan tomorrow" });
    expect(parseCallArgs(["mom"]).kind).toBe("error");
  });
});

describe("readiness", () => {
  const provider = (o: Record<string, string> = {}) => createTwilioProvider({ accountSid: TWILIO_SID, authToken: TWILIO_TOKEN, fromNumber: FROM, apiBaseUrl: "https://api.twilio.com", voice: "v", ...o });
  const cfg = (o: Record<string, unknown> = {}) => VoiceConfigSchema.parse({ enabled: true, ownerNumbers: [OWNER], ...o });

  it("ready with everything", () => {
    expect(resolveVoiceReadiness({ config: cfg(), publicBaseUrl: "https://k.example", provider: provider() })).toEqual({ ready: true, missing: [] });
  });

  it("lists each missing item", () => {
    const r = resolveVoiceReadiness({
      config: cfg({ ownerNumbers: [], inbound: { mode: "agent" } }),
      publicBaseUrl: null,
      provider: createTwilioProvider({ apiBaseUrl: "https://api.twilio.com", voice: "v" }),
    });
    expect(r.missing).toEqual([
      "twilio.accountSid", "twilio.authToken", "twilio.fromNumber",
      "ingress.publicBaseUrl", "voice.ownerNumbers", "voice.inbound.pin (4 to 10 digits)",
    ]);
  });

  it("an unresolved $credential: literal counts as missing; an http URL is rejected; PIN format", () => {
    expect(resolveVoiceReadiness({ config: cfg(), publicBaseUrl: "https://k.example", provider: provider({ authToken: "$credential:twilio.auth_token" }) }).missing).toEqual(["twilio.authToken"]);
    expect(resolveVoiceReadiness({ config: cfg(), publicBaseUrl: "http://k.example", provider: provider() }).missing).toEqual(["ingress.publicBaseUrl (must be an https URL)"]);
    const agent = cfg({ inbound: { mode: "agent" } });
    expect(resolveVoiceReadiness({ config: agent, publicBaseUrl: "https://k.example", provider: provider(), pin: "12" }).ready).toBe(false);
    expect(resolveVoiceReadiness({ config: agent, publicBaseUrl: "https://k.example", provider: provider(), pin: "12ab" }).ready).toBe(false);
    expect(resolveVoiceReadiness({ config: agent, publicBaseUrl: "https://k.example", provider: provider(), pin: "123456" }).ready).toBe(true);
    expect(resolveVoiceReadiness({ config: cfg({ inbound: { mode: "agent", requirePin: false } }), publicBaseUrl: "https://k.example", provider: provider() }).ready).toBe(true);
  });
});

describe("credentials loader", () => {
  it("reads voice.env first, falls back to the credential store, refuses plaintext config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kirie-voice-creds-"));
    try {
      const envPath = join(dir, "voice.env");
      writeFileSync(envPath, `PLIVO_AUTH_ID=${PLIVO_ID}\nPLIVO_AUTH_TOKEN=${PLIVO_TOKEN}\n`);
      chmodSync(envPath, 0o600);
      const config = VoiceConfigSchema.parse({
        enabled: true,
        twilio: { accountSid: "$credential:twilio.account_sid", authToken: "plain-text-in-config" },
        plivo: { authToken: "$credential:plivo.auth_token" },
      });
      const store = { list: () => ["twilio.account_sid", "plivo.auth_token"], get: async (k: string) => (k === "twilio.account_sid" ? TWILIO_SID : "store-plivo-token") };
      const c = await loadVoiceCredentials({ config, voiceEnvPath: envPath, credentials: store });
      expect(c.plivo).toEqual({ authId: PLIVO_ID, authToken: PLIVO_TOKEN });
      expect(c.twilio).toEqual({ accountSid: TWILIO_SID });
      expect(c.problems.twilio.join(" ")).toMatch(/plaintext/);
      chmodSync(envPath, 0o644);
      const c2 = await loadVoiceCredentials({ config, voiceEnvPath: envPath, credentials: store });
      expect(c2.envFile.status).toBe("ignored");
      expect(c2.plivo).toEqual({ authToken: "store-plivo-token" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("voice tool profile", () => {
  const voiceCtx = { kind: "chat" as const, channel: "voice", sessionKey: `voice:dm:${OWNER}`, ownerDm: true, interactive: true, label: "chat voice:dm", cwd: "/tmp" };
  const tgCtx = { ...voiceCtx, channel: "telegram", sessionKey: "telegram:dm:1" };

  it("chat profile removes risky tools and computer use for voice sessions only, without mutating shared objects", () => {
    const allowed = ["Read", "Bash", "mcp__kirie-tools__voice_call_initiate", "mcp__kirie-tools__memory_search", "mcp__cua-driver__click"];
    const servers = { "kirie-tools": { command: "node" }, "cua-driver": { command: "cua" } };
    const options = { allowedTools: allowed, mcpServers: servers, disallowedTools: ["X"] } as never as Parameters<typeof applyVoiceToolProfile>[0];
    applyVoiceToolProfile(options, voiceCtx, "chat");
    expect(options.allowedTools).toEqual(["Read", "mcp__kirie-tools__memory_search"]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["X", ...VOICE_CHAT_PROFILE_DISALLOWED]));
    expect(Object.keys(options.mcpServers!)).toEqual(["kirie-tools"]);
    expect(allowed).toHaveLength(5);
    expect(Object.keys(servers)).toEqual(["kirie-tools", "cua-driver"]);

    const other = { allowedTools: [...allowed], mcpServers: { ...servers } } as never as Parameters<typeof applyVoiceToolProfile>[0];
    applyVoiceToolProfile(other, tgCtx, "chat");
    expect(other.allowedTools).toEqual(allowed);
    expect(other.disallowedTools).toBeUndefined();
  });

  it("chat profile also closes indirect routes to a full-tool turn and external MCP servers", () => {
    const options = {
      allowedTools: ["mcp__kirie-tools__sessions_send", "mcp__kirie-tools__schedule_create", "mcp__kirie-tools__send_message", "mcp__docs__delete"],
      mcpServers: { "kirie-tools": {}, docs: {} },
    } as never as Parameters<typeof applyVoiceToolProfile>[0];
    applyVoiceToolProfile(options, voiceCtx, "chat");
    expect(options.allowedTools).toEqual(["mcp__kirie-tools__send_message"]);
    expect(Object.keys(options.mcpServers!)).toEqual(["kirie-tools"]);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["mcp__kirie-tools__sessions_send", "mcp__kirie-tools__schedule_create", "mcp__kirie-tools__proactive_trigger"]));
  });

  it("full profile still removes voice_call_initiate and computer use", () => {
    const options = { allowedTools: ["Bash", "mcp__kirie-tools__voice_call_initiate", "mcp__cua-driver__x"], mcpServers: { "cua-driver": {} } } as never as Parameters<typeof applyVoiceToolProfile>[0];
    applyVoiceToolProfile(options, voiceCtx, "full");
    expect(options.allowedTools).toEqual(["Bash"]);
    expect(options.mcpServers).toEqual({});
  });

  it("the addendum appears only for voice chat sessions", () => {
    expect(voicePromptAddendum({ kind: "chat", channel: "voice", ownerDm: true })).toContain("<voice_call>");
    expect(voicePromptAddendum({ kind: "chat", channel: "telegram", ownerDm: true })).toBeNull();
    expect(voicePromptAddendum({ kind: "background", channel: "voice", ownerDm: true })).toBeNull();
  });
});

describe("VoiceAdapter", () => {
  it("capabilities are all off; status reflects readiness; sendText without a live turn forwards to Telegram", async () => {
    const forward = vi.fn(async () => {});
    let reason: string | null = "not ready: twilio.authToken";
    const a = new VoiceAdapter({ deliverReply: () => false, forwardToOwner: forward, notReadyReason: () => reason, maxTextLength: 1000 });
    expect(a.id).toBe("voice");
    expect(a.capabilities.sendMedia || a.capabilities.sendTyping || a.capabilities.interactiveButtons).toBe(false);
    expect(a.getStatus().state).toBe("disconnected");
    await a.start(new AbortController().signal);
    expect(a.getStatus()).toMatchObject({ state: "error", lastError: "not ready: twilio.authToken" });
    reason = null;
    expect(a.getStatus().state).toBe("connected");
    await a.sendText({ ctx: { chatId: OWNER }, text: "Background task done." });
    expect(forward).toHaveBeenCalledWith("From your call:\nBackground task done.");
  });
});

describe("internal API /api/voice", () => {
  it("POST /calls is always agent-tool (asks the owner) and errors are JSON", async () => {
    h = await makeHarness({ approval: "denied" });
    const api = createVoiceInternalApi(h.service);
    const denied = await api.request("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "mom", message: "hi" }) });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toMatch(/did not approve/);
    expect(h.requestApproval).toHaveBeenCalledTimes(1);
    expect(h.fetchFn).not.toHaveBeenCalled();
    const raw = await api.request("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: MOM, message: "hi" }) });
    expect(((await raw.json()) as { error: string }).error).toMatch(/raw phone numbers/);
    const bad = await api.request("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("GET /calls lists with numbers masked; GET /calls/:id shows the reply as untrusted", async () => {
    h = await makeHarness({ approval: "approved" });
    const api = createVoiceInternalApi(h.service);
    const placed = await api.request("/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "mom", message: "hi" }) });
    const { callId } = (await placed.json()) as { callId: string };
    h.store.update(callId, { capturedReply: "ok thanks" });
    const list = await (await api.request("/calls")).text();
    expect(list).not.toContain(MOM);
    expect(list).toContain('"to":"mom"');
    const one = (await (await api.request(`/calls/${callId}`)).json()) as { reply: unknown; provider: string };
    expect(one.reply).toEqual({ text: "ok thanks", trust: "untrusted-transcript" });
    expect(one.provider).toBe("twilio");
    expect((await api.request("/calls/nope")).status).toBe(404);
    const hung = await api.request(`/calls/${callId}/hangup`, { method: "POST" });
    expect(hung.status).toBe(200);
  });
});
