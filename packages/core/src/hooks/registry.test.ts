import { describe, it, expect, vi } from "vitest";
import { HookRegistry, boundPayload, frozenCopy } from "./registry.js";
import type { AfterMessageEvent, BeforeMessageEvent, OnErrorEvent } from "./types.js";

function before(text = "hello", over: Partial<BeforeMessageEvent> = {}): BeforeMessageEvent {
  return { type: "beforeMessage", sessionKey: "telegram:dm:1001", channel: "telegram", senderId: "1001", chatId: "1001", text, timestamp: 1, ...over };
}

function after(over: Partial<AfterMessageEvent> = {}): AfterMessageEvent {
  return {
    type: "afterMessage", sessionKey: "telegram:dm:1001", channel: "telegram", senderId: "1001", chatId: "1001",
    origin: "owner_message", inputText: "hi", responseText: "hello", isError: false, durationMs: 5, ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A fake secret built at run time, matching the scrubber's GitHub token rule. */
const FAKE_SECRET = ["ghp", "_", "A".repeat(18), "b".repeat(18)].join("");

describe("HookRegistry registration", () => {
  it("registers, counts and disposes", () => {
    const reg = new HookRegistry();
    const dispose = reg.register("afterMessage", () => {});
    reg.register("onError", () => {}, { pluginName: "p" });
    expect(reg.count()).toBe(2);
    expect(reg.count("afterMessage")).toBe(1);
    dispose();
    expect(reg.count("afterMessage")).toBe(0);
    expect(reg.unregisterPlugin("p")).toBe(1);
    expect(reg.count()).toBe(0);
  });

  it("only beforeMessage may register a transform", () => {
    const reg = new HookRegistry();
    expect(() => reg.register("afterMessage", () => {}, { mode: "transform" })).toThrow(/only beforeMessage/);
    expect(() => reg.register("beforeMessage", () => {}, { mode: "transform" })).not.toThrow();
  });

  it("rejects a non-function handler", () => {
    const reg = new HookRegistry();
    expect(() => reg.register("afterMessage", "nope" as never)).toThrow(/function/);
  });

  it("clear removes everything", () => {
    const reg = new HookRegistry();
    reg.register("afterMessage", () => {}, { pluginName: "a" });
    reg.clear();
    expect(reg.count()).toBe(0);
    expect(reg.hasSubscribers("afterMessage")).toBe(false);
  });
});

describe("HookRegistry observers", () => {
  it("emit returns before any handler runs, and handlers run later", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("afterMessage", (e) => { seen.push(e.responseText); }, { pluginName: "a" });
    reg.emit(after());
    expect(seen).toEqual([]);
    await reg.whenIdle();
    expect(seen).toEqual(["hello"]);
  });

  it("a slow observer does not delay emit", async () => {
    const reg = new HookRegistry({ hookTimeoutMs: 5_000 });
    reg.register("afterMessage", () => sleep(1_000), { pluginName: "slow" });
    const t0 = Date.now();
    reg.emit(after());
    expect(Date.now() - t0).toBeLessThan(50);
    reg.clear();
  });

  it("a synchronous throw never reaches the caller and is counted", async () => {
    const reg = new HookRegistry();
    reg.register("afterMessage", () => { throw new Error("boom"); }, { pluginName: "bad" });
    expect(() => reg.emit(after())).not.toThrow();
    await reg.whenIdle();
    expect(reg.stats("bad").totalFailures).toBe(1);
    expect(reg.stats("bad").lastError).toMatch(/boom/);
  });

  it("each handler gets its own frozen copy; mutation neither throws through nor leaks", async () => {
    const reg = new HookRegistry();
    const original = after();
    const seenByB: string[] = [];
    reg.register("afterMessage", (e) => { (e as { responseText: string }).responseText = "hacked"; }, { pluginName: "a", priority: 1 });
    reg.register("afterMessage", (e) => { seenByB.push(e.responseText); }, { pluginName: "b", priority: 2 });
    reg.emit(original);
    await reg.whenIdle();
    expect(original.responseText).toBe("hello");
    expect(seenByB).toEqual(["hello"]);
    expect(reg.stats("a").totalFailures).toBe(1); // assignment to a frozen object throws in strict mode
  });

  it("payloads are scrubbed", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("afterMessage", (e) => { seen.push(e.responseText); }, { pluginName: "a" });
    reg.emit(after({ responseText: `token ${FAKE_SECRET} here` }));
    await reg.whenIdle();
    expect(seen[0]).not.toContain(FAKE_SECRET);
    expect(seen[0]).toContain("redacted");
  });

  it("scrubbing can be turned off by config", async () => {
    const reg = new HookRegistry({ scrubPayloads: false });
    const seen: string[] = [];
    reg.register("afterMessage", (e) => { seen.push(e.responseText); }, { pluginName: "a" });
    reg.emit(after({ responseText: FAKE_SECRET }));
    await reg.whenIdle();
    expect(seen[0]).toBe(FAKE_SECRET);
  });

  it("observer handlers of one plugin run one at a time; the queue is bounded and drops the oldest", async () => {
    const reg = new HookRegistry({ maxQueuedEventsPerPlugin: 3, hookTimeoutMs: 1_000 });
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    reg.register("afterMessage", async (e) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      seen.push(e.durationMs);
      active -= 1;
    }, { pluginName: "q" });
    for (let i = 0; i < 10; i++) reg.emit(after({ durationMs: i }));
    expect(reg.stats("q").dropped).toBe(7);
    await reg.whenIdle();
    expect(seen).toEqual([7, 8, 9]);
    expect(maxActive).toBe(1);
  });

  it("a timed-out observer counts as a failure", async () => {
    const reg = new HookRegistry({ hookTimeoutMs: 100 });
    reg.register("afterMessage", () => sleep(300), { pluginName: "t" });
    reg.emit(after());
    await reg.whenIdle();
    expect(reg.stats("t").totalFailures).toBe(1);
    expect(reg.stats("t").lastError).toMatch(/timed out/);
  });

  it("the breaker suspends after N failures in a row, calls onSuspend once, and resume resets it", async () => {
    const onSuspend = vi.fn();
    const reg = new HookRegistry({ maxConsecutiveFailures: 3, onSuspend });
    let calls = 0;
    reg.register("onError", () => { calls += 1; throw new Error("x"); }, { pluginName: "flaky" });
    const err: OnErrorEvent = { type: "onError", source: "pipeline", name: "Error", message: "m" };
    for (let i = 0; i < 5; i++) {
      reg.emit(err);
      await reg.whenIdle();
    }
    expect(calls).toBe(3);
    expect(reg.isSuspended("flaky")).toBe(true);
    expect(reg.hasSubscribers("onError")).toBe(false);
    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(onSuspend).toHaveBeenCalledWith("flaky", expect.objectContaining({ consecutiveFailures: 3 }));
    reg.resume("flaky");
    expect(reg.isSuspended("flaky")).toBe(false);
    reg.emit(err);
    await reg.whenIdle();
    expect(calls).toBe(4);
  });

  it("a success resets the failure streak", async () => {
    const reg = new HookRegistry({ maxConsecutiveFailures: 2 });
    let n = 0;
    reg.register("onError", () => { n += 1; if (n % 2 === 1) throw new Error("odd"); }, { pluginName: "alt" });
    const err: OnErrorEvent = { type: "onError", source: "pipeline", name: "Error", message: "m" };
    for (let i = 0; i < 6; i++) {
      reg.emit(err);
      await reg.whenIdle();
    }
    expect(reg.isSuspended("alt")).toBe(false);
    expect(reg.stats("alt").totalFailures).toBe(3);
  });

  it("one failing plugin does not stop another", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("afterMessage", () => { throw new Error("bad"); }, { pluginName: "bad", priority: 1 });
    reg.register("afterMessage", (e) => { seen.push(e.responseText); }, { pluginName: "good", priority: 2 });
    reg.emit(after());
    await reg.whenIdle();
    expect(seen).toEqual(["hello"]);
  });

  it("unregisterPlugin drops queued events", async () => {
    const reg = new HookRegistry();
    const seen: number[] = [];
    reg.register("afterMessage", (e) => { seen.push(e.durationMs); }, { pluginName: "gone" });
    reg.emit(after({ durationMs: 1 }));
    reg.unregisterPlugin("gone");
    await reg.whenIdle();
    expect(seen).toEqual([]);
  });
});

