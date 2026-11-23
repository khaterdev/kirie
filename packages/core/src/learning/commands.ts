/**
 * `/learn` and `/proposals` (PLAN B.12, C.3). Owner-only, DM-only: the command
 * registry checks the owner before a handler runs; approvals are minted again
 * here from the message's channel and sender.
 *
 * /learn status | on | off | reset | now | audit [n]
 * /proposals [list [all]] | show <id> | approve <id>[,<id>] [force] | reject <id>[,<id>] [reason] | undo <id>
 */

import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { parseIntInRange } from "../commands/parse.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { AuditRecord, AuditTrail } from "../security/audit-trail.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import { mintOwnerApproval, type ProposalApplier } from "./applier.js";
import type { ProposalRecord, ProposalStore } from "./proposal-store.js";
import type { ReflectionEngine } from "./reflection.js";
import { ProposalReviewLog, proposalAllowsBulk, proposalAllowsOneTap, renderProposalDetail } from "./notifier.js";

export interface LearningCommandDeps {
  store: ProposalStore;
  applier: ProposalApplier;
  reflection: ReflectionEngine;
  owners: { isOwner(channel: ChannelName, senderId: string): boolean };
  settings: Pick<RuntimeSettings, "set" | "delete">;
  audit: Pick<AuditTrail, "record" | "recent">;
  /** Effective learning.enabled */
  enabled: () => boolean;
  /** Configured (YAML) learning.enabled */
  configEnabled: () => boolean;
  config: () => { maxPending: number; maxReflectionsPerDay: number; maxCostUsdPerDay: number; memoryPolicy: string; skillWriteGuard: string };
  /** Shared with the Show button */
  reviews?: ProposalReviewLog;
  now?: () => number;
}

export const LEARNING_ENABLED_SETTING = "learning.enabled";
const MAX_IDS = 20;

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

