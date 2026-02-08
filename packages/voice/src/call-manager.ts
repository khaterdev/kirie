/**
 * Voice call state management with JSONL persistence.
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type CallState = "initiated" | "ringing" | "answered" | "ended" | "failed";

export interface CallRecord {
  callId: string;
  callSid?: string;
  to: string;
  from: string;
  state: CallState;
  sessionKey?: string;
  startedAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration?: number;
}

const CALLS_DIR = join(homedir(), ".kirie", "voice-calls");
const CALLS_FILE = join(CALLS_DIR, "calls.jsonl");

export class CallManager {
  private activeCalls = new Map<string, CallRecord>();

  constructor() {
    this.loadActiveCalls();
  }

  createCall(opts: {
    callId: string;
    callSid?: string;
    to: string;
    from: string;
    sessionKey?: string;
  }): CallRecord {
    const record: CallRecord = {
      callId: opts.callId,
      callSid: opts.callSid,
      to: opts.to,
      from: opts.from,
      state: "initiated",
      sessionKey: opts.sessionKey,
      startedAt: new Date().toISOString(),
    };
    this.activeCalls.set(opts.callId, record);
    this.persistCallRecord(record);
    return record;
  }

  updateState(callId: string, state: CallState): CallRecord | null {
    const record = this.activeCalls.get(callId);
    if (!record) return null;

    record.state = state;
    if (state === "answered") record.answeredAt = new Date().toISOString();
    if (state === "ended" || state === "failed") {
      record.endedAt = new Date().toISOString();
      if (record.answeredAt) {
        record.duration = Date.now() - new Date(record.answeredAt).getTime();
      }
    }

    this.persistCallRecord(record);
    if (state === "ended" || state === "failed") {
      this.activeCalls.delete(callId);
    }
    return record;
  }

  getCall(callId: string): CallRecord | null {
    return this.activeCalls.get(callId) ?? null;
  }

  listActive(): CallRecord[] {
    return [...this.activeCalls.values()];
  }

  private persistCallRecord(record: CallRecord): void {
    if (!existsSync(CALLS_DIR)) mkdirSync(CALLS_DIR, { recursive: true });
    appendFileSync(CALLS_FILE, JSON.stringify(record) + "\n");
  }

  private loadActiveCalls(): void {
    if (!existsSync(CALLS_FILE)) return;
    try {
      const lines = readFileSync(CALLS_FILE, "utf-8").trim().split("\n");
      for (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line) as CallRecord;
        if (record.state !== "ended" && record.state !== "failed") {
          this.activeCalls.set(record.callId, record);
        }
      }
    } catch {
      // Corrupt file - start fresh
    }
  }
}
