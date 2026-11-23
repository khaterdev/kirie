/**
 * Sensitive-category filter for derived user facts (PLAN C.5, R4 item 5
 * "Security and privacy model").
 *
 * Code, not the model, decides what is sensitive: a statement that matches any
 * excluded category is never stored, whatever the model said. The model's own
 * `sensitive` flag is a second net (the deriver drops on either), and
 * `/profile show` plus `/profile forget` are the third.
 *
 * Keyword lists are English. Statements in other languages can slip past them;
 * that limit is stated in the handoff and the `/profile on` reply.
 */

import { getScrubber } from "../../security/secret-scrubber.js";

/** Every category the filter knows. Config `userModel.excludeCategories` selects which apply. */
export const USER_MODEL_SENSITIVE_CATEGORIES = [
  "health",
  "sexuality",
  "religion",
  "politics",
  "ethnicity",
  "legal_status",
  "finances",
  "government_id",
  "credentials",
  "home_address",
  "third_party_private",
] as const;

export type UserModelSensitiveCategory = (typeof USER_MODEL_SENSITIVE_CATEGORIES)[number];

/**
 * Always applied, whatever the config says: secrets and identity numbers are
 * never part of a profile.
 */
export const USER_MODEL_ALWAYS_EXCLUDED: readonly UserModelSensitiveCategory[] = ["credentials", "government_id"];

