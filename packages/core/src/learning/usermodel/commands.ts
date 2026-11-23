/**
 * `/profile` (PLAN B.12, C.5). Owner-only, DM-only: the command registry
 * checks the owner before a handler runs. Forget, rebuild and wipe ask for
 * confirmation through the owner prompt service (`ctx.confirm`).
 *
 * /profile status | show [category] | card | recent | why <id> | forget <id>
 *          | pin <id> | unpin <id> | add [category:] <text> | rebuild
 *          | on | off | reset | inject on|off | export | wipe
 */

import type { EmbeddingProvider } from "@kirie/memory";
import { parseIntInRange } from "../../commands/parse.js";
import type { CommandContext, CommandDefinition } from "../../commands/types.js";
import type { RuntimeSettings } from "../../config/runtime-settings.js";
import type { UserModelConfig } from "../../config/sections/usermodel.js";
import type { AuditTrail } from "../../security/audit-trail.js";
import { scrubSecrets } from "../../security/secret-scrubber.js";
import { USER_MODEL_CONFIDENCE, checkUserFactStatement } from "./checks.js";
import { isUserFactStale } from "./consolidate.js";
import { USER_MODEL_KV, type UserModelDeriver, type UserModelRunResult } from "./deriver.js";
import { embedUserModelTexts, type UserModelEmbedderSource } from "./embedder.js";
import {
  USER_FACT_CARD_MIN_CONFIDENCE,
  USER_FACT_CATEGORIES,
  isUserFactCategory,
  userFactStatementHash,
  type UserFact,
  type UserFactCategory,
  type UserFactStore,
} from "./fact-store.js";
import { userModelExcludedCategories } from "./sensitive.js";
import type { UserModelHistorySource } from "./source.js";
import type { LearningKv } from "../learning-db.js";

export const USER_MODEL_ENABLED_SETTING = "userModel.enabled";
export const USER_MODEL_INJECT_SETTING = "userModel.inject";

const REPLY_CHUNK_CHARS = 3500;
const MAX_EXPORT_CHUNKS = 10;

export interface UserModelCommandDeps {
  store: UserFactStore;
  deriver: UserModelDeriver;
  kv: LearningKv;
  history: UserModelHistorySource;
  settings: Pick<RuntimeSettings, "set" | "delete">;
  audit: Pick<AuditTrail, "record">;
  /** Effective and configured `userModel.enabled` */
  enabled: () => boolean;
  configEnabled: () => boolean;
  /** Effective and configured `userModel.inject` */
  inject: () => boolean;
  configInject: () => boolean;
  config: () => UserModelConfig;
  /** Current card body (what the owner's DM prompt gets) */
  card: () => string;
  /** Re-render the card and USER.md; `closeSessions` makes a removal reach live sessions now. */
  refresh: (opts?: { closeSessions?: boolean }) => void;
  embedder: () => EmbeddingProvider | null;
  embedderSource: () => UserModelEmbedderSource;
  /** Retire `user_fact.add` proposals for these statement hashes (or all), so forgotten or wiped text is not approvable. */
  retireProposals: (hashes: ReadonlySet<string> | "all") => { dropped: number; redacted: number };
  now?: () => Date;
}

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function band(c: number): "high" | "medium" | "low" {
  return c >= 0.8 ? "high" : c >= USER_FACT_CARD_MIN_CONFIDENCE ? "medium" : "low";
}

function date(iso: string): string {
  return iso.slice(0, 10);
}