describe("HookRegistry beforeMessage transform", () => {
  it("replaces text only; identity fields always come from the original", async () => {
    const reg = new HookRegistry();
    reg.register("beforeMessage", () => ({ type: "beforeMessage", text: "rewritten", senderId: "evil", channel: "x", chatId: "y", sessionKey: "z" }), { mode: "transform", pluginName: "t" });
    const out = await reg.transformMessage(before("hello"));
    expect(out.text).toBe("rewritten");
    expect(out.senderId).toBe("1001");
    expect(out.channel).toBe("telegram");
    expect(out.chatId).toBe("1001");
    expect(out.sessionKey).toBe("telegram:dm:1001");
  });

  it("observe-mode beforeMessage handlers cannot change the text", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("beforeMessage", (e) => { seen.push(e.text); return { text: "nope" }; }, { pluginName: "o" });
    const out = await reg.dispatch(before("hello"));
    expect(out.text).toBe("hello");
    await reg.whenIdle();
    expect(seen).toEqual(["hello"]);
  });

  it("transforms chain in priority order and observers see the final text", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("beforeMessage", (e) => ({ text: `${e.text}-b` }), { mode: "transform", priority: 2, pluginName: "b" });
    reg.register("beforeMessage", (e) => ({ text: `${e.text}-a` }), { mode: "transform", priority: 1, pluginName: "a" });
    reg.register("beforeMessage", (e) => { seen.push(e.text); }, { pluginName: "o" });
    const out = await reg.dispatch(before("x"));
    expect(out.text).toBe("x-a-b");
    await reg.whenIdle();
    expect(seen).toEqual(["x-a-b"]);
  });

  it("ignores non-text return values and throwing transforms", async () => {
    const reg = new HookRegistry();
    reg.register("beforeMessage", () => 42, { mode: "transform", priority: 1, pluginName: "num" });
    reg.register("beforeMessage", () => { throw new Error("boom"); }, { mode: "transform", priority: 2, pluginName: "boom" });
    reg.register("beforeMessage", async () => { throw new Error("rej"); }, { mode: "transform", priority: 3, pluginName: "rej" });
    const out = await reg.transformMessage(before("keep"));
    expect(out.text).toBe("keep");
    expect(reg.stats("boom").totalFailures).toBe(1);
    expect(reg.stats("rej").totalFailures).toBe(1);
  });

  it("a hanging transform times out and the original text continues", async () => {
    const reg = new HookRegistry({ hookTimeoutMs: 100 });
    reg.register("beforeMessage", () => new Promise(() => {}), { mode: "transform", pluginName: "hang" });
    const t0 = Date.now();
    const out = await reg.transformMessage(before("orig"));
    expect(out.text).toBe("orig");
    expect(Date.now() - t0).toBeLessThan(400);
    expect(reg.stats("hang").totalFailures).toBe(1);
  });

  it("the total budget is shared: later handlers are skipped once it is spent", async () => {
    const reg = new HookRegistry({ hookTimeoutMs: 150 });
    const late = vi.fn(() => ({ text: "late" }));
    reg.register("beforeMessage", async (e) => { await sleep(120); return { text: `${e.text}!` }; }, { mode: "transform", priority: 1, pluginName: "slow1" });
    reg.register("beforeMessage", async (e) => { await sleep(100); return { text: `${e.text}?` }; }, { mode: "transform", priority: 2, pluginName: "slow2" });
    reg.register("beforeMessage", late, { mode: "transform", priority: 3, pluginName: "late" });
    const t0 = Date.now();
    const out = await reg.transformMessage(before("m"));
    expect(Date.now() - t0).toBeLessThan(350);
    expect(out.text).toBe("m!");
    expect(late).not.toHaveBeenCalled();
  });

  it("a transform gets the raw, untruncated text, so rewriting never cuts or redacts the message", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("beforeMessage", (e) => { seen.push(e.text); return { text: `${e.text}!` }; }, { mode: "transform", pluginName: "raw" });
    const original = `my key ${FAKE_SECRET} ${"x".repeat(20_000)}`;
    const out = await reg.transformMessage(before(original));
    expect(seen[0]).toBe(original);
    expect(out.text).toBe(`${original}!`);
  });

  it("observers of beforeMessage still get scrubbed text", async () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("beforeMessage", (e) => { seen.push(e.text); }, { pluginName: "obs" });
    await reg.dispatch(before(`my key ${FAKE_SECRET}`));
    await reg.whenIdle();
    expect(seen[0]).not.toContain(FAKE_SECRET);
  });

  it("caps the length of transformed text", async () => {
    const reg = new HookRegistry();
    reg.register("beforeMessage", () => ({ text: "x".repeat(300_000) }), { mode: "transform", pluginName: "big" });
    const out = await reg.transformMessage(before("a"));
    expect(out.text.length).toBe(200_000);
  });

  it("with no transform registered, returns the same event", async () => {
    const reg = new HookRegistry();
    const ev = before("same");
    expect(await reg.transformMessage(ev)).toBe(ev);
  });
});

