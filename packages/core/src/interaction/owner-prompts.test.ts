import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail } from "../security/audit-trail.js";
import { OwnerDirectory } from "./owners.js";
import { InteractionRouter, INTERACTION_EXPIRED_TEXT } from "./router.js";
import { OwnerPrompts, type OwnerAskRequest, type OwnerAskResult } from "./owner-prompts.js";
import { makeFakeAdapter, makeFakeRegistry, type FakeAdapter } from "./fake-channel.test-util.js";

const OWNER = "1001";
const none = { telegram: [], discord: [], whatsapp: [], signal: [], slack: [] };

/** Let pending promise callbacks (the card send) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function req(over: Partial<OwnerAskRequest> = {}): OwnerAskRequest {
  return {
    kind: "goal",
    title: "Start goal g-1?",
    body: "Build the thing",
    options: [
      { id: "start", label: "Start" },
      { id: "decline", label: "Decline" },
    ],
    defaultOptionId: "decline",
    timeoutMs: 60_000,
    ...over,
  };
}

describe("OwnerPrompts", () => {
  let dir: string;
  let audit: AuditTrail;
  let adapter: FakeAdapter;
  let registry: ReturnType<typeof makeFakeRegistry>;
  let owners: OwnerDirectory;
  let router: InteractionRouter;
  let prompts: OwnerPrompts;

  function build(opts: { maxPending?: number; scrub?: (t: string) => string; adapter?: FakeAdapter; owners?: OwnerDirectory } = {}): void {
    adapter = opts.adapter ?? makeFakeAdapter("telegram");
    registry = makeFakeRegistry([adapter]);
    owners = opts.owners ?? new OwnerDirectory({ ...none, telegram: [OWNER] });
    router = new InteractionRouter({ channelRegistry: registry, owners, audit });
    router.attach(adapter);
    prompts = new OwnerPrompts({ router, channelRegistry: registry, owners, audit, maxPending: opts.maxPending ?? 10, scrub: opts.scrub });
  }

  /** The callback data of the given option on the last interactive card. */
  function dataFor(optionLabel: string): string {
    const card = adapter.sentInteractive.at(-1)!;
    const btn = card.buttons.flat().find((b) => b.label === optionLabel)!;
    return btn.data!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "kirie-prompts-test-"));
    audit = new AuditTrail(join(dir, "audit.jsonl"));
    build();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  async function sentMessageId(): Promise<string> {
    const results = (adapter.sendInteractive as ReturnType<typeof vi.fn>).mock.results;
    const last = results[results.length - 1]!.value as Promise<{ id: string }>;
    return (await last).id;
  }

  it("sends the card to the owner's DM with one button per option and a code", async () => {
    const p = prompts.ask(req());
    await flush();
    expect(adapter.sentInteractive).toHaveLength(1);
    const card = adapter.sentInteractive[0]!;
    expect(card.ctx.chatId).toBe(OWNER);
    expect(card.plain).toBe(true);
    expect(card.text).toContain("Start goal g-1?");
    expect(card.text).toContain("Build the thing");
    expect(card.text).toMatch(/Code [A-Z2-9]{4}/);
    expect(card.buttons.flat().map((b) => b.label)).toEqual(["Start", "Decline"]);
    for (const b of card.buttons.flat()) {
      expect(b.data).toMatch(/^k1\|ask\|[0-9a-f]{16}:(start|decline)$/);
    }
    expect(prompts.pending()).toHaveLength(1);
    prompts.cancelAll("test");
    await p;
  });

  it("resolves once with the pressed option and removes the keyboard", async () => {
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    await adapter.press({ data: dataFor("Start"), messageId });
    const res = await p;
    expect(res).toMatchObject({ optionId: "start", outcome: "answered", answeredBy: `owner:telegram:${OWNER}` });
    expect(res.code).toMatch(/^[A-Z2-9]{4}$/);
    await flush();
    const update = adapter.updates.at(-1)!;
    expect(update.messageId).toBe(messageId);
    expect(update.buttons).toBeNull();
    expect(update.text).toMatch(/Start \d{2}:\d{2}$/);
    expect(adapter.acks.at(-1)).toMatchObject({ text: "Start" });
    expect(prompts.pending()).toEqual([]);
  });

  it("answers a second press with Expired and does not change the result", async () => {
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    await adapter.press({ data: dataFor("Start"), messageId });
    await adapter.press({ data: dataFor("Decline"), messageId });
    expect((await p).optionId).toBe("start");
    expect(adapter.acks.at(-1)).toMatchObject({ text: INTERACTION_EXPIRED_TEXT });
  });

  it("rejects a press with the wrong messageId (look-alike keyboard)", async () => {
    const p = prompts.ask(req());
    await flush();
    await adapter.press({ data: dataFor("Start"), messageId: "999999" });
    expect(adapter.acks.at(-1)).toMatchObject({ text: INTERACTION_EXPIRED_TEXT });
    expect(prompts.pending()).toHaveLength(1);
    expect(audit.recent({ feature: "prompts", action: "prompt.mismatch" })).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect((await p).outcome).toBe("timeout");
  });

  it("rejects a press for an option the prompt does not have", async () => {
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    const forged = dataFor("Start").replace(":start", ":approve");
    await adapter.press({ data: forged, messageId });
    expect(adapter.acks.at(-1)).toMatchObject({ text: INTERACTION_EXPIRED_TEXT });
    expect(prompts.pending()).toHaveLength(1);
    prompts.cancelAll("test");
    expect((await p).outcome).toBe("cancelled");
  });

  it("ignores a non-owner press and a group press (router), leaving the prompt open", async () => {
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    await adapter.press({ data: dataFor("Start"), messageId, senderId: "2002", chatId: "2002" });
    await adapter.press({ data: dataFor("Start"), messageId, chatType: "group", chatId: "-100" });
    expect(prompts.pending()).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(await p).toMatchObject({ optionId: "decline", outcome: "timeout" });
  });

  it("rejects a press from a second owner whose chat is not the one the prompt went to", async () => {
    build({ owners: new OwnerDirectory({ ...none, telegram: [OWNER, "1002"] }) });
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    await adapter.press({ data: dataFor("Start"), messageId, senderId: "1002", chatId: "1002" });
    expect(adapter.acks.at(-1)).toMatchObject({ text: INTERACTION_EXPIRED_TEXT });
    expect(prompts.pending()).toHaveLength(1);
    await adapter.press({ data: dataFor("Start"), messageId });
    expect(await p).toMatchObject({ optionId: "start", answeredBy: `owner:telegram:${OWNER}` });
  });

  it("answers Expired to a press on a prompt from before a restart", async () => {
    const p = prompts.ask(req());
    await flush();
    const messageId = await sentMessageId();
    const data = dataFor("Start");
    prompts.cancelAll("shutdown");
    await p;
    // A fresh daemon: new router, new prompts, same channel.
    const restarted = makeFakeAdapter("telegram");
    const reg2 = makeFakeRegistry([restarted]);
    const router2 = new InteractionRouter({ channelRegistry: reg2, owners, audit });
    router2.attach(restarted);
    new OwnerPrompts({ router: router2, channelRegistry: reg2, owners, audit, maxPending: 10 });
    await restarted.press({ data, messageId });
    expect(restarted.acks).toEqual([expect.objectContaining({ text: INTERACTION_EXPIRED_TEXT })]);
  });

  it("returns the default on timeout and edits the card", async () => {
    const p = prompts.ask(req());
    await flush();
    vi.advanceTimersByTime(59_999);
    expect(prompts.pending()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const res = await p;
    expect(res).toMatchObject({ optionId: "decline", outcome: "timeout" });
    await flush();
    expect(adapter.updates.at(-1)!.text).toMatch(/Timed out, default: Decline$/);
    expect(adapter.updates.at(-1)!.buttons).toBeNull();
  });

  it("returns cancelled with the default when the signal aborts", async () => {
    const ac = new AbortController();
    const p = prompts.ask(req({ signal: ac.signal }));
    await flush();
    ac.abort();
    expect(await p).toMatchObject({ optionId: "decline", outcome: "cancelled" });
    await flush();
    expect(adapter.updates.at(-1)!.text).toMatch(/Cancelled$/);
  });

  it("returns cancelled at once for an already-aborted signal", async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await prompts.ask(req({ signal: ac.signal }))).toMatchObject({ optionId: "decline", outcome: "cancelled" });
    expect(adapter.sentInteractive).toEqual([]);
  });

  it("is unavailable when no owner is configured", async () => {
    build({ owners: new OwnerDirectory(none) });
    expect(await prompts.ask(req())).toMatchObject({ optionId: "decline", outcome: "unavailable" });
    expect(adapter.sentInteractive).toEqual([]);
  });

  it("is unavailable when the owner channel is down", async () => {
    registry.running.clear();
    expect(await prompts.ask(req())).toMatchObject({ optionId: "decline", outcome: "unavailable" });
  });

  it("is unavailable when maxPending is reached", async () => {
    build({ maxPending: 1 });
    const first = prompts.ask(req());
    await flush();
    expect(await prompts.ask(req())).toMatchObject({ optionId: "decline", outcome: "unavailable" });
    prompts.cancelAll("test");
    await first;
  });

  it("is unavailable when sending fails", async () => {
    (adapter.sendInteractive as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("blocked"));
    const res = await prompts.ask(req());
    expect(res).toMatchObject({ optionId: "decline", outcome: "unavailable" });
    expect(prompts.pending()).toEqual([]);
  });

  it("rejects invalid requests as unavailable without sending", async () => {
    const bad: Array<Partial<OwnerAskRequest>> = [
      { options: [{ id: "only", label: "Only" }] },
      { options: [{ id: "Bad", label: "x" }, { id: "b", label: "y" }] },
      { options: [{ id: "a", label: "x" }, { id: "a", label: "y" }] },
      { defaultOptionId: "missing" },
      { title: "" },
    ];
    for (const b of bad) {
      const res = await prompts.ask(req(b));
      expect(res.outcome).toBe("unavailable");
    }
    expect(adapter.sentInteractive).toEqual([]);
  });

  it("clamps the timeout to at least 5 s", async () => {
    const p = prompts.ask(req({ timeoutMs: 10 }));
    await flush();
    vi.advanceTimersByTime(4_999);
    expect(prompts.pending()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect((await p).outcome).toBe("timeout");
  });

  it("scrubs and truncates the title and body", async () => {
    build({ scrub: (t) => t.replaceAll("SECRETVALUE", "«redacted:test»") });
    const p = prompts.ask(req({ title: "key SECRETVALUE", body: "SECRETVALUE " + "x".repeat(5000) }));
    await flush();
    const text = adapter.sentInteractive[0]!.text;
    expect(text).not.toContain("SECRETVALUE");
    expect(text).toContain("«redacted:test»");
    expect(text.length).toBeLessThan(3400);
    prompts.cancelAll("test");
    await p;
  });

  it("falls back to text with /answer instructions when the channel has no buttons", async () => {
    build({ adapter: makeFakeAdapter("telegram", { buttons: false }) });
    const p = prompts.ask(req());
    await flush();
    const text = adapter.sentText[0]!.text;
    const code = /Reply \/answer ([A-Z2-9]{4}) <option>/.exec(text)![1]!;
    expect(text).toContain("start (Start)");
    expect(prompts.answerByCode(code, "start", { channel: "telegram", senderId: OWNER })).toBe("ok");
    expect(await p).toMatchObject({ optionId: "start", outcome: "answered" });
    await flush();
    expect(adapter.edits.at(-1)!.text).toMatch(/Start \d{2}:\d{2}$/);
  });

  describe("answerByCode", () => {
    it("answers by code, case-insensitively", async () => {
      const p = prompts.ask(req());
      await flush();
      const { code } = prompts.pending()[0]!;
      expect(prompts.answerByCode(code.toLowerCase(), "START", { channel: "telegram", senderId: OWNER })).toBe("ok");
      expect(await p).toMatchObject({ optionId: "start", outcome: "answered", code });
    });

    it("refuses non-owners, unknown codes and bad options", async () => {
      const p = prompts.ask(req());
      await flush();
      const { code } = prompts.pending()[0]!;
      expect(prompts.answerByCode(code, "start", { channel: "telegram", senderId: "2002" })).toBe("not-owner");
      expect(prompts.answerByCode("ZZZZ", "start", { channel: "telegram", senderId: OWNER })).toBe("not-found");
      expect(prompts.answerByCode(code, "approve", { channel: "telegram", senderId: OWNER })).toBe("bad-option");
      expect(prompts.pending()).toHaveLength(1);
      expect(prompts.answerByCode(code, "start", { channel: "telegram", senderId: OWNER })).toBe("ok");
      expect(prompts.answerByCode(code, "start", { channel: "telegram", senderId: OWNER })).toBe("not-found");
      await p;
    });
  });

  describe("requestApproval", () => {
    it("maps approve to approved and defaults to deny", async () => {
      const p = prompts.requestApproval({ kind: "approval", title: "Run rm -rf build?", timeoutMs: 30_000 });
      await flush();
      const labels = adapter.sentInteractive[0]!.buttons.flat().map((b) => b.label);
      expect(labels).toEqual(["Approve", "Deny"]);
      await adapter.press({ data: dataFor("Approve"), messageId: await sentMessageId() });
      expect(await p).toMatchObject({ outcome: "approved", optionId: "approve" });
    });

    it("maps deny and the extra option to denied", async () => {
      const p1 = prompts.requestApproval({ kind: "approval", title: "x", timeoutMs: 30_000, extra: { id: "stop", label: "Deny + stop" } });
      await flush();
      expect(adapter.sentInteractive[0]!.buttons.flat().map((b) => b.label)).toEqual(["Approve", "Deny", "Deny + stop"]);
      await adapter.press({ data: dataFor("Deny + stop"), messageId: await sentMessageId() });
      expect(await p1).toMatchObject({ outcome: "denied", optionId: "stop" });

      const p2 = prompts.requestApproval({ kind: "approval", title: "y", timeoutMs: 30_000 });
      await flush();
      await adapter.press({ data: dataFor("Deny"), messageId: await sentMessageId() });
      expect(await p2).toMatchObject({ outcome: "denied", optionId: "deny" });
    });

    it("returns timeout with optionId deny when nobody answers", async () => {
      const p = prompts.requestApproval({ kind: "approval", title: "x", timeoutMs: 30_000 });
      await flush();
      vi.advanceTimersByTime(30_000);
      expect(await p).toMatchObject({ outcome: "timeout", optionId: "deny" });
    });

    it("returns unavailable with optionId deny with no owner channel", async () => {
      registry.running.clear();
      expect(await prompts.requestApproval({ kind: "approval", title: "x", timeoutMs: 30_000 })).toMatchObject({ outcome: "unavailable", optionId: "deny" });
    });

    it("uses custom labels (Confirm / Cancel) and the /approve text fallback", async () => {
      build({ adapter: makeFakeAdapter("telegram", { buttons: false }) });
      const p = prompts.requestApproval({ kind: "confirm", title: "Switch to yolo?", timeoutMs: 30_000, labels: { approve: "Confirm", deny: "Cancel" } });
      await flush();
      const text = adapter.sentText[0]!.text;
      const code = /Reply \/approve ([A-Z2-9]{4}) or \/deny \1/.exec(text)![1]!;
      expect(prompts.answerByCode(code, "deny", { channel: "telegram", senderId: OWNER })).toBe("ok");
      expect(await p).toMatchObject({ outcome: "denied" });
    });
  });

  describe("cancelAll", () => {
    it("resolves every pending prompt with its default and refuses new asks", async () => {
      const a = prompts.ask(req());
      const b = prompts.requestApproval({ kind: "approval", title: "x", timeoutMs: 30_000 });
      await flush();
      prompts.cancelAll("shutdown");
      expect(await a).toMatchObject({ optionId: "decline", outcome: "cancelled" });
      expect(await b).toMatchObject({ outcome: "cancelled", optionId: "deny" });
      await flush();
      expect(adapter.updates.at(-1)!.text).toMatch(/Cancelled \(shutdown\)$/);
      expect(prompts.pending()).toEqual([]);
      expect(await prompts.ask(req())).toMatchObject({ outcome: "unavailable" });
      expect(await prompts.sendCard({ text: "x" })).toBeNull();
    });

    it("makes a later press on a cancelled prompt Expired", async () => {
      const p = prompts.ask(req());
      await flush();
      const messageId = await sentMessageId();
      const data = dataFor("Start");
      prompts.cancelAll("shutdown");
      await p;
      await adapter.press({ data, messageId });
      expect(adapter.acks.at(-1)).toMatchObject({ text: INTERACTION_EXPIRED_TEXT });
    });

    it("finishes a prompt resolved while its card was still sending", async () => {
      let release!: (v: { id: string; timestamp: number }) => void;
      (adapter.sendInteractive as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => new Promise((r) => { release = r; }),
      );
      const p = prompts.ask(req());
      await flush();
      prompts.cancelAll("shutdown");
      expect((await p).outcome).toBe("cancelled");
      release({ id: "4242", timestamp: 0 });
      await flush();
      expect(adapter.updates.at(-1)).toMatchObject({ messageId: "4242", buttons: null });
      expect(adapter.updates.at(-1)!.text).toMatch(/Cancelled \(shutdown\)$/);
    });
  });

  describe("durable cards", () => {
    it("sends a card with namespaced buttons to the owner DM and routes presses to onAction", async () => {
      const handler = vi.fn(async () => ({ toast: "Applied", removeButtons: true }));
      prompts.onAction("prop", handler);
      const sent = await prompts.sendCard({
        text: "Proposal 42: remember the build command",
        buttons: [[
          { label: "Approve", ns: "prop", action: "a:42:deadbeef" },
          { label: "Reject", ns: "prop", action: "r:42:deadbeef" },
        ]],
      });
      expect(sent).toEqual({ channel: "telegram", chatId: OWNER, messageId: expect.any(String) });
      const card = adapter.sentInteractive[0]!;
      expect(card.buttons[0]!.map((b) => b.data)).toEqual(["k1|prop|a:42:deadbeef", "k1|prop|r:42:deadbeef"]);
      await adapter.press({ data: "k1|prop|a:42:deadbeef", messageId: sent!.messageId });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ ns: "prop", action: "a:42:deadbeef", messageId: sent!.messageId }));
      expect(adapter.updates.at(-1)).toMatchObject({ buttons: null });
    });

    it("throws on a duplicate namespace, including the reserved ask namespace", () => {
      prompts.onAction("prop", vi.fn());
      expect(() => prompts.onAction("prop", vi.fn())).toThrow();
      expect(() => prompts.onAction("ask", vi.fn())).toThrow();
    });

    it("returns null with no owner or channel down, and for invalid buttons", async () => {
      registry.running.clear();
      expect(await prompts.sendCard({ text: "x" })).toBeNull();
      registry.running.add("telegram");
      expect(await prompts.sendCard({ text: "x", buttons: [[{ label: "A", ns: "prop", action: "x".repeat(80) }]] })).toBeNull();
      build({ owners: new OwnerDirectory(none) });
      expect(await prompts.sendCard({ text: "x" })).toBeNull();
    });

    it("sends a card without buttons as text, scrubbed", async () => {
      build({ scrub: (t) => t.replaceAll("SECRETVALUE", "«redacted:test»") });
      const sent = await prompts.sendCard({ text: "note SECRETVALUE" });
      expect(sent).not.toBeNull();
      expect(adapter.sentText[0]!.text).toBe("note «redacted:test»");
      expect(adapter.sentText[0]!.plain).toBe(true);
    });
  });

  it("audits sent and resolved prompts without the body", async () => {
    const p = prompts.ask(req({ body: "private body text" }));
    await flush();
    vi.advanceTimersByTime(60_000);
    await p;
    const recs = audit.recent({ feature: "prompts" });
    expect(recs.map((r) => r.action)).toEqual(["prompt.timeout", "prompt.sent"]);
    expect(JSON.stringify(recs)).not.toContain("private body text");
  });

  it("never rejects", async () => {
    const results: OwnerAskResult[] = [];
    results.push(await prompts.ask(undefined as unknown as OwnerAskRequest));
    expect(results[0]!.outcome).toBe("unavailable");
  });
});
