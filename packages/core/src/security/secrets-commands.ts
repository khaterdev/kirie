/**
 * /secrets (PLAN B.12, C.12): status, scan, report, redact. Owner-only, DM.
 *
 * There is deliberately no /secrets off: scrubbing is switched only by
 * `security.scrubbing.enabled` in config.yaml, read once at start.
 *
 * Every reply is built from counts, rule names, masked locations and
 * fingerprints. No code path here reads a matched value: the only place a
 * value is ever in memory is inside SecretsAuditor.redact, on its way into
 * the credential store (vault mode).
 */

import { homedir } from "node:os";
import type { CommandContext, CommandDefinition } from "../commands/types.js";
import { DEFAULT_SECRET_RULE_NAMES } from "./secret-patterns.js";
import type { ScrubbingConfig, SecretScrubber } from "./secret-scrubber.js";
import {
  SECRETS_ROTATION_PREAMBLE,
  SECRETS_STALE_PLAN_MESSAGE,
  secretsRuleLabel,
  type SecretsAuditor,
  type SecretsRedactionPlan,
  type SecretsRedactionResult,
  type SecretsScanFinding,
  type SecretsScanMode,
  type SecretsScanReport,
} from "./secrets-scan.js";

export interface SecretsCommandDeps {
  auditor: Pick<SecretsAuditor, "scan" | "latestReport" | "planRedaction" | "redact">;
  scrubber: Pick<SecretScrubber, "isEnabled" | "isSinkEnabled" | "stats" | "knownSecretLabels">;
  /** The frozen `security.scrubbing` of this process */
  scrubbingConfig: ScrubbingConfig;
  /** For showing report paths as ~/...; defaults to os.homedir() */
  homeDir?: string;
}

const REPORT_DEFAULT = 20;
const REPORT_MAX = 100;
const LABELS_SHOWN = 15;

const SINK_NAMES: ReadonlyArray<{ sink: Parameters<SecretScrubber["isSinkEnabled"]>[0]; label: string }> = [
  { sink: "channel", label: "channels" },
  { sink: "log", label: "logs" },
  { sink: "memory", label: "memory" },
  { sink: "chat-history", label: "chat history" },
  { sink: "task-result", label: "task results" },
  { sink: "heartbeat-log", label: "heartbeat logs" },
  { sink: "http", label: "gateway HTTP" },
  { sink: "webhook-payload", label: "webhook payloads" },
  { sink: "plugin-event", label: "plugin events" },
];

function counts(rec: Record<string, number>): string {
  const entries = Object.entries(rec).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(", ") : "none";
}

function tildePath(path: string, home: string): string {
  return home && path.startsWith(home + "/") ? `~/${path.slice(home.length + 1)}` : path;
}

function shortFp(f: SecretsScanFinding): string {
  return f.fingerprint.slice(0, 8);
}

function findingLine(f: SecretsScanFinding): string {
  const flags: string[] = [];
  if (f.suggestVault) flags.push("vault suggested");
  if (!f.redactable) flags.push(`not redactable: ${f.note ?? "n/a"}`);
  return `#${f.id} ${f.store} | ${f.location} | ${secretsRuleLabel(f)} | fp ${shortFp(f)}${flags.length ? ` | ${flags.join("; ")}` : ""}`;
}

function rotationBlock(advice: readonly string[]): string[] {
  return advice.length ? ["", SECRETS_ROTATION_PREAMBLE, ...advice.map((a) => `- ${a}`)] : [];
}

/** Parses "all", "3", "1,4,7", "2-5" and space-separated mixes. Null on anything else. */
export function parseSecretsFindingIds(tokens: readonly string[]): "all" | number[] | null {
  if (tokens.length === 1 && tokens[0]!.toLowerCase() === "all") return "all";
  const ids: number[] = [];
  for (const part of tokens.flatMap((t) => t.split(",")).map((t) => t.trim().replace(/^#/, "")).filter(Boolean)) {
    const range = /^(\d{1,6})-(\d{1,6})$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < a || b - a > 10_000) return null;
      for (let i = a; i <= b; i++) ids.push(i);
      continue;
    }
    if (!/^\d{1,6}$/.test(part) || Number(part) < 1) return null;
    ids.push(Number(part));
  }
  return ids.length ? ids : null;
}