/** Split text into reply-sized chunks on line boundaries. */
export function chunkUserModelReply(text: string, size = REPLY_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const piece = line.length > size ? `${line.slice(0, size - 1)}…` : line;
    if (cur && cur.length + 1 + piece.length > size) {
      out.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseId(text: string | undefined): number | null {
  if (!text) return null;
  return parseIntInRange(text.replace(/^#/, ""), 1, Number.MAX_SAFE_INTEGER);
}

/** Keyword guess for `/profile add` without a category. */
export function guessUserFactCategory(text: string): UserFactCategory {
  const t = text.toLowerCase();
  if (/\b(works? on|building|project|repo)\b/.test(t)) return "project";
  if (/\b(uses|tool|editor|ide|terminal|stack|language)\b/.test(t)) return "tooling";
  if (/\b(wakes?|sleeps?|morning|evening|weekend|weekdays?|timezone|schedule|hours)\b/.test(t)) return "schedule";
  if (/\b(replies|reply|messages?|tone|language|emoji|concise|brief|verbose|formal)\b/.test(t)) return "communication";
  if (/\b(goal|wants to|plans to|aims? to)\b/.test(t)) return "goal";
  if (/\b(never|must not|can't|cannot|only)\b/.test(t)) return "constraint";
  if (/\b(is a|name is|called|lives in|from)\b/.test(t)) return "identity";
  return "preference";
}

function factLine(f: UserFact, now: Date): string {
  const marks = [f.kind, band(f.confidence), `confirmed ${date(f.lastConfirmedAt)}`];
  if (f.pinned) marks.unshift("pinned");
  if (f.status !== "active") marks.unshift(f.status);
  if (isUserFactStale(f, now)) marks.push(`unconfirmed since ${date(f.lastConfirmedAt)}`);
  return `#${f.id} [${f.category}] ${f.statement} (${marks.join(", ")})`;
}

function describeRun(r: UserModelRunResult): string {
  const c = r.counts;
  switch (r.status) {
    case "ok": {
      const parts = [`${c.messages} message${c.messages === 1 ? "" : "s"} read`, `${c.added} added`, `${c.updated} updated`, `${c.confirmed} confirmed`];
      if (c.proposed > 0) parts.push(`${c.proposed} filed for approval (/proposals)`);
      const dropped = c.droppedSensitive + c.droppedTombstone + c.droppedOther;
      if (dropped > 0) parts.push(`${dropped} dropped by checks`);
      return `${parts.join(", ")}.${r.morePending ? " More history is left; I continue within the daily cost cap." : ""}`;
    }
    case "empty":
      return "No messages of yours to read.";
    case "skipped":
      return r.reason === "daily_cost"
        ? "Today's cost cap is used up; I continue tomorrow."
        : r.reason === "proposals_unavailable"
          ? "Approval is required for profile facts, but the proposals store is not running."
          : `Skipped (${r.reason ?? "unknown"}).`;
    case "busy":
      return "A profile update is already running.";
    case "disabled":
      return "The user model is off. Turn it on with /profile on.";
    default:
      return `The update failed (${r.reason ?? "error"}). Facts written before the failure are kept.`;
  }
}

export const USER_MODEL_ON_TEXT = [
  "User model is on.",
  "What I read: only messages you write to me in this direct chat. Never other people's messages, group chats, my own replies, tool output, web pages, webhooks or scheduled text.",
  "How: a few times a day, when you have been idle, a no-tools model call on the same Claude account as our chats turns new messages into short facts. Nothing goes to any other service.",
  "What I skip: health, relationships, religion, politics, ethnicity, legal status, money, ids, passwords, exact addresses and other people's private details. The filter is keyword-based and English-first, so check /profile show now and then.",
  "Where: ~/.kirie/learning.db and the card ~/.kirie/USER.md (both private to your user).",
  "Inspect with /profile show, /profile card, /profile why <id>; remove with /profile forget <id>; /profile off stops it.",
].join("\n");

export function createUserModelCommands(deps: UserModelCommandDeps): CommandDefinition[] {
  const now = (): Date => deps.now?.() ?? new Date();

  const profile: CommandDefinition = {
    name: "profile",
    description: "Your profile as I model it: status, show, card, recent, why, forget, pin, add, rebuild, on, off, inject, export, wipe",
    category: "learning",
    ownerOnly: true,
    scope: "dm",
    args: "status | show [category] | card | recent | why <id> | forget <id> | pin <id> | unpin <id> | add <text> | rebuild | on | off | inject on|off | export | wipe",
    usage: [
      "/profile status: on/off, fact counts, last update, today's cost",
      `/profile show [category]: the facts I keep (categories: ${USER_FACT_CATEGORIES.join(", ")})`,
      "/profile card: the exact text added to my prompt in this chat",
      "/profile recent: facts added or changed by the last update",
      "/profile why <id>: the messages a fact is based on",
      "/profile forget <id>: delete a fact for good (it is not derived again)",
      "/profile pin <id> | unpin <id>: keep a fact in the card and never change it automatically",
      "/profile add [category:] <text>: add a pinned fact yourself",
      "/profile rebuild: drop unpinned facts and derive again from all your messages",
      "/profile on | off: turn the user model on or off; /profile reset uses the config value",
      "/profile inject on | off: whether the card is added to my prompt",
      "/profile export: all facts as JSON",
      "/profile wipe: delete every fact, every forget record and USER.md, and turn the model off",
    ].join("\n"),
    subcommands: {
      status: { description: "Show user model status" },
      show: { args: "[category]", description: "List facts" },
      card: { description: "Show the prompt card" },
      recent: { description: "Facts changed by the last update" },
      why: { args: "<id>", description: "Evidence for a fact" },
      forget: { args: "<id>", description: "Forget a fact for good" },
      pin: { args: "<id>", description: "Pin a fact" },
      unpin: { args: "<id>", description: "Unpin a fact" },
      add: { args: "[category:] <text>", description: "Add a pinned fact" },
      rebuild: { description: "Derive the profile again from all messages" },
      on: { description: "Turn the user model on" },
      off: { description: "Turn the user model off" },
      reset: { description: "Use the config values again" },
      inject: { args: "on|off", description: "Add the card to my prompt or not" },
      export: { description: "Export all facts as JSON" },
      wipe: { description: "Delete everything and turn off" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "status").toLowerCase();
      const actor = actorOf(ctx);
      const cfg = deps.config();
      switch (sub) {
        case "status": {
          const c = deps.store.counts();
          const enabled = deps.enabled();
          const inject = deps.inject();
          const cats = Object.entries(c.byCategory).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ");
          const card = deps.card();
          return [
            `User model: ${enabled ? "on" : "off"} (${enabled === deps.configEnabled() ? "config" : "runtime override"}). Prompt card: ${inject ? "on" : "off"}${cfg.requireApproval ? ". New facts need your approval (/proposals)" : ""}.`,
            `Facts: ${c.active} active (${c.explicit} explicit, ${c.inferred} inferred, ${c.pinned} pinned), ${c.suppressed} suppressed, ${c.superseded} superseded; ${c.tombstones} forgotten.`,
            cats ? `By category: ${cats}.` : "No facts yet.",
            `Card: ${c.cardEligible} eligible facts, ${card.length}/${cfg.promptBudgetChars} chars.`,
            `Last update: ${deps.deriver.lastRun()?.slice(0, 16).replace("T", " ") ?? "never"}${deps.deriver.rebuildPending() ? " (rebuild in progress)" : ""}. Read up to message #${deps.deriver.watermark()}.`,
            `Today's cost: $${deps.deriver.todayCost().toFixed(3)}/$${cfg.maxCostUsdPerDay.toFixed(2)}. Embeddings: ${deps.embedderSource() === "none" ? "none (keyword matching)" : deps.embedderSource()}.`,
          ].join("\n");
        }

        case "show": {
          const catArg = ctx.argv[1]?.toLowerCase();
          if (catArg && !isUserFactCategory(catArg)) return `Unknown category. Use one of: ${USER_FACT_CATEGORIES.join(", ")}.`;
          const facts = deps.store.list({ status: "active", ...(catArg ? { category: catArg as UserFactCategory } : {}) });
          if (facts.length === 0) return catArg ? `No ${catArg} facts.` : "No facts yet.";
          const lines = facts.map((f) => factLine(f, now()));
          const chunks = chunkUserModelReply(lines.join("\n"));
          if (chunks.length === 1) return chunks[0]!;
          const shownLines = chunks[0]!.split("\n").length;
          return `${chunks[0]}\n… and ${facts.length - shownLines} more. Narrow it with /profile show <category>.`;
        }

        case "card": {
          const card = deps.card();
          if (!card) {
            return `The card is empty: no fact is pinned or at medium confidence yet.${deps.enabled() ? "" : " The user model is off."}`;
          }
          const state = deps.enabled() && deps.inject() ? "added to my prompt in this chat" : "not added to my prompt (model or card is off)";
          return `${card}\n\n(${card.length}/${cfg.promptBudgetChars} chars, ${state})`;
        }

        case "recent": {
          const last = deps.deriver.lastChanges();
          if (!last || last.ids.length === 0) return "Nothing changed in the last update.";
          const facts = last.ids.map((id) => deps.store.get(id)).filter((f): f is UserFact => f !== null);
          if (facts.length === 0) return "The facts from the last update were since removed.";
          return chunkUserModelReply([`Changed on ${last.at.slice(0, 16).replace("T", " ")}:`, ...facts.map((f) => factLine(f, now()))].join("\n"))[0]!;
        }

        case "why": {
          const id = parseId(ctx.argv[1]);
          if (id === null) return "Usage: /profile why <id>";
          const fact = deps.store.get(id);
          if (!fact) return `No fact #${id}.`;
          const chatIds = fact.evidence.filter((e) => e.t === "chat").map((e) => (e as { id: number }).id);
          const rows = new Map(deps.history.byIds(chatIds).map((r) => [r.id, r]));
          const lines = [factLine(fact, now()), `Seen on ${fact.evidenceDays} day${fact.evidenceDays === 1 ? "" : "s"}. Evidence:`];
          for (const e of fact.evidence) {
            if (e.t === "command") { lines.push(`- added by you with /profile add on ${date(e.at)}`); continue; }
            const row = rows.get(e.id);
            const snippet = row ? `"${scrubSecrets(row.content.replace(/\s+/g, " "), { sink: "channel" }).slice(0, 120)}"` : "(message no longer in chat history)";
            lines.push(`- message #${e.id}${e.ts ? ` (${e.ts})` : ""}: ${snippet}`);
          }
          return chunkUserModelReply(lines.join("\n"))[0]!;
        }

        case "forget": {
          const id = parseId(ctx.argv[1]);
          if (id === null) return "Usage: /profile forget <id>";
          const fact = deps.store.get(id);
          if (!fact) return `No fact #${id}.`;
          const ok = await ctx.confirm(`Forget profile fact #${id}?`, `${fact.statement}\n\nThe text is deleted and I will not derive it again.`);
          if (!ok) return "Cancelled. Nothing was forgotten.";
          deps.deriver.invalidate();
          const { rows: n, hashes } = deps.store.forget(id, now());
          const retired = deps.retireProposals(new Set(hashes));
          deps.audit.record({ feature: "usermodel", action: "fact.forgotten", actor, detail: { id, rows: n, proposalsDropped: retired.dropped } });
          deps.refresh({ closeSessions: true });
          return `Forgotten #${id}${n > 1 ? ` (and ${n - 1} earlier version${n === 2 ? "" : "s"})` : ""}. I will not derive it again; /profile add brings it back if you want.`;
        }

        case "pin":
        case "unpin": {
          const id = parseId(ctx.argv[1]);
          if (id === null) return `Usage: /profile ${sub} <id>`;
          const pinned = sub === "pin";
          if (!deps.store.setPinned(id, pinned, now())) return `No active fact #${id}.`;
          deps.audit.record({ feature: "usermodel", action: pinned ? "fact.pinned" : "fact.unpinned", actor, detail: { id } });
          deps.refresh({ closeSessions: !pinned });
          return pinned ? `Pinned #${id}: it stays in the card and is never changed automatically.` : `Unpinned #${id}.`;
        }

        case "add": {
          const raw = ctx.args.replace(/^\S+\s*/, "").trim();
          if (!raw) return "Usage: /profile add [category:] <text>";
          const m = /^([a-z_]+)\s*:\s*(.+)$/s.exec(raw);
          const category: UserFactCategory = m && isUserFactCategory(m[1]) ? m[1] : guessUserFactCategory(raw);
          const text = m && isUserFactCategory(m[1]) ? m[2]! : raw;
          const checked = checkUserFactStatement(text, category, "explicit", userModelExcludedCategories(cfg.excludeCategories), "owner");
          if (!checked.ok) {
            return checked.reason.startsWith("sensitive:") || checked.reason === "secret"
              ? `Not stored: it looks like ${checked.reason === "secret" ? "a secret" : `${checked.reason.slice("sensitive:".length).replace(/_/g, " ")} information`}, which the profile never keeps.`
              : `Not stored (${checked.reason}). Write it as a short fact about you, under 240 characters.`;
          }
          const at = now();
          const existing = deps.store.findActiveByHash(checked.hash);
          if (existing) {
            deps.store.setPinned(existing.id, true, at);
            deps.refresh();
            return `Already known as #${existing.id}; pinned it.`;
          }
          const lifted = deps.store.removeTombstone(userFactStatementHash(checked.statement));
          const [vector] = await embedUserModelTexts(deps.embedder(), [checked.statement]);
          const fact = deps.store.insert({
            category,
            statement: checked.statement,
            kind: "explicit",
            confidence: USER_MODEL_CONFIDENCE.owner,
            pinned: true,
            evidence: [{ t: "command", at: at.toISOString() }],
            embedding: vector ?? null,
            now: at,
          });
          deps.audit.record({ feature: "usermodel", action: "fact.added", actor, detail: { id: fact.id, category, liftedTombstone: lifted } });
          deps.refresh();
          return `Added #${fact.id} [${category}], pinned.`;
        }

        case "rebuild": {
          if (!deps.enabled()) return "The user model is off. Turn it on with /profile on first.";
          if (deps.deriver.isRunning()) return "A profile update is already running.";
          const ok = await ctx.confirm(
            "Rebuild your profile?",
            "Every fact that is not pinned is deleted and derived again from all your messages, within the daily cost cap. Forgotten facts stay forgotten.",
          );
          if (!ok) return "Cancelled. Nothing changed.";
          deps.audit.record({ feature: "usermodel", action: "rebuild", actor });
          void deps.deriver.rebuild().then(
            async (r) => {
              deps.refresh({ closeSessions: true });
              await ctx.reply(`Profile rebuild: ${describeRun(r)}`);
            },
            () => undefined,
          );
          return "Rebuilding your profile from your messages. I will report when the first pass is done.";
        }

        case "on":
        case "off": {
          const on = sub === "on";
          if (!on) deps.deriver.invalidate();
          deps.settings.set(USER_MODEL_ENABLED_SETTING, on, actor);
          deps.audit.record({ feature: "usermodel", action: on ? "enabled" : "disabled", actor });
          deps.refresh({ closeSessions: !on });
          return on
            ? USER_MODEL_ON_TEXT
            : "User model is off: no new facts, and the card is no longer added to my prompt. Your facts stay until /profile wipe.";
        }

        case "reset": {
          deps.deriver.invalidate();
          deps.settings.delete(USER_MODEL_ENABLED_SETTING, actor);
          deps.settings.delete(USER_MODEL_INJECT_SETTING, actor);
          deps.refresh({ closeSessions: true });
          return `Overrides removed. User model ${deps.configEnabled() ? "on" : "off"}, card ${deps.configInject() ? "on" : "off"} (config).`;
        }

        case "inject": {
          const arg = ctx.argv[1]?.toLowerCase();
          if (arg !== "on" && arg !== "off") return "Usage: /profile inject on|off";
          const on = arg === "on";
          deps.settings.set(USER_MODEL_INJECT_SETTING, on, actor);
          deps.audit.record({ feature: "usermodel", action: on ? "inject.enabled" : "inject.disabled", actor });
          deps.refresh({ closeSessions: !on });
          return on
            ? `The card is added to my prompt in this chat${deps.enabled() ? "" : " once the user model is on (/profile on)"}.`
            : "The card is no longer added to my prompt. Facts are still kept and updated.";
        }

        case "export": {
          const facts = deps.store.list({ status: "all" });
          if (facts.length === 0) return "No facts to export.";
          const json = JSON.stringify({
            exportedAt: now().toISOString(),
            facts: facts.map((f) => ({
              id: f.id, category: f.category, statement: f.statement, kind: f.kind, confidence: f.confidence, status: f.status,
              pinned: f.pinned, evidence: f.evidence, firstSeenAt: f.firstSeenAt, lastConfirmedAt: f.lastConfirmedAt, supersededBy: f.supersededBy,
            })),
          }, null, 1);
          const chunks = chunkUserModelReply(json);
          deps.audit.record({ feature: "usermodel", action: "export", actor, detail: { facts: facts.length, parts: chunks.length } });
          const sendable = chunks.slice(0, MAX_EXPORT_CHUNKS);
          for (const part of sendable.slice(0, -1)) await ctx.reply(part);
          const tail = chunks.length > MAX_EXPORT_CHUNKS ? `\n(${chunks.length - MAX_EXPORT_CHUNKS} more parts not sent; use /profile show per category)` : "";
          return `${sendable[sendable.length - 1]}${tail}`;
        }

        case "wipe": {
          const ok = await ctx.confirm(
            "Wipe your profile?",
            "Every fact, every forget record and USER.md are deleted, and the user model is turned off. This cannot be undone.",
          );
          if (!ok) return "Cancelled. Nothing was deleted.";
          deps.deriver.invalidate();
          deps.settings.set(USER_MODEL_ENABLED_SETTING, false, actor);
          const r = deps.store.wipe();
          const retired = deps.retireProposals("all");
          for (const key of [USER_MODEL_KV.watermark, USER_MODEL_KV.lastRun, USER_MODEL_KV.rebuild, USER_MODEL_KV.lastChanges, USER_MODEL_KV.parseFailures]) {
            deps.kv.delete(key);
          }
          deps.audit.record({ feature: "usermodel", action: "wipe", actor, detail: { ...r, proposalsDropped: retired.dropped } });
          deps.refresh({ closeSessions: true });
          return `Wiped ${r.facts} facts and ${r.tombstones} forget records, removed USER.md, and turned the user model off.`;
        }

        default:
          return "Usage: /profile status | show [category] | card | recent | why <id> | forget <id> | pin <id> | unpin <id> | add <text> | rebuild | on | off | reset | inject on|off | export | wipe";
      }
    },
  };
  return [profile];
}