const RULES: Readonly<Record<UserModelSensitiveCategory, readonly RegExp[]>> = {
  // Health and medical, including mental health.
  health: [
    /\b(diagnos\w*|illness(es)?|diseases?|disorders?|symptoms?|medications?|medicines?|prescri(bed|ption)\w*|therap(y|ies|ist)|surger(y|ies)|hospital(ized|ised|isation|ization)?|clinic|pregnan\w*|allerg(y|ies|ic)|diabet\w*|cancer|asthma|adhd|autis(m|tic)|depress(ion|ed)|anxiety|bipolar|ptsd|psychiatr\w*|insomnia|migraines?|blood pressure|injur(y|ies|ed)|chronic pain|disabilit(y|ies)|disabled|vaccinat\w*|covid|infection|miscarriage|rehab|addict(ed|ion))\b/i,
    /\b(mental|physical) health\b/i,
    /\bhealth (condition|issue|problem|scare)s?\b/i,
    /\b(sees|seeing|saw|visits?) (a|his|her|their)? ?(doctor|therapist|psychologist|psychiatrist|dentist)\b/i,
    /\b(takes|taking|on) (anti\w+|insulin|meds)\b/i,
    /\b(on a diet|dieting|weight loss|los(es|ing|t) weight|gain(s|ed|ing)? weight|his weight|her weight|sober|sobriety|alcohol|(does ?n[o']?t|never) drinks?|drinks? alcohol|smok(es|ing|er))\b/i,
  ],
  // Sexuality and intimate relationships.
  sexuality: [
    /\b(sexual(ity|ly)?|sex life|gay|lesbian|bisexual|queer|transgender|heterosexual|homosexual|asexual|lgbt\w*|intimate|romantic(ally)?|dating|divorc\w*|affair|girlfriend|boyfriend|hook ?ups?|breakup|broke up|crush on)\b/i,
    /\b(married|marriage|wife|husband|spouse|fianc[ée]e?|engaged to|life partner|romantic partner|wedding|widow(ed|er)?)\b/i,
  ],
  religion: [
    /\b(religio(n|ns|us)|muslim|islam(ic)?|christian(ity|s)?|catholic|protestant|orthodox christian|jewish|judaism|hindu(ism)?|buddhis(m|t)|atheis(m|t)|church|mosque|synagogue|pray(s|ed|ing|ers?)?|ramadan|bible|qur'?an|koran|torah|god|fasts|fasting|halal|kosher|hajj|sabbath|shabbat)\b/i,
  ],
  // Political views.
  politics: [
    /\b(politic(s|al|ally)|democrat(s|ic)?|republican(s)?|leftist|right-wing|left-wing|socialis(m|t)|communis(m|t)|fascis(m|t)|libertarian|partisan|activist)\b/i,
    /\b(conservative|liberal|progressive|labour|labor) (party|politics|views?|voters?|candidates?)\b/i,
    /\b(votes?|voted|voting) (for|against)\b/i,
    /\b(general|presidential|parliamentary|local|midterm) elections?\b/i,
    /\bpolitical (views?|opinions?|leanings?|party)\b/i,
  ],
  ethnicity: [
    /\b(ethnicity|ethnic|racial|race and|ancestry)\b/i,
    /\bof [a-z]+ (descent|heritage|ancestry)\b/i,
  ],
  // Immigration and legal status, criminal history.
  legal_status: [
    /\b(immigra(nt|tion)|visas?|asylum|refugee|residen(cy|ce) permit|work permit|green card|citizenship|naturali[sz](ed|ation)|deport\w*|undocumented|criminal record|arrest(ed)?|convict(ed|ion)|prison|jail|probation|parole|felon(y|ies)?|lawsuit|sued|court (case|hearing|date)|on trial)\b/i,
  ],
  // Precise finances.
  finances: [
    /\b(salary|salaries|income|earns?|earned|earning|net worth|bank (account|balance|details)|account balance|debts?|loans?|mortgage|credit (card|score)|debit card|iban|swift code|account number|card number|savings|owes|tax(es| return)|pension|inheritance|bankrupt\w*|invest(ed|s|ment|ments) in)\b/i,
    /[$€£¥]\s?\d[\d,.]*\s?(k|m|thousand|million)?\b.*\b(salary|income|savings|debt|loan|rent|month|year)\b/i,
    /\b(saving (up )?for|pays? (the )?rent|rent is|(can ?not|can't|cannot) afford|in debt|paycheck|bonus of|crypto (holdings|portfolio)|stock portfolio)\b/i,
  ],
  government_id: [
    /\b(passport(?!\.)|national id|id card|identity card|social security|ssn|driver'?s licen[cs]e|driving licen[cs]e|tax id|taxpayer id|national insurance number)\b/i,
  ],
  credentials: [
    /\b(passwords?|passcodes?|passphrases?|seed phrase|recovery (code|phrase|key)s?|2fa|otp|one-time code|security questions?)\b/i,
    /\b(api|access|auth|bearer|bot|refresh|session) tokens?\b/i,
    /\b(api|secret|private|ssh|gpg|pgp|licen[cs]e) keys?\b/i,
    /\bpin (code|number|is)\b/i,
    /\blogin (credentials|details)\b/i,
  ],
  // Exact home address and live location (a city or country is fine).
  home_address: [
    /\b(home address|street address|lives at|address is|postal code|post ?code|zip ?code|current location|live location|location is|is currently (at|in room)|apartment \d|flat \d|floor \d)\b/i,
    /\b\d{1,5}\s+[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z][A-Za-z'.-]*)?\s+(street|st\.|road|rd\.|avenue|ave\.?|lane|boulevard|blvd|drive|square|sq\.)\b/i,
    /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/,
  ],
  // Private details of other people and contact details of anyone.
  third_party_private: [
    /\b(his|her|their)\s+(phone|number|e-?mail|address|salary|health|medical|diagnosis|password|bank|debts?|religion|sexuality)\b/i,
    /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
  ],
};

/** A phone number has 9 or more digits in a run of digits, spaces, dots, dashes and brackets, and is not a date or version. */
function containsPhoneNumber(text: string): boolean {
  const runs = text.match(/\+?\(?\d[\d\s().-]{7,}\d/g);
  if (!runs) return false;
  for (const run of runs) {
    const digits = run.replace(/\D/g, "");
    if (digits.length < 9) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(run.trim())) continue;
    return true;
  }
  return false;
}

function isKnownCategory(value: string): value is UserModelSensitiveCategory {
  return (USER_MODEL_SENSITIVE_CATEGORIES as readonly string[]).includes(value);
}

/** The categories in force: the configured list (unknown names ignored) plus the always-excluded ones. */
export function userModelExcludedCategories(configured: readonly string[]): UserModelSensitiveCategory[] {
  const out = new Set<UserModelSensitiveCategory>(USER_MODEL_ALWAYS_EXCLUDED);
  for (const c of configured) if (isKnownCategory(c)) out.add(c);
  return USER_MODEL_SENSITIVE_CATEGORIES.filter((c) => out.has(c));
}

/**
 * The first excluded category the statement falls into, or null. Secrets the
 * scrubber recognises count as credentials, and any phone number counts as
 * third-party contact data.
 */
export function detectUserModelSensitive(
  statement: string,
  excluded: readonly UserModelSensitiveCategory[] = USER_MODEL_SENSITIVE_CATEGORIES,
): UserModelSensitiveCategory | null {
  const active = new Set<UserModelSensitiveCategory>([...excluded, ...USER_MODEL_ALWAYS_EXCLUDED]);
  for (const category of USER_MODEL_SENSITIVE_CATEGORIES) {
    if (!active.has(category)) continue;
    if (RULES[category].some((re) => re.test(statement))) return category;
    if (category === "credentials" && getScrubber().detect(statement).length > 0) return category;
    if (category === "third_party_private" && containsPhoneNumber(statement)) return category;
  }
  return null;
}

export function isUserModelSensitive(
  statement: string,
  excluded: readonly UserModelSensitiveCategory[] = USER_MODEL_SENSITIVE_CATEGORIES,
): boolean {
  return detectUserModelSensitive(statement, excluded) !== null;
}
