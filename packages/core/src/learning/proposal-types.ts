/**
 * Proposal kinds, payload schemas and hashing (PLAN B.7, R4 section 0.5).
 *
 * Every kind of the program is defined here, including the curator's
 * (W3-CUR) and the user model's (W3-UM), so intake can validate a payload in
 * either process before any handler is registered. The curator and user-model
 * payload objects are `passthrough`, so those workstreams can add fields
 * without editing this file.
 */

import { createHash } from "node:crypto";
import { z } from "zod/v3";

export type ProposalKind =
  | "memory.upsert" | "memory_md.append"
  | "skill.create" | "skill.patch" | "skill.fix" | "skill.archive" | "skill.merge" | "skill.adopt" | "skill.revert"
  | "user_fact.add";
export type ProposalOrigin = "reflection" | "agent_tool" | "curator" | "user_model" | "owner_command";
export type ProposalTrust = "owner" | "mixed" | "untrusted" | "unverified";
export type ProposalStatus =
  | "pending" | "applying" | "applied" | "rejected" | "expired" | "failed" | "superseded" | "undone";

export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  "memory.upsert", "memory_md.append",
  "skill.create", "skill.patch", "skill.fix", "skill.archive", "skill.merge", "skill.adopt", "skill.revert",
  "user_fact.add",
];
export const PROPOSAL_ORIGINS: readonly ProposalOrigin[] = ["reflection", "agent_tool", "curator", "user_model", "owner_command"];
export const PROPOSAL_TRUSTS: readonly ProposalTrust[] = ["owner", "mixed", "untrusted", "unverified"];

export type RiskFlag =
  | "secret_redacted" | "injection_pattern" | "scanner_block" | "scanner_warn" | "overwrites_existing"
  | "untrusted_source" | "large_payload" | "bundled_skill" | `possible_duplicate:${string}`;

// ---------------------------------------------------------------------------
// Size caps (R4 section 0.7)
// ---------------------------------------------------------------------------

export const MAX_TITLE_CHARS = 120;
export const MAX_RATIONALE_CHARS = 2000;
export const MAX_MEMORY_CONTENT_CHARS = 4000;
export const MAX_SKILL_MD_CHARS = 24_000;
export const MAX_MEMORY_MD_LINE_CHARS = 300;
/** Payloads above this many characters of JSON get the large_payload flag. */
export const LARGE_PAYLOAD_CHARS = 8000;

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const skillName = z.string().regex(SKILL_NAME_RE, "skill name must match ^[a-z0-9][a-z0-9-]{0,63}$");
const sha256 = z.string().regex(SHA256_HEX_RE, "expected a sha256 hex digest");
const memoryKey = z.string().min(1).max(200).regex(/^[^\s]+$/, "memory keys have no whitespace");
const tag = z.string().min(1).max(50);

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

export const MemoryMdAppendPayloadSchema = z.object({
  section: z.string().min(1).max(80),
  line: z.string().min(1).max(MAX_MEMORY_MD_LINE_CHARS),
}).strict();

export const MemoryUpsertPayloadSchema = z.object({
  key: memoryKey,
  content: z.string().min(1).max(MAX_MEMORY_CONTENT_CHARS),
  tags: z.array(tag).max(20).default([]),
  /** sha256 of the current content when the key existed at proposal time */
  baseHash: sha256.optional(),
  /** Also add a pointer line to MEMORY.md */
  pointer: MemoryMdAppendPayloadSchema.optional(),
}).strict();

export const SkillCreatePayloadSchema = z.object({
  name: skillName,
  description: z.string().min(1).max(1024),
  skillMd: z.string().min(1).max(MAX_SKILL_MD_CHARS),
}).strict();

export const SkillPatchPayloadSchema = z.object({
  name: skillName,
  /** sha256 of SKILL.md when the proposal was made */
  baseHash: sha256,
  newSkillMd: z.string().min(1).max(MAX_SKILL_MD_CHARS),
}).strict();

export const SkillFixPayloadSchema = SkillPatchPayloadSchema.extend({
  issue: z.string().min(1).max(500),
}).strict();

