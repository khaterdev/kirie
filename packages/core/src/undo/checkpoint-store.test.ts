import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UndoCheckpointStore, type NewUndoCheckpoint } from "./checkpoint-store.js";

let dir: string;
let store: UndoCheckpointStore;
let n = 0;

function row(over: Partial<NewUndoCheckpoint> = {}): NewUndoCheckpoint {
  n++;
  return {
    sessionKey: "telegram:dm:1",
    sdkSessionId: "sid-1",
    userMessageUuid: `uuid-${n}`,
    accountId: null,
    configDir: null,
    cwd: "/work",
    source: "chat",
    promptPreview: "fix it",
    createdAt: 1_000 + n,
    ...over,
  };
}

const activity = (files: string[], extra: Partial<{ created: string[]; sub: string[]; bash: number }> = {}) => ({
  filesChanged: files,
  filesCreated: extra.created ?? [],
  subagentFiles: extra.sub ?? [],
  bashCount: extra.bash ?? 0,
  bashSamples: [],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kirie-undo-store-"));
  store = new UndoCheckpointStore(join(dir, "checkpoints.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("UndoCheckpointStore", () => {
  it("creates the database file 0600", () => {
    expect(statSync(join(dir, "checkpoints.db")).mode & 0o777).toBe(0o600);
  });

  it("migration is idempotent", () => {
    store.insert(row());
    store.close();
    store = new UndoCheckpointStore(join(dir, "checkpoints.db"));
    expect(store.count()).toBe(1);
  });

  it("inserts, records activity, completes and reads back", () => {
    const id = store.insert(row({ sdkSessionId: null }));
    store.setSdkSessionId(id, "sid-x");
    store.setSdkSessionId(id, "sid-other"); // first id wins
    store.setActivity(id, { filesChanged: ["/work/a.ts"], filesCreated: ["/work/new.md"], subagentFiles: ["/work/s.ts"], bashCount: 2, bashSamples: ["ls", "pwd"] });
    store.complete(id, 5_000);
    store.complete(id, 9_000);
    const r = store.get(id)!;
    expect(r).toMatchObject({
      sdkSessionId: "sid-x",
      filesChanged: ["/work/a.ts"],
      filesCreated: ["/work/new.md"],
      subagentFiles: ["/work/s.ts"],
      bashCount: 2,
      bashSamples: ["ls", "pwd"],
      completedAt: 5_000,
      undoneAt: null,
    });
    expect(store.getByUuid(r.userMessageUuid)?.id).toBe(id);
  });

  it("reuses the row of a uuid inserted twice", () => {
    const r = row();
    expect(store.insert(r)).toBe(store.insert(r));
    expect(store.count()).toBe(1);
  });

  it("lists newest first and skips turns without file edits when counting back", () => {
    const a = store.insert(row());
    store.setActivity(a, activity(["/work/a"]));
    const b = store.insert(row());
    store.setActivity(b, activity([], { bash: 3 }));
    const c = store.insert(row());
    store.setActivity(c, activity([], { sub: ["/work/s"] }));
    const t = store.insert(row({ source: "task:t1" }));
    store.setActivity(t, activity(["/work/t"]));

    expect(store.recent("telegram:dm:1", 10).map((r) => r.id)).toEqual([t, c, b, a]);
    expect(store.undoCandidates("telegram:dm:1", "chat", 10).map((r) => r.id)).toEqual([c, a]);
    expect(store.undoCandidates("telegram:dm:1", "task:t1", 10).map((r) => r.id)).toEqual([t]);

    store.markUndone([c], 7_000);
    expect(store.undoCandidates("telegram:dm:1", "chat", 10).map((r) => r.id)).toEqual([a]);
    expect(store.get(c)!.undoneAt).toBe(7_000);
  });

  it("finds tasks by id prefix and the chat that started them", () => {
    store.insert(row({ source: "task:abc12345-1", sessionKey: "telegram:dm:9" }));
    store.insert(row({ source: "task:abc12399-2" }));
    store.insert(row({ source: "task:zzz" }));
    expect(store.findTaskIds("abc123").sort()).toEqual(["abc12345-1", "abc12399-2"]);
    expect(store.findTaskIds("abc12345")).toEqual(["abc12345-1"]);
    expect(store.findTaskIds("%")).toEqual([]);
    expect(store.taskSessionKey("abc12345-1")).toBe("telegram:dm:9");
    expect(store.taskSessionKey("nope")).toBeNull();
  });

  it("prunes by age and by count per session", () => {
    for (let i = 0; i < 5; i++) store.insert(row({ createdAt: 10_000 + i }));
    store.insert(row({ sessionKey: "telegram:dm:2", createdAt: 10_000 }));
    store.insert(row({ createdAt: 100 })); // old: dropped by age
    expect(store.prune({ maxPerSession: 3, olderThanMs: 1_000 })).toBe(1 + 2);
    expect(store.recent("telegram:dm:1", 10)).toHaveLength(3);
    expect(store.recent("telegram:dm:2", 10)).toHaveLength(1);
  });

  it("caps stored path lists", () => {
    const id = store.insert(row());
    store.setActivity(id, activity(Array.from({ length: 300 }, (_, i) => `/f${i}`)));
    expect(store.get(id)!.filesChanged).toHaveLength(200);
  });
});