export function renderSecretsScanSummary(report: SecretsScanReport, reportPath: string | null, home: string): string {
  const lines: string[] = [
    `Secrets scan (${report.mode}) finished: ${report.counts.total} finding(s), ${report.counts.redactable} redactable. No values are shown or stored in the report.`,
    `By store: ${counts(report.counts.byStore)}`,
    `By rule: ${counts(report.counts.byRule)}`,
  ];
  const missing = report.stores.filter((s) => s.status === "missing").map((s) => s.path);
  const errors = report.stores.filter((s) => s.status === "error").map((s) => `${s.path} (${s.error ?? "error"})`);
  if (missing.length) lines.push(`Not present: ${missing.join(", ")}`);
  if (errors.length) lines.push(`Could not read: ${errors.join(", ")}`);
  if (report.mode === "quick") lines.push("Logs were not scanned. /secrets scan full adds them.");
  if (reportPath) lines.push(`Report: ${tildePath(reportPath, home)} (0600)`);
  if (report.counts.total > 0) {
    lines.push("Send /secrets report to list them, then /secrets redact <id|all> [vault]. Nothing changes until you confirm.");
  }
  if (report.notCleanable.length) {
    lines.push("", "Kirie cannot clean these (not opened, listed only):", ...report.notCleanable.map((p) => `- ${tildePath(p, home)}`));
  }
  lines.push(...rotationBlock(report.rotationAdvice));
  return lines.join("\n");
}