export const SkillArchivePayloadSchema = z.object({
  name: skillName,
  reason: z.string().min(1).max(500),
  evidence: z.object({
    lastUsedAt: z.string().optional(),
    useCount: z.number().int().min(0),
    detector: z.string().min(1).max(64),
  }).passthrough(),
}).passthrough();

export const SkillMergePayloadSchema = z.object({
  into: skillName,
  from: z.array(skillName).min(1).max(10),
  mergedSkillMd: z.string().min(1).max(MAX_SKILL_MD_CHARS),
  baseHashes: z.record(sha256),
}).passthrough();

export const SkillAdoptPayloadSchema = z.object({
  name: skillName,
  currentHash: sha256,
  approvedHash: sha256.nullable(),
}).passthrough();

export const SkillRevertPayloadSchema = SkillAdoptPayloadSchema;

export const UserFactAddPayloadSchema = z.object({
  category: z.string().min(1).max(32),
  statement: z.string().min(1).max(240),
  kind: z.enum(["explicit", "inferred"]),
  evidence: z.array(
    z.union([
      z.object({ t: z.literal("chat"), id: z.number().int(), ts: z.string().optional() }).passthrough(),
      z.object({ t: z.literal("memory"), key: z.string().min(1).max(200) }).passthrough(),
    ]),
  ).max(50),
}).passthrough();

export const PROPOSAL_PAYLOAD_SCHEMAS: Readonly<Record<ProposalKind, z.ZodTypeAny>> = {
  "memory.upsert": MemoryUpsertPayloadSchema,
  "memory_md.append": MemoryMdAppendPayloadSchema,
  "skill.create": SkillCreatePayloadSchema,
  "skill.patch": SkillPatchPayloadSchema,
  "skill.fix": SkillFixPayloadSchema,
  "skill.archive": SkillArchivePayloadSchema,
  "skill.merge": SkillMergePayloadSchema,
  "skill.adopt": SkillAdoptPayloadSchema,
  "skill.revert": SkillRevertPayloadSchema,
  "user_fact.add": UserFactAddPayloadSchema,
};

export type MemoryUpsertPayload = z.infer<typeof MemoryUpsertPayloadSchema>;
export type MemoryMdAppendPayload = z.infer<typeof MemoryMdAppendPayloadSchema>;
export type SkillCreatePayload = z.infer<typeof SkillCreatePayloadSchema>;
export type SkillPatchPayload = z.infer<typeof SkillPatchPayloadSchema>;
export type SkillFixPayload = z.infer<typeof SkillFixPayloadSchema>;

export function isProposalKind(value: unknown): value is ProposalKind {
  return typeof value === "string" && (PROPOSAL_KINDS as readonly string[]).includes(value);
}
export function isProposalOrigin(value: unknown): value is ProposalOrigin {
  return typeof value === "string" && (PROPOSAL_ORIGINS as readonly string[]).includes(value);
}
export function isProposalTrust(value: unknown): value is ProposalTrust {
  return typeof value === "string" && (PROPOSAL_TRUSTS as readonly string[]).includes(value);
}

/** Kinds that change a skill file and are dropped at intake when derived from untrusted content. */
export function isSkillContentKind(kind: ProposalKind): boolean {
  return kind === "skill.create" || kind === "skill.patch" || kind === "skill.fix" || kind === "skill.merge";
}

/** Untrusted and unverified are treated alike everywhere (R4 section 0.6). */
export function isLowTrust(trust: ProposalTrust): boolean {
  return trust === "untrusted" || trust === "unverified";
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with object keys sorted at every level; undefined members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256(kind + "\n" + canonical JSON of payload). */
export function proposalPayloadHash(kind: ProposalKind, payload: unknown): string {
  return sha256Hex(`${kind}\n${canonicalJson(payload)}`);
}

/** First 8 hex chars of the payload hash: bound into every card button. */
export function payloadHash8(payloadHash: string): string {
  return payloadHash.slice(0, 8);
}
