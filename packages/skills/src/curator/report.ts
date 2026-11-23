/**
 * Building a `CuratorReport` (the type lives in @kirie/core so the commands
 * and the read-only MCP tools can read stored reports without depending on
 * this package). Reports name skills, detectors and proposal ids only, never
 * file bodies.
 */

import { scrubSecrets, type CuratorFinding, type CuratorReport, type CuratorTrigger } from "@kirie/core";

/** Findings kept in a stored report. */
export const MAX_REPORT_FINDINGS = 300;

export function newCuratorReport(trigger: CuratorTrigger, startedAt: Date, merge: boolean): CuratorReport {
  return {
    version: 1,
    trigger,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    merge,
    counts: { skills: 0, broken: 0, duplicates: 0, stale: 0, drift: 0, proposals: 0 },
    findings: [],
    proposals: [],
    dropped: [],
    staleMarked: [],
    possibleDuplicates: [],
    llm: { calls: 0, costUsd: 0, errors: 0 },
    errors: [],
  };
}

const SEVERITY_ORDER: Record<CuratorFinding["severity"], number> = { error: 0, warn: 1, info: 2 };

/** Sort findings (errors first), count skills per category, cap the list. */
export function finalizeCuratorReport(report: CuratorReport, findings: readonly CuratorFinding[], finishedAt: Date): CuratorReport {
  const skillsIn = (category: CuratorFinding["category"], minSeverity: CuratorFinding["severity"] = "info"): number =>
    new Set(findings.filter((f) => f.category === category && SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[minSeverity]).map((f) => `${f.root}:${f.skill}`)).size;
  const sorted = [...findings].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.category.localeCompare(b.category) || a.skill.localeCompare(b.skill) || a.detector.localeCompare(b.detector));
  return {
    ...report,
    finishedAt: finishedAt.toISOString(),
    // Messages can quote frontmatter (names, YAML errors): scrubbed like any stored text.
    findings: sorted.slice(0, MAX_REPORT_FINDINGS).map((f) => ({ ...f, message: scrubSecrets(f.message, { sink: "proposal" }) })),
    errors: report.errors.map((e) => scrubSecrets(e, { sink: "proposal" })),
    counts: {
      ...report.counts,
      broken: skillsIn("broken", "warn"),
      duplicates: duplicateSkillCount(findings),
      stale: skillsIn("stale"),
      drift: skillsIn("drift"),
      proposals: report.proposals.length,
    },
  };
}

/** Project skills involved in a D1, D3 or D4 pair (both sides). */
function duplicateSkillCount(findings: readonly CuratorFinding[]): number {
  const names = new Set<string>();
  for (const f of findings) {
    if (f.category !== "duplicate" || f.detector === "D2") continue;
    names.add(f.skill);
    if (typeof f.data?.other === "string") names.add(f.data.other);
  }
  return names.size;
}

/** True when the report has something the owner should hear about. */
export function curatorReportHasNews(report: CuratorReport): boolean {
  return report.proposals.length > 0 || report.findings.some((f) => f.severity !== "info") || report.errors.length > 0;
}
