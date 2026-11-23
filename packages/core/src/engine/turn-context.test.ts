import { describe, it, expect } from "vitest";
import { TurnContextRegistry, originOf } from "./turn-context.js";
import type { SdkCallContext, SdkCallKind } from "./sdk-options.js";

function ctx(kind: SdkCallKind, sessionKey?: string): SdkCallContext {
  return { kind, ...(sessionKey ? { sessionKey } : {}), ownerDm: false, interactive: kind === "chat", label: kind, cwd: "/tmp" };
}

describe("TurnContextRegistry", () => {
  it("stores, replaces and ends a turn per session key", () => {
    const turns = new TurnContextRegistry();
    expect(turns.get("telegram:dm:1")).toBeUndefined();
    expect(turns.get(undefined)).toBeUndefined();

    turns.begin("telegram:dm:1", { origin: "owner_message", senderId: "1", senderRole: "owner", startedAt: 1 });
    expect(turns.get("telegram:dm:1")).toMatchObject({ origin: "owner_message", senderId: "1" });

    turns.begin("telegram:dm:1", { origin: "schedule", startedAt: 2 });
    expect(turns.get("telegram:dm:1")?.origin).toBe("schedule");

    turns.end("telegram:dm:1");
    expect(turns.get("telegram:dm:1")).toBeUndefined();
  });

  it("returns copies, so a reader cannot change the stored turn", () => {
    const turns = new TurnContextRegistry();
    turns.begin("k", { origin: "other_user", startedAt: 1 });
    turns.get("k")!.origin = "owner_message";
    expect(turns.get("k")?.origin).toBe("other_user");
  });
});

describe("originOf", () => {
  it("chat reads the registry and falls back to system", () => {
    const turns = new TurnContextRegistry();
    turns.begin("telegram:dm:1", { origin: "owner_message", startedAt: 1 });
    expect(originOf(ctx("chat", "telegram:dm:1"), turns)).toBe("owner_message");
    expect(originOf(ctx("chat", "telegram:dm:2"), turns)).toBe("system");
    expect(originOf(ctx("chat"), turns)).toBe("system");
  });

  it("task kinds map to their own origin, whatever the registry says", () => {
    const turns = new TurnContextRegistry();
    turns.begin("telegram:dm:1", { origin: "owner_message", startedAt: 1 });
    expect(originOf(ctx("background", "telegram:dm:1"), turns)).toBe("background");
    expect(originOf(ctx("goal", "telegram:dm:1"), turns)).toBe("goal");
    expect(originOf(ctx("webhook", "telegram:dm:1"), turns)).toBe("webhook");
    for (const kind of ["judge", "triage", "oneshot", "utility"] as const) {
      expect(originOf(ctx(kind, "telegram:dm:1"), turns)).toBe("system");
    }
  });
});
