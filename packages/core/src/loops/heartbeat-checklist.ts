/**
 * The HEARTBEAT.md checklist the triage reads (PLAN C.8, R2 section 3.3).
 *
 * Only the owner's /heartbeat command edits it through this module. Writes
 * are atomic (tmp + rename), keep one `.bak` of the previous content, and are
 * capped: the whole file at `proactive.maxChecklistBytes`, each item at 300
 * characters. Items are the list lines ("- x", "* x", "1. x") outside fenced
 * code blocks, numbered in file order; `/heartbeat remove <n>` uses those numbers.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export const HEARTBEAT_CHECKLIST_ITEM_MAX_CHARS = 300;
export const HEARTBEAT_CHECKLIST_OWNER_HEADING = "## Owner Added";

const ITEM_RE = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(\S.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^#{1,6}\s/;

export interface HeartbeatChecklistItem {
  /** 1-based number shown by /heartbeat show */
  n: number;
  /** 0-based line index in the file */
  line: number;
  text: string;
}

export interface HeartbeatChecklist {
  exists: boolean;
  content: string;
  bytes: number;
  items: HeartbeatChecklistItem[];
}

export type HeartbeatChecklistEdit =
  | { ok: true; n: number; text: string; bytes: number }
  | { ok: false; error: string };

/** Expand a leading "~" like the triage runner does. */
export function resolveHeartbeatChecklistPath(raw: string): string {
  return raw.startsWith("~") ? resolve(homedir(), raw.slice(2)) : resolve(raw);
}

export function parseHeartbeatChecklist(content: string): HeartbeatChecklistItem[] {
  const items: HeartbeatChecklistItem[] = [];
  let inFence = false;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ITEM_RE.exec(line);
    if (m) items.push({ n: items.length + 1, line: i, text: m[1]!.trim() });
  }
  return items;
}

export function readHeartbeatChecklist(path: string): HeartbeatChecklist {
  if (!existsSync(path)) return { exists: false, content: "", bytes: 0, items: [] };
  const content = readFileSync(path, "utf-8");
  return { exists: true, content, bytes: Buffer.byteLength(content, "utf-8"), items: parseHeartbeatChecklist(content) };
}

/** One line of item text: control characters and newlines become spaces. */
export function sanitizeHeartbeatChecklistText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Append "- <text>" under the "## Owner Added" heading (created at the end when missing). */
export function addHeartbeatChecklistItem(path: string, rawText: string, maxBytes: number): HeartbeatChecklistEdit {
  const text = sanitizeHeartbeatChecklistText(rawText);
  if (!text) return { ok: false, error: "Say what to add, for example: /heartbeat add check that the backup ran today" };
  if (text.length > HEARTBEAT_CHECKLIST_ITEM_MAX_CHARS) {
    return { ok: false, error: `An item can be at most ${HEARTBEAT_CHECKLIST_ITEM_MAX_CHARS} characters (this one has ${text.length}).` };
  }
  const current = readHeartbeatChecklist(path);
  const lines = current.content ? current.content.replace(/\n+$/, "").split("\n") : [];
  const headingAt = lines.findIndex((l) => l.trim() === HEARTBEAT_CHECKLIST_OWNER_HEADING);
  const newLine = `- ${text}`;
  let insertedLine: number;
  if (headingAt === -1) {
    if (lines.length > 0) lines.push("");
    lines.push(HEARTBEAT_CHECKLIST_OWNER_HEADING, "", newLine);
    insertedLine = lines.length - 1;
  } else {
    // End of the section: the next heading, or the end of the file. Skip trailing blank lines.
    let end = lines.length;
    for (let i = headingAt + 1; i < lines.length; i++) {
      if (HEADING_RE.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    let insertAt = end;
    while (insertAt > headingAt + 1 && lines[insertAt - 1]!.trim() === "") insertAt--;
    if (insertAt === headingAt + 1) {
      lines.splice(insertAt, 0, "", newLine);
      insertedLine = insertAt + 1;
    } else {
      lines.splice(insertAt, 0, newLine);
      insertedLine = insertAt;
    }
  }
  const next = `${lines.join("\n")}\n`;
  const bytes = Buffer.byteLength(next, "utf-8");
  if (bytes > maxBytes) {
    return { ok: false, error: `The checklist would be ${bytes} bytes, over the ${maxBytes}-byte cap. Remove an item first (/heartbeat show lists them).` };
  }
  writeHeartbeatChecklistAtomic(path, next, current.exists ? current.content : null);
  const item = parseHeartbeatChecklist(next).find((i) => i.line === insertedLine);
  return { ok: true, n: item?.n ?? 0, text, bytes };
}

/** Delete item number `n` (as shown by /heartbeat show). */
export function removeHeartbeatChecklistItem(path: string, n: number): HeartbeatChecklistEdit {
  const current = readHeartbeatChecklist(path);
  if (!current.exists) return { ok: false, error: "There is no checklist file yet." };
  const item = current.items.find((i) => i.n === n);
  if (!item) {
    return { ok: false, error: current.items.length === 0 ? "The checklist has no items." : `No item ${n}. The checklist has ${current.items.length} item${current.items.length === 1 ? "" : "s"}.` };
  }
  const lines = current.content.split("\n");
  lines.splice(item.line, 1);
  const next = lines.join("\n");
  writeHeartbeatChecklistAtomic(path, next, current.content);
  return { ok: true, n, text: item.text, bytes: Buffer.byteLength(next, "utf-8") };
}

/** Atomic write (tmp + rename, 0600). The previous content, when given, is kept as `<path>.bak`. */
export function writeHeartbeatChecklistAtomic(path: string, content: string, previous: string | null): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (previous !== null) {
    writeFileSync(`${path}.bak`, previous, { mode: 0o600 });
    chmodSync(`${path}.bak`, 0o600);
  }
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The checklist as the owner sees it: items numbered, other lines as they are, capped. */
export function renderHeartbeatChecklist(list: HeartbeatChecklist, maxChars = 3500): string {
  if (!list.exists || !list.content.trim()) {
    return "The checklist is empty. Add an item with /heartbeat add <text>.";
  }
  const byLine = new Map(list.items.map((i) => [i.line, i]));
  const out: string[] = [];
  const lines = list.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const item = byLine.get(i);
    const line = item ? `${item.n}. ${item.text}` : lines[i]!;
    if (!line.trim() && (out.length === 0 || !out[out.length - 1]!.trim())) continue;
    out.push(line);
  }
  let text = out.join("\n").trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (cut; the file is ${list.bytes} bytes)`;
  return text;
}
