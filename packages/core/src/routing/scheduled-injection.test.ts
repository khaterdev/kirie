import { describe, it, expect, vi } from "vitest";
import { ScheduledInjectionQueue } from "./scheduled-injection.js";
import type { InjectMessageResult } from "./pipeline.js";

const ev = (name = "brief") => ({ name, message: "m", channel: "telegram", chatId: "1" });

describe("ScheduledInjectionQueue", () => {
  it("re-queues a scheduled turn that a user message cut short, and delivers it later", async () => {
    let now = 0;
    const results: InjectMessageResult["status"][] = ["aborted", "ok"];
    const inject = vi.fn(async () => ({ status: results.shift()! }));
    const q = new ScheduledInjectionQueue({ inject, now: () => now });
    expect((await q.deliver(ev())).status).toBe("aborted");
    expect(q.pendingCount()).toBe(1);
    now += 30_000;
    await q.onTick();
    expect(inject).toHaveBeenCalledTimes(2);
    expect(q.pendingCount()).toBe(0);
  });

  it("coalesces repeat fires of a waiting schedule for the same chat", async () => {
    let now = 0;
    const inject = vi.fn(async (): Promise<InjectMessageResult> => ({ status: "busy" }));
    const notices: string[] = [];
    const q = new ScheduledInjectionQueue({ inject, now: () => now, notifyOwner: (t) => { notices.push(t); } });
    await q.deliver(ev());
    for (let i = 0; i < 5; i++) await q.deliver(ev());
    await q.deliver(ev("other"));
    expect(q.pendingCount()).toBe(2);
    expect(inject).toHaveBeenCalledTimes(2);
    now += 31 * 60_000;
    await q.onTick();
    expect(notices).toHaveLength(2);
  });

  it("drops channel-down and error results like before, and stop clears the queue", async () => {
    const q = new ScheduledInjectionQueue({ inject: async () => ({ status: "channel-down" }) });
    await q.deliver(ev());
    expect(q.pendingCount()).toBe(0);
    const busy = new ScheduledInjectionQueue({ inject: async () => ({ status: "busy" }) });
    await busy.deliver(ev());
    busy.stop();
    expect(busy.pendingCount()).toBe(0);
  });
});
