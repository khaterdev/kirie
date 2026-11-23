/**
 * Proposal intake (PLAN B.7, R4 section 0.7).
 *
 * Validate, scrub, flag, dedupe, cap, insert as pending. Never applies
 * anything, so it is safe to expose anywhere (the agent's `learning_propose`
 * tool uses it from the stdio subprocess). Trust is decided by code: an
 * `agent_tool` proposal is always `unverified` here, whatever the caller says;
 * the turn recorder finalizes it from the turn's provenance.
 *
 * `checkProposalContent` is also run again by the applier on the stored
 * payload before anything is written (defence in depth).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { getScrubber } from "../security/secret-scrubber.js";
import { SUSPICIOUS_INPUT_PATTERNS } from "../security/input-guard.js";
import { scanCode } from "../security/code-scanner.js";
import type { AuditTrail } from "../security/audit-trail.js";
import { createModuleLogger } from "../logging/logger.js";
import { stripInvisibleChars } from "./invisible-chars.js";
import type { ProposalStore } from "./proposal-store.js";
import type { SkillStateStore } from "./skill-state-store.js";
import {
  LARGE_PAYLOAD_CHARS,
  MAX_RATIONALE_CHARS,
  MAX_TITLE_CHARS,
  PROPOSAL_PAYLOAD_SCHEMAS,
  isLowTrust,
  isProposalKind,
  isProposalOrigin,
  isProposalTrust,
  isSkillContentKind,
  payloadHash8,
  proposalPayloadHash,
  sha256Hex,
  type ProposalKind,
  type ProposalOrigin,
  type ProposalTrust,
  type RiskFlag,
} from "./proposal-types.js";

const log = createModuleLogger("learning-intake");

export interface ProposalSubmission {
  kind: ProposalKind;
  title: string;
  rationale?: string;
  payload: unknown;
  origin: ProposalOrigin;
  trust: ProposalTrust;
  sourceSessionKey?: string;
  sourceTurnIds?: number[];
  /** Chat-history id range the proposal was derived from (reflection). */
  sourceMsgFrom?: number;
  sourceMsgTo?: number;
}

export type ProposalSubmitResult = { id: number } | { dropped: string };

/** PLAN B.7 */
export interface ProposalIntake {
  /** Validate, scrub, flag, dedupe, cap, insert as pending. Never applies anything. Safe to expose anywhere. */
  submit(input: ProposalSubmission): ProposalSubmitResult;
}

export type LearningAuditSink = Pick<AuditTrail, "record">;

// ---------------------------------------------------------------------------
// Content checks (steps 1 to 5)
// ---------------------------------------------------------------------------


const EXTRA_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules?|messages?)/i,
  /\bcurl\b[^\n|]*\|\s*(?:ba|z)?sh\b/i,
  /\bwget\b[^\n|]*\|\s*(?:ba|z)?sh\b/i,
  /\bbase64\s+(?:-d|--decode)\b/i,
  /\bdo\s+not\s+tell\b/i,
  /\bwithout\s+asking\b/i,
  /\balways\s+approve\b/i,
  /\bauto-?approve\b/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

export function hasInjectionPattern(text: string): boolean {
  return SUSPICIOUS_INPUT_PATTERNS.some((p) => p.regex.test(text)) || EXTRA_INJECTION_PATTERNS.some((re) => re.test(text));
}

export interface SkillFrontmatter {
  name: string;
  description: string;
}

/** Parse the YAML frontmatter of a SKILL.md. Tolerates CRLF. Null when missing or invalid. */
export function parseSkillFrontmatter(skillMd: string): SkillFrontmatter | null {
  const text = skillMd.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  let data: unknown;
  try {
    data = YAML.parse(m[1] ?? "");
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== "string" || typeof description !== "string") return null;
  return { name: name.trim(), description: description.trim() };
}

function fencedBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push(m[1] ?? "");
  return out;
}

function skillMdOf(kind: ProposalKind, payload: Record<string, unknown>): { md: string; expectedName: string } | null {
  switch (kind) {
    case "skill.create":
      return { md: String(payload.skillMd), expectedName: String(payload.name) };
    case "skill.patch":
    case "skill.fix":
      return { md: String(payload.newSkillMd), expectedName: String(payload.name) };
    case "skill.merge":
      return { md: String(payload.mergedSkillMd), expectedName: String(payload.into) };
    default:
      return null;
  }
}

/** Walk every string in a JSON value; `fn` returns the replacement. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

export type ContentCheckResult =
  | { ok: true; payload: Record<string, unknown>; title: string; rationale: string; redactions: number; flags: RiskFlag[] }
  | { ok: false; reason: string };

/**
 * Steps 1 to 5 of R4 0.7: schema, invisible-character strip, scrub, injection
 * heuristics, skill frontmatter and code scan. Pure apart from the scrubber.
 */
