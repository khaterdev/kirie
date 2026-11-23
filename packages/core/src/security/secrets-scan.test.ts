import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

// Capture every log line written by any module during these tests, unscrubbed,
// so the tests prove the scanner never hands a value to the logger at all.
const logLines: string[] = vi.hoisted(() => []);
vi.mock("../logging/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../logging/logger.js")>();
  const capture = (...args: unknown[]) => {
    logLines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(" "));
  };
  const logger = { trace: capture, debug: capture, info: capture, warn: capture, error: capture, fatal: capture, child: () => logger, level: "info" };
  return { ...orig, createModuleLogger: () => logger };
});

import { SecretScrubber } from "./secret-scrubber.js";
import { CredentialStore } from "./credential-store.js";
import {
  SecretsAuditor,
  secretsSameLengthMask,
  type SecretsAuditorOptions,
  type SecretsScanFinding,
} from "./secrets-scan.js";
import { buildSecretsFixture, type SecretsFixture } from "./secrets-scan.test-fixtures.js";

function expectNoValues(text: string, fx: SecretsFixture, where: string): void {
  for (const v of fx.values) expect(text.includes(v), `${where} contains a secret value`).toBe(false);
  // Not even a long fragment of one.
  for (const v of fx.values) expect(text.includes(v.slice(4, 20)), `${where} contains a secret fragment`).toBe(false);
}

function snapshotFiles(paths: string[]): string {
  return JSON.stringify(paths.map((p) => (existsSync(p) ? (({ size, mtimeMs, ino }) => ({ p, size, mtimeMs, ino }))(statSync(p)) : { p, missing: true })));
}

function rawBytesContain(file: string, value: string): boolean {
  return existsSync(file) && readFileSync(file).includes(Buffer.from(value, "utf8"));
}

