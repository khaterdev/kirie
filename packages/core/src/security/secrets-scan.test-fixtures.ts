/**
 * Test fixture for /secrets scan and redact: a temp data dir with real store
 * schemas (created by the real store classes) and rows seeded with SYNTHETIC
 * secrets built at run time from fragments. Rows are inserted with raw SQL on
 * purpose: the stores scrub on write today, and the fixture must look like
 * data written before scrubbing existed. Never points at ~/.kirie.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MemoryStore } from "../mcp/tools/memory.js";
import { ChatHistoryStore } from "../mcp/tools/chat-history.js";
import { BackgroundTaskStore } from "../engine/background-task-store.js";
import { HeartbeatLogStore } from "../mcp/tools/heartbeat-logs.js";

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = LOWER + LOWER.toUpperCase() + "0123456789";
const TOKEN = ALNUM + "_-";
const DIGITS = "0123456789";

let seed = 7;
export function synthSecretChars(len: number, alphabet = ALNUM): string {
  let x = (seed++ * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    s += alphabet[x % alphabet.length];
  }
  return s;
}

export interface SecretsFixtureSecrets {
  /** Telegram token part after "<id>:" (the id is kept by the rule) */
  telegram: string;
  telegramFull: string;
  linear: string;
  github: string;
  google: string;
  password: string;
  bearer: string;
  authBearer: string;
  keyInMemoryKey: string;
}

export interface SecretsFixture {
  dataDir: string;
  home: string;
  secrets: SecretsFixtureSecrets;
  /** Every synthetic value; none may appear in any output */
  values: string[];
  ids: {
    linearMemory: number;
    notesMemory: number;
    keyMemory: number;
    githubMessage: number;
    linearMessage: number;
    authMessage: number;
    bareMessage: number;
    doneTask: string;
    runningTask: string;
    heartbeat: number;
  };
  paths: {
    memory: string;
    chat: string;
    tasks: string;
    heartbeat: string;
    vectors: string;
    log: string;
    memoryMd: string;
    config: string;
  };
  /** Idle connections held open like the daemon's (WAL and SHM files exist) */
  live: Database.Database[];
  cleanup(): void;
}