describe("payload helpers", () => {
  it("boundPayload caps strings, arrays, keys and depth, cuts cycles and drops functions", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const deep = { l1: { l2: { l3: { l4: "x" } } } };
    const out = boundPayload(
      { s: "y".repeat(50), arr: [1, 2, 3, 4, 5], fn: () => 1, cyclic, deep, big: BigInt(7), d: new Date(0), e: new Error("bad") },
      { maxStringChars: 10, maxArrayItems: 3, maxKeys: 20, maxDepth: 4, maxNodes: 1000 },
    ) as Record<string, unknown>;
    expect(out.s).toBe(`${"y".repeat(10)}…[truncated]`);
    expect(out.arr).toEqual([1, 2, 3, "[2 more]"]);
    expect("fn" in out).toBe(false);
    expect((out.cyclic as Record<string, unknown>).self).toBe("[circular]");
    expect((((out.deep as Record<string, unknown>).l1 as Record<string, unknown>).l2 as Record<string, unknown>).l3).toBe("[depth limit]");
    expect(out.big).toBe("7");
    expect(out.d).toBe("1970-01-01T00:00:00.000Z");
    expect(out.e).toEqual({ name: "Error", message: "bad" });
    expect(() => structuredClone(out)).not.toThrow();
  });

  it("boundPayload caps the total number of values", () => {
    const wide = Array.from({ length: 50 }, () => Array.from({ length: 50 }, (_, i) => i));
    const out = boundPayload(wide, { maxStringChars: 100, maxArrayItems: 100, maxKeys: 100, maxDepth: 6, maxNodes: 200 });
    expect(JSON.stringify(out)).toContain("[size limit]");
    expect(JSON.stringify(out).length).toBeLessThan(5_000);
  });

  it("frozenCopy returns a deep-frozen clone", () => {
    const src = { a: { b: [1, { c: 2 }] } };
    const copy = frozenCopy(src);
    expect(copy).toEqual(src);
    expect(copy).not.toBe(src);
    expect(Object.isFrozen(copy.a.b[1])).toBe(true);
    expect(Object.isFrozen(src.a)).toBe(false);
  });
});
