import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeartbeatLogStore } from "./heartbeat-logs.js";

const token = (): string => ["gh", "p_", "Lp0Ko9Ji8Hu7Gy6Ft5Dr4Se3Aw2Qz1Xc0Vb9Nm8"].join("");
const MARK = "«redacted:github-token»";

let dir: string;
let store: HeartbeatLogStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-hblog-test-"));
  store = new HeartbeatLogStore(join(dir, "heartbeat-logs.db"), null, { tier1: "debug", tier2: "debug", tier3: "debug", heartbeat: "debug" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("HeartbeatLogStore secret scrubbing", () => {
  it("redacts title, content and metadata before storing", () => {
    store.log({
      tick_number: 1,
      tier: "tier2",
      category: "triage",
      level: "info",
      title: `notify ${token()}`,
      content: `body ${token()}`,
      metadata: { nested: { value: token() }, list: [token()], n: 3 },
    });
    const [entry] = store.recent(5);
    expect(entry!.title).toBe(`notify ${MARK}`);
    expect(entry!.content).toBe(`body ${MARK}`);
    expect(entry!.metadata).not.toContain(token());
    expect(JSON.parse(entry!.metadata!)).toEqual({ nested: { value: MARK }, list: [MARK], n: 3 });
    expect(store.search(token().slice(4))).toEqual([]);
  });

  it("stores entries without secrets unchanged", () => {
    const metadata = { decision: "silent", signals: ["stuck-task:abc"], at: "2026-11-23T10:00:00Z" };
    store.log({ tick_number: 2, tier: "tier1", category: "signals", level: "info", title: "ok", content: "max_tokens=4096", metadata });
    const [entry] = store.recent(5);
    expect(entry!.title).toBe("ok");
    expect(entry!.content).toBe("max_tokens=4096");
    expect(entry!.metadata).toBe(JSON.stringify(metadata));
  });

  it("redacts secret-named metadata fields whose values have no recognisable prefix", () => {
    const value = ["Xk9", "mP2", "vLq7Rt"].join("");
    store.log({ tick_number: 3, tier: "tier3", category: "task", level: "warn", title: "t", content: "c",
      metadata: { apiKey: value, env: { DB_PASSWORD: value, HOME: "/Users/x" } } });
    const [entry] = store.recent(5);
    expect(entry!.metadata).not.toContain(value);
    expect(JSON.parse(entry!.metadata!)).toEqual({
      apiKey: "«redacted:secret-assignment»",
      env: { DB_PASSWORD: "«redacted:secret-assignment»", HOME: "/Users/x" },
    });
  });
});