function parseIds(text: string | undefined): number[] | null {
  if (!text) return null;
  const parts = text.split(",").map((p) => p.trim().replace(/^#/, "")).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_IDS) return null;
  const ids: number[] = [];
  for (const p of parts) {
    const n = parseIntInRange(p, 1, Number.MAX_SAFE_INTEGER);
    if (n === null) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

function age(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function listLine(rec: ProposalRecord, now: number): string {
  const flags = rec.riskFlags.length > 0 ? ` [${rec.riskFlags.join(", ")}]` : "";
  return `#${rec.id} ${rec.kind} · ${rec.status} · ${rec.trust}${flags} · ${age(rec.createdAt, now)} · ${rec.title}`;
}

function auditLine(r: AuditRecord): string {
  const detail = r.detail ? Object.entries(r.detail).slice(0, 5).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" ") : "";
  return `${r.ts.slice(5, 16).replace("T", " ")} ${r.action}${detail ? ` ${detail}` : ""}`.slice(0, 240);
}

export function createLearningCommands(deps: LearningCommandDeps): CommandDefinition[] {
  const now = (): number => deps.now?.() ?? Date.now();
  const reviews = deps.reviews ?? new ProposalReviewLog(now);

  const learn: CommandDefinition = {
    name: "learn",
    description: "Self-learning: status, on, off, now, audit",
    category: "learning",
    ownerOnly: true,
    scope: "dm",
    args: "status | on | off | reset | now | audit [n]",
    usage:
      "/learn status: what learning does and today's counters\n" +
      "/learn on | off: turn post-turn reflection on or off (it only ever files proposals)\n" +
      "/learn reset: drop the override and use the config value\n" +
      "/learn now: reflect on this chat now\n" +
      "/learn audit [n]: the last n learning audit records (default 15)",
    subcommands: {
      status: { description: "Show learning status" },
      on: { description: "Turn reflection on" },
      off: { description: "Turn reflection off" },
      reset: { description: "Use the config value again" },
      now: { description: "Reflect on this chat now" },
      audit: { args: "[n]", description: "Recent learning audit records" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "status").toLowerCase();
      const cfg = deps.config();
      switch (sub) {
        case "status": {
          const enabled = deps.enabled();
          const t = deps.reflection.today();
          const pending = deps.store.countPending();
          const source = enabled === deps.configEnabled() ? "config" : "runtime override";
          return [
            `Self-learning (reflection): ${enabled ? "on" : "off"} (${source})`,
            "Reflection only files proposals. Nothing is written until you approve it with /proposals.",
            `Memory policy: ${cfg.memoryPolicy}. Skill write guard: ${cfg.skillWriteGuard}.`,
            `Today: ${t.reflections}/${cfg.maxReflectionsPerDay} reflections, $${t.costUsd.toFixed(3)}/$${cfg.maxCostUsdPerDay.toFixed(2)}`,
            `Pending proposals: ${pending}/${cfg.maxPending}`,
            `Last reflection: ${deps.reflection.lastRun()?.slice(0, 16).replace("T", " ") ?? "never"}`,
          ].join("\n");
        }
        case "on":
        case "off": {
          const on = sub === "on";
          deps.settings.set(LEARNING_ENABLED_SETTING, on, actorOf(ctx));
          deps.audit.record({ feature: "learning", action: on ? "learn.enabled" : "learn.disabled", actor: actorOf(ctx) });
          return on
            ? "Self-learning is on. After conversations I may file proposals; nothing changes until you approve them."
            : "Self-learning is off. Pending proposals stay reviewable with /proposals.";
        }
        case "reset": {
          deps.settings.delete(LEARNING_ENABLED_SETTING, actorOf(ctx));
          return `Override removed. Self-learning is ${deps.configEnabled() ? "on" : "off"} (config).`;
        }
        case "now": {
          if (!deps.enabled()) return "Self-learning is off. Turn it on with /learn on first.";
          const r = await deps.reflection.runNow(ctx.sessionKey);
          switch (r.status) {
            case "ok":
              return r.filed.length > 0
                ? `Filed ${r.filed.length} proposal${r.filed.length === 1 ? "" : "s"}: ${r.filed.map((id) => `#${id}`).join(", ")}. Review with /proposals.`
                : `Nothing worth keeping this time${r.dropped.length > 0 ? ` (${r.dropped.length} dropped by checks)` : ""}.`;
            case "empty":
              return "Nothing new to reflect on in this chat.";
            case "busy":
              return "A reflection is already running. Try again in a minute.";
            case "skipped":
              return `Skipped: ${r.reason ?? "limit reached"}.`;
            case "disabled":
              return "Self-learning is off.";
            default:
              return `Reflection failed (${r.reason ?? "error"}).`;
          }
        }
        case "audit": {
          const n = ctx.argv[1] ? parseIntInRange(ctx.argv[1], 1, 50) : 15;
          if (n === null) return "Usage: /learn audit [1-50]";
          const records = deps.audit.recent({ feature: "learning", limit: n });
          return records.length > 0 ? records.map(auditLine).join("\n") : "No learning audit records yet.";
        }
        default:
          return "Usage: /learn status | on | off | reset | now | audit [n]";
      }
    },
  };

  const proposals: CommandDefinition = {
    name: "proposals",
    description: "Review proposals: list, show, approve, reject, undo",
    category: "learning",
    ownerOnly: true,
    scope: "dm",
    args: "list [all] | show <id> | approve <id>[,<id>] [force] | reject <id>[,<id>] [reason] | undo <id>",
    usage:
      "/proposals or /proposals list [all]: pending (or recent) proposals\n" +
      "/proposals show <id>: full content and diff\n" +
      "/proposals approve <id>[,<id>] [force]: apply. Several ids only for owner-trust proposals without flags; force is needed for code-scanner flags\n" +
      "/proposals reject <id>[,<id>] [reason]\n" +
      "/proposals undo <id>: restore what an applied proposal changed",
    subcommands: {
      list: { args: "[all]", description: "List proposals" },
      show: { args: "<id>", description: "Show one proposal" },
      approve: { args: "<id>[,<id>] [force]", description: "Apply proposals" },
      reject: { args: "<id>[,<id>] [reason]", description: "Reject proposals" },
      undo: { args: "<id>", description: "Undo an applied proposal" },
    },
    async handler(ctx) {
      const sub = (ctx.argv[0] ?? "list").toLowerCase();
      const mint = () => mintOwnerApproval(deps.owners, { channel: ctx.message.channel, senderId: ctx.message.senderId, via: "command" });
      switch (sub) {
        case "list": {
          const all = (ctx.argv[1] ?? "").toLowerCase() === "all";
          const rows = all ? deps.store.list({ limit: 20 }) : deps.store.list({ status: ["pending", "failed"], limit: 30 });
          if (rows.length === 0) return all ? "No proposals yet." : "No pending proposals.";
          return [all ? "Recent proposals:" : "Pending proposals:", ...rows.map((r) => listLine(r, now())), "", "Details: /proposals show <id>"].join("\n");
        }
        case "show": {
          const ids = parseIds(ctx.argv[1]);
          if (!ids || ids.length !== 1) return "Usage: /proposals show <id>";
          const rec = deps.store.get(ids[0]!);
          if (!rec) return `Proposal #${ids[0]} not found.`;
          reviews.markShown(rec);
          return renderProposalDetail(rec, deps.applier.preview(rec));
        }
        case "approve": {
          const ids = parseIds(ctx.argv[1]);
          const force = ctx.argv.slice(2).some((a) => a.toLowerCase() === "force");
          if (!ids) return "Usage: /proposals approve <id>[,<id>] [force]";
          const approval = mint();
          if (!approval) return "Only the owner can approve proposals.";
          if (ids.length > 1) {
            if (force) return "force works with one proposal at a time.";
            const recs = ids.map((id) => deps.store.get(id));
            const blocked = ids.filter((_id, i) => { const r = recs[i]; return !r || !proposalAllowsBulk(r); });
            if (blocked.length > 0) {
              return `Bulk approve is only for owner-trust proposals without flags. Approve these one at a time after /proposals show: ${blocked.map((id) => `#${id}`).join(", ")}`;
            }
          } else {
            const rec = deps.store.get(ids[0]!);
            if (!rec) return `Proposal #${ids[0]} not found.`;
            if (!proposalAllowsOneTap(rec) && !reviews.wasShown(rec)) {
              return `Proposal #${rec.id} is not from your own messages alone, or is flagged. Read it first with /proposals show ${rec.id}, then approve it.`;
            }
          }
          const lines: string[] = [];
          for (const id of ids) {
            const outcome = await deps.applier.approve(id, approval, { force });
            lines.push(outcome.message);
          }
          return lines.join("\n");
        }
        case "reject": {
          const ids = parseIds(ctx.argv[1]);
          if (!ids) return "Usage: /proposals reject <id>[,<id>] [reason]";
          const approval = mint();
          if (!approval) return "Only the owner can reject proposals.";
          const reason = ctx.argv.slice(2).join(" ").trim() || undefined;
          return ids
            .map((id) => (deps.applier.reject(id, approval, reason) ? `Rejected #${id}.` : `#${id} is not pending.`))
            .join("\n");
        }
        case "undo": {
          const ids = parseIds(ctx.argv[1]);
          if (!ids || ids.length !== 1) return "Usage: /proposals undo <id>";
          const approval = mint();
          if (!approval) return "Only the owner can undo proposals.";
          return (await deps.applier.undo(ids[0]!, approval)).message;
        }
        default:
          return "Usage: /proposals list [all] | show <id> | approve <id>[,<id>] [force] | reject <id>[,<id>] [reason] | undo <id>";
      }
    },
  };

  return [learn, proposals];
}
