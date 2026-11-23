/**
 * Code-side checks every fact statement passes before it is stored, whether it
 * comes from the deriver, an approved `user_fact.add` proposal or
 * `/profile add` (PLAN C.5, R4 item 5 step 7).
 */

import { scrubSecretsWithCount } from "../../security/secret-scrubber.js";
import { hasInjectionPattern } from "../intake.js";
import {
  USER_FACT_MAX_STATEMENT_CHARS,
  normalizeUserFactStatement,
  userFactStatementHash,
  type UserFactCategory,
  type UserFactKind,
} from "./fact-store.js";
import { detectUserModelSensitive, type UserModelSensitiveCategory } from "./sensitive.js";

/** Confidence is assigned here, by code. A model's confidence is never read. */
export const USER_MODEL_CONFIDENCE = {
  explicit: 0.7,
  inferred: 0.4,
  contradictExplicit: 0.6,
  /**
   * A derived explicit rule ("Never wants emojis") starts below the card
   * threshold: a single message, which may be forwarded or pasted text, cannot
   * put a standing rule into the prompt; a confirmation on another day can.
   */
  derivedRule: 0.5,
  perNewDay: 0.1,
  max: 0.95,
  owner: 0.9,
} as const;

/** Phrased as an order to the assistant rather than a description of the owner. */
const INSTRUCTION_START_RE =
  /^(always|never|you|your|do not|don't|dont|ignore|disregard|forget|remember to|from now on|make sure|be sure|please|must|reply|respond|answer|call|run|send|execute|tell|stop|delete|install|approve)\b/i;
const ADDRESSES_ASSISTANT_RE = /\b(you|your|the assistant|the agent|the bot|kirie|claude)\b[^.]{0,40}\b(must|should|shall|have to|has to|need to|needs to|are to|is to)\b/i;

/** Categories where an explicit owner statement may be phrased as a rule ("Never wants emojis"). */
export const USER_MODEL_RULE_CATEGORIES: ReadonlySet<UserFactCategory> = new Set(["preference", "communication", "constraint"]);

/** Links, addresses and code have no place in a derived description of the owner. */
const PAYLOAD_SHAPED_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|dev|ai|app|me|co|xyz|ly|sh)\b|`|\$\(|\b(curl|wget|sudo|rm -|chmod|eval)\b)/i;

/** "derived": proposed by the deriver from messages. "owner": typed by the owner with /profile add. */
export type UserFactOrigin = "derived" | "owner";

export type UserFactCheckResult =
  | { ok: true; statement: string; hash: string }
  | { ok: false; reason: "empty" | "too_long" | "secret" | `sensitive:${UserModelSensitiveCategory}` | "injection" | "instruction" | "link_or_code" };

export function isInstructionShapedStatement(statement: string, category: UserFactCategory, kind: UserFactKind, origin: UserFactOrigin = "derived"): boolean {
  // Words aimed at the assistant ("you must ...") are refused in derived facts whatever the category.
  if (origin === "derived" && ADDRESSES_ASSISTANT_RE.test(statement)) return true;
  if (kind === "explicit" && USER_MODEL_RULE_CATEGORIES.has(category)) return false;
  return INSTRUCTION_START_RE.test(statement) || ADDRESSES_ASSISTANT_RE.test(statement);
}

/**
 * Normalise, then refuse: empty, longer than 240 characters, containing a
 * secret (a scrubber redaction inside the statement), in an excluded
 * sensitive category, matching a prompt-injection pattern, phrased as an
 * instruction to the assistant, or (derived only) carrying a link or code.
 */
export function checkUserFactStatement(
  raw: string,
  category: UserFactCategory,
  kind: UserFactKind,
  excluded: readonly UserModelSensitiveCategory[],
  origin: UserFactOrigin = "derived",
): UserFactCheckResult {
  const statement = normalizeUserFactStatement(raw);
  if (!statement) return { ok: false, reason: "empty" };
  if (statement.length > USER_FACT_MAX_STATEMENT_CHARS) return { ok: false, reason: "too_long" };
  if (scrubSecretsWithCount(statement, { sink: "memory" }).count > 0) return { ok: false, reason: "secret" };
  const sensitive = detectUserModelSensitive(statement, excluded);
  if (sensitive) return { ok: false, reason: `sensitive:${sensitive}` };
  if (hasInjectionPattern(statement)) return { ok: false, reason: "injection" };
  if (origin === "derived" && PAYLOAD_SHAPED_RE.test(statement)) return { ok: false, reason: "link_or_code" };
  if (isInstructionShapedStatement(statement, category, kind, origin)) return { ok: false, reason: "instruction" };
  return { ok: true, statement, hash: userFactStatementHash(statement) };
}

/** Tombstone match: same hash, or cosine of 0.88 or more with a forgotten statement. */
export const USER_MODEL_TOMBSTONE_COSINE = 0.88;
/** Duplicate of an active fact in the same category: cosine of 0.90 or more. */
export const USER_MODEL_DUPLICATE_COSINE = 0.9;
/** Consolidation merges active facts of one category at 0.93 or more. */
export const USER_MODEL_MERGE_COSINE = 0.93;
