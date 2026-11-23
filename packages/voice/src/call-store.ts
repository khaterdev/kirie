/**
 * Call records, persisted as JSON lines at <dir>/calls.jsonl (file 0600,
 * directory 0700). Each write appends the full record; on load the last line
 * per id wins and the file is compacted. Usage for the daily caps is counted
 * on the local calendar day and is shared by both providers.
 *
 * Numbers of anyone who is not the owner are stored masked (last 4 digits).
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { VoiceProviderName } from "./provider.js";

export type CallState = "dialing" | "ringing" | "in-progress" | "completed" | "busy" | "failed" | "no-answer" | "canceled";
export type CallMode = "agent" | "say" | "voicemail";
export type CallRole = "owner" | "contact" | "unknown";
export type CallRequester = "owner-command" | "agent-tool" | "inbound";

export const TERMINAL_CALL_STATES: ReadonlySet<CallState> = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export interface CallRecord {
  id: string;
  provider: VoiceProviderName;
  providerCallId?: string;
  requestId?: string;
  direction: "inbound" | "outbound";
  mode: CallMode;
  role: CallRole;
  alias?: string;
  /** Full E.164 for owner numbers, masked ("…4567") for everyone else. */
  remote: string;
  requestedBy: CallRequester;
  state: CallState;
  /** epoch ms */
  createdAt: number;
  answeredAt?: number;
  endedAt?: number;
  durationSeconds?: number;
  turns: number;
  endReason?: string;
  /** Untrusted transcript of a one-way call's reply or a voicemail. Never sent into an agent prompt. */
  capturedReply?: string;
  /** Length of the spoken message for outbound "say" calls. The text itself is not stored. */
  messageChars?: number;
}

export type NewCall = Omit<CallRecord, "id" | "createdAt" | "turns" | "state"> & { state?: CallState };

const MAX_KEPT = 500;

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class CallStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly records = new Map<string, CallRecord>();

  constructor(dir: string, now: () => number = Date.now) {
    this.now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort on foreign filesystems */ }
    this.file = join(dir, "calls.jsonl");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    let text = "";
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as CallRecord;
        if (rec && typeof rec.id === "string" && typeof rec.createdAt === "number") this.records.set(rec.id, rec);
      } catch {
        // A torn or corrupt line is skipped.
      }
    }
    this.compact();
  }

  private compact(): void {
    const all = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt);
    const kept = all.slice(-MAX_KEPT);
    this.records.clear();
    for (const r of kept) this.records.set(r.id, r);
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
      renameSync(tmp, this.file);
      chmodSync(this.file, 0o600);
    } catch {
      // Keep the in-memory view; the next append still lands in the old file.
    }
  }

  private persist(rec: CallRecord): void {
    try {
      appendFileSync(this.file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    } catch {
      // In-memory state stays authoritative for this process.
    }
  }

  create(input: NewCall): CallRecord {
    const rec: CallRecord = {
      ...input,
      id: `call-${randomBytes(6).toString("hex")}`,
      createdAt: this.now(),
      turns: 0,
      state: input.state ?? "dialing",
    };
    this.records.set(rec.id, rec);
    this.persist(rec);
    return { ...rec };
  }

  update(id: string, patch: Partial<Omit<CallRecord, "id" | "createdAt">>): CallRecord | null {
    const cur = this.records.get(id);
    if (!cur) return null;
    const next: CallRecord = { ...cur, ...patch };
    this.records.set(id, next);
    this.persist(next);
    return { ...next };
  }

  get(id: string): CallRecord | null {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  byProviderCallId(provider: VoiceProviderName, providerCallId: string): CallRecord | null {
    if (!providerCallId) return null;
    for (const r of this.records.values()) {
      if (r.provider === provider && r.providerCallId === providerCallId) return { ...r };
    }
    return null;
  }

  active(): CallRecord[] {
    return [...this.records.values()].filter((r) => !TERMINAL_CALL_STATES.has(r.state)).map((r) => ({ ...r }));
  }

  /** Newest first. */
  recent(n: number): CallRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(0, n)).map((r) => ({ ...r }));
  }

  /** On startup: every non-terminal record is closed as failed with reason "daemon-restart". */
  recoverStale(): number {
    let n = 0;
    for (const r of [...this.records.values()]) {
      if (TERMINAL_CALL_STATES.has(r.state)) continue;
      this.update(r.id, { state: "failed", endReason: "daemon-restart", endedAt: this.now() });
      n++;
    }
    return n;
  }

  /** Calls created today and seconds used today (finished calls' durations plus live calls' elapsed time), both providers. */
  usageToday(): { calls: number; seconds: number } {
    const now = this.now();
    const start = dayStart(now);
    let calls = 0;
    let seconds = 0;
    for (const r of this.records.values()) {
      if (r.createdAt < start) continue;
      calls++;
      if (r.durationSeconds !== undefined) seconds += r.durationSeconds;
      else if (!TERMINAL_CALL_STATES.has(r.state) && r.answeredAt) seconds += Math.max(0, Math.round((now - r.answeredAt) / 1000));
    }
    return { calls, seconds };
  }
}