export function checkProposalContent(
  kind: ProposalKind,
  rawPayload: unknown,
  text: { title: string; rationale?: string },
): ContentCheckResult {
  const schema = PROPOSAL_PAYLOAD_SCHEMAS[kind];
  const parsed = schema.safeParse(rawPayload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `invalid_payload: ${issue ? `${issue.path.join(".") || "payload"} ${issue.message}` : "schema"}` };
  }

  const flags = new Set<RiskFlag>();
  let invisible = false;
  let redactions = 0;
  const scrubber = getScrubber();
  const clean = (s: string): string => {
    const stripped = stripInvisibleChars(s);
    if (stripped !== s) invisible = true;
    const r = scrubber.scrubWithCount(stripped, { sink: "proposal" });
    redactions += r.count;
    return r.text;
  };

  const payload = mapStrings(parsed.data, clean) as Record<string, unknown>;
  const title = clean(text.title).replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  const rationale = clean(text.rationale ?? "").trim().slice(0, MAX_RATIONALE_CHARS);
  if (!title) return { ok: false, reason: "empty_title" };

  if (redactions > 0) flags.add("secret_redacted");

  const allText: string[] = [title, rationale];
  mapStrings(payload, (s) => { allText.push(s); return s; });
  if (invisible || allText.some(hasInjectionPattern)) flags.add("injection_pattern");

  const skill = skillMdOf(kind, payload);
  if (skill) {
    const fm = parseSkillFrontmatter(skill.md);
    if (!fm) return { ok: false, reason: "invalid_skill: frontmatter with name and description is required" };
    if (fm.name !== skill.expectedName) return { ok: false, reason: "invalid_skill: frontmatter name must equal the skill name" };
    if (fm.description.length < 1 || fm.description.length > 1024 || /[<>]/.test(fm.description)) {
      return { ok: false, reason: "invalid_skill: description must be 1 to 1024 characters without < or >" };
    }
    if (kind === "skill.create" && /[<>]/.test(String(payload.description))) {
      return { ok: false, reason: "invalid_skill: description must not contain < or >" };
    }
    const findings = fencedBlocks(skill.md).flatMap((b) => scanCode(b));
    if (findings.some((f) => f.severity === "block")) flags.add("scanner_block");
    else if (findings.some((f) => f.severity === "warn")) flags.add("scanner_warn");
  }

  if (JSON.stringify(payload).length > LARGE_PAYLOAD_CHARS) flags.add("large_payload");
  return { ok: true, payload, title, rationale, redactions, flags: [...flags] };
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface LearningIntakeConfig {
  maxPending: number;
  maxProposalsPerDay: number;
  rejectMemoryDays: number;
  expiryDays: number;
  allowUntrustedSkillProposals: boolean;
}

/** Daily cap for agent-filed proposals (R4 0.7 step 7). */
export const AGENT_TOOL_DAILY_CAP = 10;

export interface LearningIntakeDeps {
  store: ProposalStore;
  config: () => LearningIntakeConfig;
  audit?: LearningAuditSink;
  /** Project skills root (`<agentCwd>/.claude/skills`): create -> patch conversion and patch targets */
  skillsRoot?: string;
  skillState?: SkillStateStore;
  /** Current memory content by key, for baseHash, unchanged-content drop and the overwrite flag */
  memoryRecall?: (key: string) => { content: string } | null;
  now?: () => Date;
}

const DAY_MS = 86_400_000;