export function buildSecretsFixture(): SecretsFixture {
  const root = mkdtempSync(join(tmpdir(), "kirie-secrets-"));
  const dataDir = join(root, "kirie");
  const home = join(root, "home");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".claude2", "projects"), { recursive: true });
  mkdirSync(join(dataDir, "backups"), { recursive: true });

  const botId = `7${synthSecretChars(9, DIGITS)}`;
  const telegram = ["AA", synthSecretChars(33, TOKEN)].join("");
  const secrets: SecretsFixtureSecrets = {
    telegram,
    telegramFull: `${botId}:${telegram}`,
    linear: ["lin", "_api_", synthSecretChars(40)].join(""),
    github: ["gh", "p_", synthSecretChars(36)].join(""),
    google: ["AI", "za", synthSecretChars(35, TOKEN)].join(""),
    password: `${synthSecretChars(14)}9q`,
    bearer: `${synthSecretChars(28)}4x`,
    authBearer: `${synthSecretChars(28)}5y`,
    keyInMemoryKey: ["gh", "p_", synthSecretChars(36)].join(""),
  };

  const paths = {
    memory: join(dataDir, "memory.db"),
    chat: join(dataDir, "chat-history.db"),
    tasks: join(dataDir, "background-tasks.db"),
    heartbeat: join(dataDir, "heartbeat-logs.db"),
    vectors: join(dataDir, "vectors.db"),
    log: join(dataDir, "logs", "daemon.out.log"),
    memoryMd: join(dataDir, "MEMORY.md"),
    config: join(dataDir, "config.yaml"),
  };

  // Real schemas (tables, FTS, triggers) from the real classes.
  new MemoryStore(paths.memory).close();
  new ChatHistoryStore(paths.chat).close();
  new BackgroundTaskStore(paths.tasks).close();
  new HeartbeatLogStore(paths.heartbeat).close();

  const mem = new Database(paths.memory);
  mem.pragma("journal_mode = WAL");
  const insMem = mem.prepare("INSERT INTO memories (key, content, tags, content_hash) VALUES (?, ?, ?, 'old')");
  const linearMemory = Number(insMem.run("api:linear:key", `Linear key: ${secrets.linear}`, JSON.stringify(["credential"])).lastInsertRowid);
  const notesMemory = Number(insMem.run("notes:deploy", `deploy notes\nDB_PASSWORD=${secrets.password}\nbot ${secrets.telegramFull} end`, "[]").lastInsertRowid);
  const keyMemory = Number(insMem.run(`gh:${secrets.keyInMemoryKey}`, "harmless", "[]").lastInsertRowid);
  insMem.run("clean:one", "nothing secret here, commit 3f2a9c1e0b7d4a6f8e2c1b0a9d8e7f6a5b4c3d2e", "[]");
  mem.exec("CREATE TABLE IF NOT EXISTS schedules (name TEXT PRIMARY KEY, cron TEXT NOT NULL, message TEXT NOT NULL, channel TEXT NOT NULL, chat_id TEXT NOT NULL)");
  mem.prepare("INSERT INTO schedules (name, cron, message, channel, chat_id) VALUES (?, ?, ?, ?, ?)").run("daily", "0 9 * * *", "check the weather", "telegram", "1");
  mem.close();

  const vec = new Database(paths.vectors);
  vec.pragma("journal_mode = WAL");
  vec.exec("CREATE TABLE memory_vectors (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, embedding BLOB NOT NULL, metadata TEXT NOT NULL DEFAULT '{}')");
  vec.prepare("INSERT INTO memory_vectors (key, embedding) VALUES (?, ?)").run("api:linear:key", Buffer.alloc(16));
  vec.prepare("INSERT INTO memory_vectors (key, embedding) VALUES (?, ?)").run("clean:one", Buffer.alloc(16));
  vec.close();

  const chat = new Database(paths.chat);
  chat.pragma("journal_mode = WAL");
  const insMsg = chat.prepare("INSERT INTO messages (session_key, role, content, channel) VALUES ('telegram:dm:1', ?, ?, 'telegram')");
  const githubMessage = Number(insMsg.run("user", `here is my token ${secrets.github} please use it`).lastInsertRowid);
  const linearMessage = Number(insMsg.run("user", `and the linear one: ${secrets.linear}`).lastInsertRowid);
  const authMessage = Number(insMsg.run("assistant", `curl -H "Authorization: Bearer ${secrets.authBearer}" https://api.example.com`).lastInsertRowid);
  const bareMessage = Number(insMsg.run("user", `use Bearer ${secrets.bearer} for that`).lastInsertRowid);
  insMsg.run("assistant", "max_tokens=4096 and a uuid 123e4567-e89b-12d3-a456-426614174000");
  chat.prepare("INSERT INTO message_vectors (message_id, embedding) VALUES (?, ?)").run(githubMessage, Buffer.alloc(16));
  chat.close();

  const tasks = new Database(paths.tasks);
  tasks.pragma("journal_mode = WAL");
  const insTask = tasks.prepare("INSERT INTO background_tasks (id, session_key, description, prompt, status, result) VALUES (?, 'telegram:dm:1', ?, ?, ?, ?)");
  const doneTask = "aaaa1111-0000-4000-8000-000000000001";
  const runningTask = "bbbb2222-0000-4000-8000-000000000002";
  insTask.run(doneTask, "check bot", "check the bot", "completed", `bot answered via https://api.telegram.org/bot${secrets.telegramFull}/getMe`);
  insTask.run(runningTask, "linear sync", `sync linear with ${secrets.linear}`, "running", null);
  tasks.close();

  const hb = new Database(paths.heartbeat);
  hb.pragma("journal_mode = WAL");
  const heartbeat = Number(hb.prepare("INSERT INTO heartbeat_logs (tick_number, tier, category, level, title, content, metadata) VALUES (1, 'tier1', 'signal', 'info', 'tick', ?, ?)")
    .run(`maps key ${secrets.google} failed`, JSON.stringify({ key: "none" })).lastInsertRowid);
  hb.close();

  writeFileSync(join(dataDir, "SOUL.md"), "# Soul\nBe kind.\n");
  writeFileSync(paths.memoryMd, `# Memory\n- Linear: ${secrets.linear}\n`);
  writeFileSync(paths.config, [
    "channels:",
    "  telegram:",
    `    botToken: ${secrets.telegramFull}`,
    "memory:",
    "  embeddings:",
    "    apiKey: $credential:openai.key",
    "",
  ].join("\n"));
  writeFileSync(paths.log, [
    JSON.stringify({ level: 30, msg: "daemon started" }),
    JSON.stringify({ level: 60, msg: "unhandled promise rejection", reason: { message: `Call to 'getUpdates' failed! (404) https://api.telegram.org/bot${secrets.telegramFull}/getUpdates` } }),
    `héllo ✓ ünïcode then linear ${secrets.linear} done`,
    "plain line",
    "",
  ].join("\n"));

  const live = [paths.memory, paths.chat, paths.tasks, paths.heartbeat].map((p) => {
    const db = new Database(p);
    db.pragma("journal_mode = WAL");
    db.prepare("SELECT 1").get();
    return db;
  });

  return {
    dataDir,
    home,
    secrets,
    values: [
      secrets.telegram, secrets.linear, secrets.github, secrets.google, secrets.password,
      secrets.bearer, secrets.authBearer, secrets.keyInMemoryKey,
    ],
    ids: { linearMemory, notesMemory, keyMemory, githubMessage, linearMessage, authMessage, bareMessage, doneTask, runningTask, heartbeat },
    paths,
    live,
    cleanup() {
      for (const db of live) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