function describePlan(plan: SecretsRedactionPlan): string {
  const byStore: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  for (const f of plan.findings) {
    byStore[f.store] = (byStore[f.store] ?? 0) + 1;
    const label = secretsRuleLabel(f);
    byRule[label] = (byRule[label] ?? 0) + 1;
  }
  const vaultable = plan.findings.filter((f) => f.vaultable).length;
  const lines = [
    `Findings: ${plan.findings.map((f) => `#${f.id}`).join(" ")}`,
    `By store: ${counts(byStore)}`,
    `By rule: ${counts(byRule)}`,
    plan.vault
      ? `Vault: ${vaultable} memory value(s) move into the credential store as vault.<memory-key>; the rest get the «redacted:<rule>» marker.`
      : "Each match is replaced with the «redacted:<rule>» marker.",
    "Databases: secure delete, search index rebuild, WAL checkpoint, VACUUM. Log and Markdown files: same-length overwrite in place.",
    "No backup is kept (a backup would keep the secret). This cannot be undone.",
  ];
  if (plan.skipped.length) lines.push(`Skipped: ${plan.skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
  return lines.join("\n");
}

function renderRedactResult(r: SecretsRedactionResult, home: string): string {
  const lines = [`Redacted ${r.redacted.length} finding(s).`];
  if (r.vaulted.length) {
    lines.push(`Moved into the credential store: ${r.vaulted.map((v) => `#${v.id} -> ${v.key}`).join(", ")}. The agent can use them with kirie credentials get <key>.`);
  }
  for (const d of r.databases) {
    if (d.rowsChanged === 0) continue;
    lines.push(
      `${tildePath(d.file, home)}: ${d.rowsChanged} row(s), index rebuilt (${d.ftsRebuilt.join(", ") || "none"}), ` +
      `vectors cleared ${d.vectorsCleared}, re-embedded ${d.reembedded}, checkpoint ${d.checkpoint}, vacuum ${d.vacuum}`,
    );
    if (d.checkpoint !== "complete" || d.vacuum !== "ok") {
      lines.push(d.vacuum === "skipped"
        ? "  VACUUM was skipped (file over 256 MB, it would block Kirie): freed pages were zeroed by secure delete, but run /secrets scan again after a restart."
        : "  The WAL or free pages may still hold old copies until Kirie restarts; run /secrets scan again afterwards.");
    }
  }
  for (const f of r.files) {
    if (f.masked === 0) continue;
    lines.push(`${tildePath(f.file, home)}: ${f.masked} masked in place (size ${f.sizeKept ? "kept" : "CHANGED"}, inode ${f.inodeKept ? "kept" : "CHANGED"})`);
  }
  if (r.skipped.length) lines.push(`Skipped: ${r.skipped.map((s) => `#${s.id} (${s.reason})`).join(", ")}`);
  lines.push(...rotationBlock(r.rotationAdvice));
  return lines.join("\n");
}

function actorOf(ctx: CommandContext): string {
  return `owner:${ctx.message.channel}:${ctx.message.senderId}`;
}

export function createSecretsCommands(deps: SecretsCommandDeps): CommandDefinition[] {
  const home = deps.homeDir ?? homedir();

  function status(): string {
    const cfg = deps.scrubbingConfig;
    const enabled = deps.scrubber.isEnabled();
    const disabled = new Set(cfg.disabledRules ?? []);
    const ruleCount = DEFAULT_SECRET_RULE_NAMES.filter((r) => !disabled.has(r)).length +
      (cfg.customPatterns ?? []).filter((p) => !disabled.has(p.name)).length;
    const sinksOn = SINK_NAMES.filter((s) => deps.scrubber.isSinkEnabled(s.sink)).map((s) => s.label);
    const stats = deps.scrubber.stats();
    const labels = deps.scrubber.knownSecretLabels().sort();
    const bySource: Record<string, number> = {};
    for (const l of labels) {
      const src = l.split(":")[0] ?? "other";
      bySource[src] = (bySource[src] ?? 0) + 1;
    }
    const lines = [
      `Secret scrubbing: ${enabled ? "ON" : "OFF (security.scrubbing.enabled: false; changes need a config edit and a restart)"}`,
      `Sinks scrubbed: ${enabled ? (sinksOn.join(", ") || "none") : "none"}`,
      `Rules active: ${ruleCount}${disabled.size ? ` (disabled: ${[...disabled].sort().join(", ")})` : ""}`,
      `Known secrets: ${labels.length}${labels.length ? ` (${counts(bySource)})` : ""}`,
    ];
    if (labels.length) {
      lines.push(`  ${labels.slice(0, LABELS_SHOWN).join(", ")}${labels.length > LABELS_SHOWN ? `, +${labels.length - LABELS_SHOWN} more` : ""}`);
    }
    lines.push(`Redactions since start, by sink: ${counts(stats.bySink)}`);
    lines.push(`Redactions since start, by rule: ${counts(stats.byRule)}`);
    const last = deps.auditor.latestReport();
    lines.push(last
      ? `Last scan: ${last.report.finishedAt} (${last.report.mode}), ${last.report.counts.total} finding(s), ${last.report.counts.redactable} redactable${last.current ? "" : " (from before the last restart; scan again to redact)"}`
      : "Last scan: never. Send /secrets scan.");
    return lines.join("\n");
  }

  function scan(ctx: CommandContext, modeArg?: string): string {
    const m = (modeArg ?? "quick").toLowerCase();
    if (m !== "quick" && m !== "full") return "Usage: /secrets scan [quick|full]";
    const { report, reportPath } = deps.auditor.scan(m as SecretsScanMode, { writeReport: true, actor: actorOf(ctx) });
    return renderSecretsScanSummary(report, reportPath, home);
  }

  function report(nArg?: string): string {
    const last = deps.auditor.latestReport();
    if (!last) return "No scan yet. Send /secrets scan.";
    let n = REPORT_DEFAULT;
    if (nArg !== undefined) {
      if (!/^\d{1,4}$/.test(nArg) || Number(nArg) < 1) return `Usage: /secrets report [n], n from 1 to ${REPORT_MAX}`;
      n = Math.min(Number(nArg), REPORT_MAX);
    }
    const all = last.report.findings;
    if (all.length === 0) return `The last scan (${last.report.finishedAt}) found nothing.`;
    const shown = all.slice(0, n);
    return [
      `Last scan ${last.report.finishedAt} (${last.report.mode}): ${all.length} finding(s). Showing ${shown.length}. Values are never shown.`,
      ...shown.map(findingLine),
      ...(all.length > shown.length ? [`+${all.length - shown.length} more: /secrets report ${Math.min(all.length, REPORT_MAX)}, or read ${tildePath(last.path, home)}`] : []),
      ...(last.current ? [] : ["This report is from before the last restart. Send /secrets scan again before redacting."]),
    ].join("\n");
  }

  async function redact(ctx: CommandContext, tokens: readonly string[]): Promise<string> {
    const vault = tokens.some((t) => t.toLowerCase() === "vault");
    const idTokens = tokens.filter((t) => t.toLowerCase() !== "vault");
    const ids = parseSecretsFindingIds(idTokens);
    if (!ids) return "Usage: /secrets redact <id|all> [vault]   (ids from /secrets report, e.g. 3, 1,4,7 or 2-5)";
    const plan = deps.auditor.planRedaction(ids, { vault });
    if ("error" in plan) return plan.error;
    if (plan.findings.length === 0) {
      const why = plan.skipped.length ? ` ${plan.skipped.map((s) => `#${s.id}: ${s.reason}`).join("; ")}` : "";
      return `Nothing to redact.${why}`;
    }
    const ok = await ctx.confirm(`Redact ${plan.findings.length} stored secret(s)?`, describePlan(plan));
    if (!ok) return "Cancelled. Nothing was changed.";
    try {
      const result = await deps.auditor.redact(plan, actorOf(ctx));
      return renderRedactResult(result, home);
    } catch (err) {
      // Only the auditor's own fixed message is shown; anything else is reduced to its code.
      const e = err as { message?: unknown; code?: unknown };
      const reason = typeof e?.message === "string" && e.message.startsWith(SECRETS_STALE_PLAN_MESSAGE)
        ? e.message
        : `error ${typeof e?.code === "string" ? e.code : "(see the daemon log)"}`;
      return `Redact stopped: ${reason}. Check /secrets report and scan again before retrying.`;
    }
  }

  return [
    {
      name: "secrets",
      description: "Secret scrubbing: status, scan, report, redact",
      category: "security",
      ownerOnly: true,
      scope: "dm",
      args: "[status | scan [quick|full] | report [n] | redact <id|all> [vault]]",
      usage:
        "/secrets shows whether scrubbing is on and what it has redacted. /secrets scan audits the stores read-only " +
        "(quick: databases, Markdown and config; full: also logs). /secrets redact changes stored data only after you confirm. " +
        "There is no /secrets off: scrubbing is switched in config.yaml and read at start.",
      subcommands: {
        status: { description: "On or off, sinks, rules, known secrets (labels only), counters, last scan" },
        scan: { args: "[quick|full]", description: "Read-only audit of the stores; writes a report without values" },
        report: { args: "[n]", description: "List findings of the last scan: id, store, location, rule, fingerprint" },
        redact: { args: "<id|all> [vault]", description: "Replace findings with a marker (vault: memory values move into the credential store); asks first" },
      },
      async handler(ctx) {
        const [sub = "status", ...rest] = ctx.argv;
        switch (sub.toLowerCase()) {
          case "status":
            return status();
          case "scan":
            return scan(ctx, rest[0]);
          case "report":
            return report(rest[0]);
          case "redact":
            return redact(ctx, rest);
          default:
            return "Usage: /secrets [status | scan [quick|full] | report [n] | redact <id|all> [vault]]";
        }
      },
    },
  ];
}