function readSkillMd(skillsRoot: string, name: string): string | null {
  const file = join(skillsRoot, name, "SKILL.md");
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

export class LearningIntake implements ProposalIntake {
  constructor(private readonly deps: LearningIntakeDeps) {}

  submit(input: ProposalSubmission): ProposalSubmitResult {
    try {
      return this.submitInner(input);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err), kind: input?.kind }, "proposal intake failed");
      return { dropped: "internal_error" };
    }
  }

  private drop(input: Partial<ProposalSubmission>, reason: string): { dropped: string } {
    this.deps.audit?.record({
      feature: "learning",
      action: "proposal.dropped",
      actor: input.origin === "agent_tool" && input.sourceSessionKey ? `agent:${input.sourceSessionKey}` : "system",
      detail: { kind: input.kind, origin: input.origin, reason },
    });
    return { dropped: reason };
  }

  private submitInner(input: ProposalSubmission): ProposalSubmitResult {
    if (!input || !isProposalKind(input.kind)) return this.drop(input ?? {}, "invalid_kind");
    if (!isProposalOrigin(input.origin)) return this.drop(input, "invalid_origin");
    if (!isProposalTrust(input.trust)) return this.drop(input, "invalid_trust");
    if (typeof input.title !== "string") return this.drop(input, "empty_title");

    const cfg = this.deps.config();
    const now = this.deps.now?.() ?? new Date();
    // Trust is code's decision: an agent tool cannot claim a trust level.
    const trust: ProposalTrust = input.origin === "agent_tool" ? "unverified" : input.trust;
    let kind: ProposalKind = input.kind;

    const checked = checkProposalContent(kind, input.payload, { title: input.title, rationale: input.rationale });
    if (!checked.ok) return this.drop(input, checked.reason);
    let payload = checked.payload;
    const flags = new Set<RiskFlag>(checked.flags);
    if (isLowTrust(trust)) flags.add("untrusted_source");

    if (isSkillContentKind(kind) && trust === "untrusted" && !cfg.allowUntrustedSkillProposals) {
      return this.drop(input, "untrusted_skill_proposal");
    }

    // Skill targets: create of an existing name becomes a patch; patch needs a target.
    const root = this.deps.skillsRoot;
    if (kind === "skill.create" && root) {
      const current = readSkillMd(root, String(payload.name));
      if (current !== null) {
        kind = "skill.patch";
        payload = { name: payload.name, baseHash: sha256Hex(current), newSkillMd: payload.skillMd };
      }
    }
    if ((kind === "skill.patch" || kind === "skill.fix") && root) {
      const current = readSkillMd(root, String(payload.name));
      if (current === null) return this.drop(input, "skill_missing");
      if (current === String(payload.newSkillMd)) return this.drop(input, "unchanged");
      flags.add("overwrites_existing");
    }
    if (kind.startsWith("skill.")) {
      const name = String(payload.name ?? payload.into ?? "");
      if (name && this.deps.skillState?.get("project", name)?.source === "bundled") flags.add("bundled_skill");
    }

    if (kind === "memory.upsert" && this.deps.memoryRecall) {
      const current = this.deps.memoryRecall(String(payload.key));
      if (current) {
        if (current.content === payload.content) return this.drop(input, "unchanged");
        if (payload.baseHash === undefined) payload = { ...payload, baseHash: sha256Hex(current.content) };
        flags.add("overwrites_existing");
      }
    }

    const hash = proposalPayloadHash(kind, payload);
    if (this.deps.store.hasPendingHash(hash)) return this.drop(input, "duplicate_pending");
    if (cfg.rejectMemoryDays > 0) {
      const since = new Date(now.getTime() - cfg.rejectMemoryDays * DAY_MS).toISOString();
      if (this.deps.store.wasRejectedSince(hash, since)) return this.drop(input, "previously_rejected");
    }

    if (input.origin !== "owner_command") {
      if (this.deps.store.countPending() >= cfg.maxPending) return this.drop(input, "pending_cap");
      const dayCap = input.origin === "reflection" ? cfg.maxProposalsPerDay : input.origin === "agent_tool" ? AGENT_TOOL_DAILY_CAP : null;
      if (dayCap !== null) {
        const since = new Date(now.getTime() - DAY_MS).toISOString();
        if (this.deps.store.countByOriginSince(input.origin, since) >= dayCap) return this.drop(input, "daily_cap");
      }
    }

    const createdAt = now.toISOString();
    const id = this.deps.store.insert({
      kind,
      title: checked.title,
      rationale: checked.rationale,
      payload,
      payloadHash: hash,
      origin: input.origin,
      trust,
      riskFlags: [...flags],
      redactions: checked.redactions,
      ...(input.sourceSessionKey ? { sourceSessionKey: input.sourceSessionKey.slice(0, 200) } : {}),
      ...(input.sourceMsgFrom !== undefined ? { sourceMsgFrom: input.sourceMsgFrom } : {}),
      ...(input.sourceMsgTo !== undefined ? { sourceMsgTo: input.sourceMsgTo } : {}),
      ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds.filter(Number.isInteger) } : {}),
      createdAt,
      expiresAt: new Date(now.getTime() + cfg.expiryDays * DAY_MS).toISOString(),
    });
    if (id === null) return this.drop(input, "duplicate_pending");

    this.deps.audit?.record({
      feature: "learning",
      action: "proposal.created",
      actor: input.origin === "agent_tool" && input.sourceSessionKey ? `agent:${input.sourceSessionKey}` : "system",
      detail: { id, kind, origin: input.origin, trust, flags: [...flags], hash8: payloadHash8(hash), redactions: checked.redactions },
    });
    return { id };
  }
}