describe("SecretsAuditor", () => {
  let fx: SecretsFixture;
  let audits: Array<Record<string, unknown>>;
  let auditor: SecretsAuditor;

  function makeAuditor(extra: Partial<SecretsAuditorOptions> = {}): SecretsAuditor {
    return new SecretsAuditor({
      dataDir: fx.dataDir,
      homeDir: fx.home,
      scrubber: new SecretScrubber(),
      audit: { record: (r) => { audits.push(r as unknown as Record<string, unknown>); } },
      ...extra,
    });
  }

  beforeEach(() => {
    fx = buildSecretsFixture();
    audits = [];
    logLines.length = 0;
    auditor = makeAuditor();
  });

  afterEach(() => {
    fx.cleanup();
  });

  describe("scan", () => {
    it("finds the seeded secrets in every store, with rule names and locations", () => {
      const { report } = auditor.scan("full");
      const rules = (store: string) => report.findings.filter((f) => f.store === store).map((f) => f.rule).sort();

      expect(rules("memory")).toEqual(["github-token", "linear-key", "secret-assignment", "telegram-bot-token"]);
      expect(rules("chat-history")).toEqual(["auth-header", "auth-header", "github-token", "linear-key"]);
      expect(rules("background-tasks")).toEqual(["linear-key", "telegram-bot-token"]);
      expect(rules("heartbeat-logs")).toEqual(["google-api-key"]);
      expect(rules("markdown")).toEqual(["linear-key"]);
      expect(rules("logs")).toEqual(["linear-key", "telegram-bot-token"]);
      expect(rules("config")).toEqual(["telegram-bot-token"]);
      expect(report.counts.total).toBe(report.findings.length);
      expect(report.findings.map((f) => f.id)).toEqual(report.findings.map((_, i) => i + 1));
      // The clean rows (git SHA, UUID, max_tokens) and the $credential reference produce nothing.
      expect(report.findings.some((f) => f.location.includes("clean:one"))).toBe(false);
    });

    it("splits auth-header into the Authorization header and a bare Bearer (E9)", () => {
      const { report } = auditor.scan("quick");
      expect(report.counts.byRule["auth-header (Authorization)"]).toBe(1);
      expect(report.counts.byRule["auth-header (bare Bearer)"]).toBe(1);
      expect(report.counts.byRule["auth-header"]).toBeUndefined();
    });

    it("never puts a value in findings, the report file, counts, the audit record or the logs", () => {
      const { report, reportPath } = auditor.scan("full", { writeReport: true, actor: "owner:telegram:1" });
      expectNoValues(JSON.stringify(report), fx, "report object");
      expectNoValues(readFileSync(reportPath!, "utf8"), fx, "report file");
      expectNoValues(JSON.stringify(audits), fx, "audit records");
      expectNoValues(logLines.join("\n"), fx, "log lines");
      expect(audits).toEqual([expect.objectContaining({ feature: "secrets", action: "scan", actor: "owner:telegram:1" })]);
    });

    it("masks a secret that sits in a memory key and does not offer to redact it", () => {
      const { report } = auditor.scan("quick");
      const keyFinding = report.findings.find((f) => f.target.kind === "row" && f.target.column === "key");
      expect(keyFinding).toBeDefined();
      expect(keyFinding!.location).toContain("«redacted:github-token»");
      expect(keyFinding!.redactable).toBe(false);
    });

    it("gives the same fingerprint to the same secret in different stores, and a new key per scan", () => {
      const first = auditor.scan("full").report;
      const linear = first.findings.filter((f) => f.rule === "linear-key" && f.store !== "background-tasks");
      expect(new Set(linear.map((f) => f.store)).size).toBeGreaterThanOrEqual(3);
      expect(new Set(linear.map((f) => f.fingerprint)).size).toBe(1);
      const github = first.findings.find((f) => f.rule === "github-token" && f.store === "chat-history")!;
      expect(github.fingerprint).not.toBe(linear[0]!.fingerprint);

      const second = auditor.scan("full").report;
      const again = second.findings.find((f) => f.rule === "linear-key" && f.store === "memory")!;
      expect(again.fingerprint).not.toBe(linear[0]!.fingerprint);
    });

    it("is read-only: no database, WAL, SHM, Markdown, log or config file changes", () => {
      const files = [fx.paths.memory, fx.paths.chat, fx.paths.tasks, fx.paths.heartbeat]
        .flatMap((p) => [p, `${p}-wal`, `${p}-shm`])
        .concat([fx.paths.memoryMd, fx.paths.log, fx.paths.config, fx.paths.vectors]);
      const before = snapshotFiles(files);
      const rowsBefore = fx.live[0]!.prepare("SELECT * FROM memories ORDER BY id").all();
      auditor.scan("full");
      expect(snapshotFiles(files)).toBe(before);
      expect(fx.live[0]!.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(rowsBefore);
      expect(existsSync(join(fx.dataDir, "reports"))).toBe(false);
    });

    it("quick skips logs and the not-cleanable list; full lists them without opening them", () => {
      const quick = auditor.scan("quick").report;
      expect(quick.findings.some((f) => f.store === "logs")).toBe(false);
      expect(quick.notCleanable).toEqual([]);
      const full = auditor.scan("full").report;
      expect(full.notCleanable.some((p) => p.includes(join(".claude", "projects")))).toBe(true);
      expect(full.notCleanable.some((p) => p.includes(join(".claude2", "projects")))).toBe(true);
      expect(full.notCleanable.some((p) => p.includes("backups"))).toBe(true);
    });

    it("marks running-task prompts and config lines as not redactable, terminal tasks as redactable", () => {
      const { report } = auditor.scan("quick");
      const tasks = report.findings.filter((f) => f.store === "background-tasks");
      expect(tasks.find((f) => f.rule === "linear-key")!.redactable).toBe(false);
      expect(tasks.find((f) => f.rule === "telegram-bot-token")!.redactable).toBe(true);
      const cfg = report.findings.find((f) => f.store === "config")!;
      expect(cfg.redactable).toBe(false);
      expect(cfg.note).toContain("credential store");
      const vaultHint = report.findings.find((f) => f.store === "memory" && f.rule === "linear-key")!;
      expect(vaultHint.suggestVault).toBe(true);
      expect(vaultHint.vaultable).toBe(true);
    });

    it("writes the report 0600 inside a 0700 reports dir, and ends with rotation advice", () => {
      const { report, reportPath } = auditor.scan("quick", { writeReport: true });
      expect(statSync(reportPath!).mode & 0o777).toBe(0o600);
      expect(statSync(join(fx.dataDir, "reports")).mode & 0o777).toBe(0o700);
      expect(report.rotationAdvice.join("\n")).toMatch(/BotFather/);
      expect(report.rotationAdvice.join("\n")).toMatch(/Linear/);
      expect(auditor.latestReport()!.report.scanId).toBe(report.scanId);
    });

    it("reports a missing or unreadable store instead of failing", () => {
      const a = makeAuditor({ heartbeatLogDbPath: join(fx.dataDir, "nope.db") });
      const { report } = a.scan("quick");
      expect(report.stores.find((s) => s.store === "heartbeat-logs")!.status).toBe("missing");
    });

    it("summarize returns counts only and writes nothing", () => {
      const summary = auditor.summarize("quick");
      expect(summary.counts.total).toBeGreaterThan(0);
      expect(JSON.stringify(summary)).not.toMatch(/fingerprint|location|target/);
      expectNoValues(JSON.stringify(summary), fx, "summary");
      expect(existsSync(join(fx.dataDir, "reports"))).toBe(false);
      expect(audits).toEqual([]);
    });
  });

  describe("redact", () => {
    function plan(ids: "all" | number[], vault = false) {
      const p = auditor.planRedaction(ids, { vault });
      if ("error" in p) throw new Error(p.error);
      return p;
    }
    const find = (fs: SecretsScanFinding[], pred: (f: SecretsScanFinding) => boolean) => fs.find(pred)!;

    it("needs a scan from this process", () => {
      expect(auditor.planRedaction("all")).toEqual({ error: expect.stringContaining("/secrets scan") });
      auditor.scan("quick"); // without writeReport it is not a redact target
      expect(auditor.planRedaction("all")).toEqual({ error: expect.stringContaining("/secrets scan") });
    });

    it("refuses a plan from a scan that a newer scan replaced", async () => {
      auditor.scan("quick", { writeReport: true });
      const old = plan("all");
      auditor.scan("quick", { writeReport: true });
      await expect(auditor.redact(old, "owner:telegram:1")).rejects.toThrow(/newer scan/);
    });

    it("redacts every redactable finding; FTS finds nothing; no value left in the db or WAL bytes", async () => {
      const { report } = auditor.scan("full", { writeReport: true });
      const result = await auditor.redact(plan("all"), "owner:telegram:1");
      expect(result.redacted.sort((a, b) => a - b)).toEqual(report.findings.filter((f) => f.redactable).map((f) => f.id).sort((a, b) => a - b));

      const mem = fx.live[0]!;
      const linearRow = mem.prepare("SELECT content, content_hash FROM memories WHERE id = ?").get(fx.ids.linearMemory) as { content: string; content_hash: string };
      expect(linearRow.content).toBe("Linear key: «redacted:linear-key»");
      expect(linearRow.content_hash).not.toBe("old");
      const notes = (mem.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.notesMemory) as { content: string }).content;
      expect(notes).toContain("DB_PASSWORD=«redacted:secret-assignment»");
      expect(notes).toContain(":«redacted:telegram-bot-token» end");
      const fts = (db: Database.Database, table: string, term: string) =>
        db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`"${term}"`) as { n: number };
      expect(fts(mem, "memories_fts", fx.secrets.linear).n).toBe(0);
      expect(fts(fx.live[1]!, "messages_fts", fx.secrets.github).n).toBe(0);
      expect(fts(fx.live[3]!, "heartbeat_logs_fts", fx.secrets.google).n).toBe(0);
      expect(fts(mem, "memories_fts", "redacted").n).toBeGreaterThan(0);

      const chat = (fx.live[1]!.prepare("SELECT content FROM messages WHERE id = ?").get(fx.ids.authMessage) as { content: string }).content;
      expect(chat).toBe('curl -H "Authorization: Bearer «redacted:auth-header»" https://api.example.com');
      expect(fx.live[1]!.prepare("SELECT count(*) AS n FROM message_vectors WHERE message_id = ?").get(fx.ids.githubMessage)).toEqual({ n: 0 });

      const tasks = fx.live[2]!;
      expect((tasks.prepare("SELECT result FROM background_tasks WHERE id = ?").get(fx.ids.doneTask) as { result: string }).result)
        .toContain("«redacted:telegram-bot-token»/getMe");
      expect((tasks.prepare("SELECT prompt FROM background_tasks WHERE id = ?").get(fx.ids.runningTask) as { prompt: string }).prompt)
        .toContain(fx.secrets.linear); // running task: left alone

      for (const d of result.databases.filter((x) => x.rowsChanged > 0)) {
        expect(d.checkpoint, d.file).toBe("complete");
        expect(d.vacuum, d.file).toBe("ok");
      }
      // secure_delete + FTS rebuild + checkpoint + VACUUM: the raw bytes hold no copy.
      for (const [file, value] of [
        [fx.paths.memory, fx.secrets.linear], [fx.paths.memory, fx.secrets.password],
        [fx.paths.chat, fx.secrets.github], [fx.paths.chat, fx.secrets.authBearer], [fx.paths.chat, fx.secrets.bearer],
        [fx.paths.heartbeat, fx.secrets.google], [fx.paths.tasks, fx.secrets.telegram],
      ] as const) {
        expect(rawBytesContain(file, value), `${file}`).toBe(false);
        expect(rawBytesContain(`${file}-wal`, value), `${file}-wal`).toBe(false);
      }
      // Memory vector of the redacted row is gone (no re-embedder configured); others stay.
      const vec = new Database(fx.paths.vectors, { readonly: true });
      expect(vec.prepare("SELECT key FROM memory_vectors ORDER BY key").all()).toEqual([{ key: "clean:one" }]);
      vec.close();
    });

    it("masks log and Markdown matches in place: same size, same inode, other bytes untouched", async () => {
      const { report } = auditor.scan("full", { writeReport: true });
      const before = readFileSync(fx.paths.log);
      const st = statSync(fx.paths.log);
      const logIds = report.findings.filter((f) => f.store === "logs" || f.store === "markdown").map((f) => f.id);
      const result = await auditor.redact(plan(logIds), "owner:telegram:1");
      expect(result.redacted.sort()).toEqual([...logIds].sort());
      const after = readFileSync(fx.paths.log);
      const st2 = statSync(fx.paths.log);
      expect(after.length).toBe(before.length);
      expect(st2.size).toBe(st.size);
      expect(st2.ino).toBe(st.ino);
      const text = after.toString("utf8");
      expectNoValues(text, fx, "log after redact");
      const lines = text.split("\n");
      expect(lines[0]).toBe(JSON.stringify({ level: 30, msg: "daemon started" }));
      expect(lines[1]).toContain("/getUpdates");
      expect(() => JSON.parse(lines[1]!)).not.toThrow();
      expect(lines[2]).toMatch(/^héllo ✓ ünïcode then linear «redacted:linear-key»\**? done$/);
      expect(lines[3]).toBe("plain line");
      expect(readFileSync(fx.paths.memoryMd, "utf8")).toMatch(/^# Memory\n- Linear: «redacted:linear-key»\**\n$/);
      expect(result.files.every((f) => f.sizeKept && f.inodeKept)).toBe(true);
    });

    it("keeps lines appended after the scan (launchd keeps writing the log)", async () => {
      const { report } = auditor.scan("full", { writeReport: true });
      appendFileSync(fx.paths.log, "new line after scan\n");
      const logIds = report.findings.filter((f) => f.store === "logs").map((f) => f.id);
      await auditor.redact(plan(logIds), "owner:telegram:1");
      expect(readFileSync(fx.paths.log, "utf8").endsWith("plain line\nnew line after scan\n")).toBe(true);
    });

    it("skips a location that changed since the scan", async () => {
      const { report } = auditor.scan("quick", { writeReport: true });
      const gh = find(report.findings, (f) => f.store === "chat-history" && f.rule === "github-token");
      fx.live[1]!.prepare("UPDATE messages SET content = 'edited meanwhile' WHERE id = ?").run(fx.ids.githubMessage);
      const result = await auditor.redact(plan([gh.id]), "owner:telegram:1");
      expect(result.redacted).toEqual([]);
      expect(result.skipped).toEqual([{ id: gh.id, reason: "changed since the scan" }]);
      expect((fx.live[1]!.prepare("SELECT content FROM messages WHERE id = ?").get(fx.ids.githubMessage) as { content: string }).content).toBe("edited meanwhile");
    });

    it("explains ids that are not redactable or unknown", () => {
      const { report } = auditor.scan("quick", { writeReport: true });
      const cfg = find(report.findings, (f) => f.store === "config");
      const p = plan([cfg.id, 9999]);
      expect(p.findings).toEqual([]);
      expect(p.skipped.map((s) => s.id)).toEqual([cfg.id, 9999]);
      // "all" silently leaves out what cannot be redacted.
      expect(plan("all").skipped).toEqual([]);
      expect(plan("all").findings.every((f) => f.redactable)).toBe(true);
    });

    it("re-embeds redacted memories from the redacted text when a re-embedder is given", async () => {
      const calls: Array<[string, string, string[]]> = [];
      auditor = makeAuditor({ reembedMemory: async (k, c, t) => { calls.push([k, c, t]); } });
      const { report } = auditor.scan("quick", { writeReport: true });
      const ids = report.findings.filter((f) => f.store === "memory" && f.redactable).map((f) => f.id);
      const result = await auditor.redact(plan(ids), "owner:telegram:1");
      expect(calls.map((c) => c[0]).sort()).toEqual(["api:linear:key", "notes:deploy"]);
      expect(calls.find((c) => c[0] === "api:linear:key")![2]).toEqual(["credential"]);
      expectNoValues(JSON.stringify(calls), fx, "re-embed input");
      expect(result.databases[0]!.reembedded).toBe(2);
    });

    it("vault mode moves a memory value into the credential store and leaves a pointer", async () => {
      const prev = process.env.KIRIE_MASTER_KEY;
      process.env.KIRIE_MASTER_KEY = randomBytes(32).toString("base64");
      try {
        const store = new CredentialStore({ credentialsDir: join(fx.dataDir, "credentials") });
        auditor = makeAuditor({ vault: store });
        const { report } = auditor.scan("quick", { writeReport: true });
        const lin = find(report.findings, (f) => f.store === "memory" && f.rule === "linear-key");
        const gh = find(report.findings, (f) => f.store === "chat-history" && f.rule === "github-token");
        const result = await auditor.redact(plan([lin.id, gh.id], true), "owner:telegram:1");
        expect(result.vaulted).toEqual([{ id: lin.id, key: "vault.api-linear-key" }]);
        expect(await store.get("vault.api-linear-key")).toBe(fx.secrets.linear);
        expect((fx.live[0]!.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.linearMemory) as { content: string }).content)
          .toBe("Linear key: «stored in credential store: vault.api-linear-key»");
        // Not memory content: the normal marker.
        expect((fx.live[1]!.prepare("SELECT content FROM messages WHERE id = ?").get(fx.ids.githubMessage) as { content: string }).content)
          .toContain("«redacted:github-token»");
        // The credential file is encrypted: no plaintext value on disk.
        const credDir = join(fx.dataDir, "credentials");
        for (const f of readdirSync(credDir)) expect(rawBytesContain(join(credDir, f), fx.secrets.linear)).toBe(false);
        expectNoValues(JSON.stringify(result), fx, "redact result");
      } finally {
        if (prev === undefined) delete process.env.KIRIE_MASTER_KEY;
        else process.env.KIRIE_MASTER_KEY = prev;
      }
    });

    it("a failing vault write leaves the row unchanged", async () => {
      auditor = makeAuditor({ vault: { get: async () => undefined, set: async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } } });
      const { report } = auditor.scan("quick", { writeReport: true });
      const lin = find(report.findings, (f) => f.store === "memory" && f.rule === "linear-key");
      const result = await auditor.redact(plan([lin.id], true), "owner:telegram:1");
      expect(result.redacted).toEqual([]);
      expect(result.skipped[0]!.reason).toMatch(/vault write failed \(ENOSPC\)/);
      expect((fx.live[0]!.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.linearMemory) as { content: string }).content)
        .toContain(fx.secrets.linear);
    });

    it("writes one audit record without values, updates the report, and logs no values", async () => {
      auditor.scan("full", { writeReport: true, actor: "owner:telegram:1" });
      const result = await auditor.redact(plan("all"), "owner:telegram:1");
      const rec = audits.find((a) => a.action === "redact")!;
      expect(rec).toEqual(expect.objectContaining({ feature: "secrets", actor: "owner:telegram:1" }));
      expect((rec.detail as { redacted: number[] }).redacted).toEqual(result.redacted);
      expectNoValues(JSON.stringify(audits), fx, "audit records");
      expectNoValues(logLines.join("\n"), fx, "log lines");
      expectNoValues(JSON.stringify(result), fx, "redact result");
      const latest = auditor.latestReport()!;
      expectNoValues(readFileSync(latest.path, "utf8"), fx, "report after redact");
      expect(latest.report.findings.filter((f) => result.redacted.includes(f.id)).every((f) => !f.redactable && f.note === "already redacted")).toBe(true);
      // A second redact of the same findings changes nothing.
      expect(plan(result.redacted).findings).toEqual([]);
    });

    it("a rescan after redact finds only what was left on purpose", async () => {
      auditor.scan("full", { writeReport: true });
      await auditor.redact(plan("all"), "owner:telegram:1");
      const { report } = auditor.scan("full");
      expect(report.findings.every((f) => !f.redactable)).toBe(true);
      expect(report.findings.map((f) => f.store).sort()).toEqual(["background-tasks", "config", "memory"]);
    });
  });

  describe("review regressions", () => {
    function plan(ids: "all" | number[], vault = false) {
      const p = auditor.planRedaction(ids, { vault });
      if ("error" in p) throw new Error(p.error);
      return p;
    }

    it("scanning an idle database (no daemon connection) creates no -wal or -shm", () => {
      for (const db of fx.live) db.close();
      const dbs = [fx.paths.memory, fx.paths.chat, fx.paths.tasks, fx.paths.heartbeat];
      for (const p of dbs) {
        expect(existsSync(`${p}-wal`), p).toBe(false);
        expect(existsSync(`${p}-shm`), p).toBe(false);
      }
      const before = snapshotFiles(dbs);
      const { report } = auditor.scan("quick");
      for (const p of dbs) {
        expect(existsSync(`${p}-wal`), p).toBe(false);
        expect(existsSync(`${p}-shm`), p).toBe(false);
      }
      expect(snapshotFiles(dbs)).toBe(before);
      expect(report.counts.byStore["chat-history"]).toBe(4);
      expect(report.stores.every((s) => s.status !== "error")).toBe(true);
    });

    it("vault never names the vault key after a memory key that is itself a secret", async () => {
      const prev = new Map<string, string>();
      const vault = { get: async (k: string) => prev.get(k), set: async (k: string, v: string) => { prev.set(k, v); } };
      fx.live[0]!.prepare("UPDATE memories SET content = ? WHERE id = ?").run(`token ${fx.secrets.linear}`, fx.ids.keyMemory);
      auditor = makeAuditor({ vault });
      const { report } = auditor.scan("quick", { writeReport: true });
      const f = report.findings.find((x) => x.target.kind === "row" && x.target.id === fx.ids.keyMemory && x.target.column === "content")!;
      const result = await auditor.redact(plan([f.id], true), "owner:telegram:1");
      expect(result.vaulted).toEqual([{ id: f.id, key: `vault.memory-${fx.ids.keyMemory}` }]);
      const content = (fx.live[0]!.prepare("SELECT content FROM memories WHERE id = ?").get(fx.ids.keyMemory) as { content: string }).content;
      const frag = fx.secrets.keyInMemoryKey.slice(4, 20).toLowerCase();
      for (const text of [content, JSON.stringify(result), JSON.stringify(audits), [...prev.keys()].join(",")]) {
        expect(text.toLowerCase().includes(frag)).toBe(false);
      }
    });

    it("schedule names are targeted by rowid, masked, reported and never stored raw", async () => {
      const name = `job:${fx.secrets.github}`;
      fx.live[0]!.prepare("INSERT INTO schedules (name, cron, message, channel, chat_id) VALUES (?, '* * * * *', ?, 'telegram', '1')")
        .run(name, `post with ${fx.secrets.google}`);
      const { report, reportPath } = auditor.scan("quick", { writeReport: true });
      const sched = report.findings.filter((f) => f.target.kind === "row" && f.target.table === "schedules");
      expect(sched.map((f) => `${(f.target as { column: string }).column}:${f.redactable}`).sort()).toEqual(["message:true", "name:false"]);
      expectNoValues(JSON.stringify(report), fx, "report");
      expectNoValues(readFileSync(reportPath!, "utf8"), fx, "report file");
      expect(sched[0]!.location).toContain("«redacted:github-token»");
      const msg = sched.find((f) => (f.target as { column: string }).column === "message")!;
      await auditor.redact(plan([msg.id]), "owner:telegram:1");
      expect((fx.live[0]!.prepare("SELECT message FROM schedules WHERE name = ?").get(name) as { message: string }).message)
        .toBe("post with «redacted:google-api-key»");
    });

    it("a failing update rolls back the whole database and is reported, not claimed", async () => {
      fx.live[1]!.exec(`CREATE TRIGGER boom BEFORE UPDATE ON messages WHEN new.id = ${fx.ids.bareMessage} BEGIN SELECT RAISE(ABORT, 'boom'); END`);
      const { report } = auditor.scan("quick", { writeReport: true });
      const chatIds = report.findings.filter((f) => f.store === "chat-history").map((f) => f.id);
      const result = await auditor.redact(plan("all"), "owner:telegram:1");
      for (const id of chatIds) expect(result.redacted).not.toContain(id);
      expect(result.skipped.filter((s) => chatIds.includes(s.id)).every((s) => /nothing in chat-history\.db changed/.test(s.reason))).toBe(true);
      expect((fx.live[1]!.prepare("SELECT content FROM messages WHERE id = ?").get(fx.ids.githubMessage) as { content: string }).content)
        .toContain(fx.secrets.github);
      // Other databases were still redacted, and the audit record was written.
      expect(result.redacted.length).toBeGreaterThan(0);
      expect(audits.some((a) => a.action === "redact")).toBe(true);
    });

    it("finds and masks a secret that straddles a read-chunk boundary in a large log", async () => {
      const big = join(fx.dataDir, "logs", "big.log");
      const pad = "é".repeat(((1 << 20) - 30) / 2); // multibyte padding, ends 30 bytes before 1 MiB
      const line2 = "x".repeat(200);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(big, `${pad} linear ${fx.secrets.linear} tail\n${line2}\n`);
      const before = readFileSync(big);
      const st = statSync(big);
      const { report } = auditor.scan("full", { writeReport: true });
      const f = report.findings.find((x) => x.location.endsWith("big.log:1"))!;
      expect(f.rule).toBe("linear-key");
      await auditor.redact(plan([f.id]), "owner:telegram:1");
      const after = readFileSync(big);
      expect(after.length).toBe(before.length);
      expect(statSync(big).ino).toBe(st.ino);
      const text = after.toString("utf8");
      expect(text.startsWith(`${pad} linear «redacted:linear-key»`)).toBe(true);
      expect(text.endsWith(` tail\n${line2}\n`)).toBe(true);
      expect(text.includes(fx.secrets.linear)).toBe(false);
    });
  });

  it("same-length mask: marker padded with '*', or only '*' when too short", () => {
    expect(secretsSameLengthMask("linear-key", 40).toString("utf8")).toMatch(/^«redacted:linear-key»\*+$/);
    expect(secretsSameLengthMask("linear-key", 40).length).toBe(40);
    expect(secretsSameLengthMask("telegram-bot-token", 10).toString("utf8")).toBe("**********");
  });
});
