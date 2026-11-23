/**
 * Voice credentials: one rule (PLAN C.14).
 *
 * Every voice secret is resolved by `resolveVoiceSecret` from exactly two
 * approved places, in this order:
 *   1. ~/.kirie/secrets/voice.env (KEY=value lines). It must be a regular file
 *      owned by the current user with mode 0600 (no group or world bits);
 *      otherwise it is ignored and the reason is reported.
 *   2. The config value, which must be a `$credential:` reference into the
 *      encrypted credential store. The daemon's config loader replaces a
 *      resolvable reference with its value, so a config value is accepted
 *      only when it is still a reference (looked up now) or equal to a value
 *      held in the credential store. Plaintext in config.yaml is ignored.
 * The file wins when both define a name. Nothing else is read: no environment
 * variable, nothing in the repo.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";

export type VoiceSecretName =
  | "TWILIO_ACCOUNT_SID" | "TWILIO_AUTH_TOKEN" | "PLIVO_AUTH_ID" | "PLIVO_AUTH_TOKEN" | "VOICE_PIN";

export const VOICE_SECRET_NAMES: readonly VoiceSecretName[] = [
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "PLIVO_AUTH_ID", "PLIVO_AUTH_TOKEN", "VOICE_PIN",
];

/** The credential-store key documented for each secret (`pnpm cli credentials set <key>`). */
export const VOICE_SECRET_CREDENTIAL_KEYS: Readonly<Record<VoiceSecretName, string>> = {
  TWILIO_ACCOUNT_SID: "twilio.account_sid",
  TWILIO_AUTH_TOKEN: "twilio.auth_token",
  PLIVO_AUTH_ID: "plivo.auth_id",
  PLIVO_AUTH_TOKEN: "plivo.auth_token",
  VOICE_PIN: "voice.pin",
};

export interface VoiceEnvFile {
  status: "ok" | "absent" | "ignored";
  /** Why the file was ignored. Never contains a value. */
  reason?: string;
  values: ReadonlyMap<string, string>;
}

const CREDENTIAL_REF_RE = /^\$credential:(.+)$/;

/** Parse KEY=value lines: blank lines and # comments skipped, optional "export ", optional quotes. */
export function parseEnvLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (name && value) out.set(name, value);
  }
  return out;
}

/**
 * Read voice.env with the ownership and permission check. Never throws and
 * never returns a value from a file that fails the check.
 */
export function readVoiceEnvFile(path: string, opts: { uid?: number } = {}): VoiceEnvFile {
  const empty = new Map<string, string>();
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "absent", values: empty };
    return { status: "ignored", reason: `voice.env could not be read (${code ?? "error"})`, values: empty };
  }
  if (st.isSymbolicLink()) return { status: "ignored", reason: "voice.env is a symlink; use a regular file", values: empty };
  if (!st.isFile()) return { status: "ignored", reason: "voice.env is not a regular file", values: empty };
  const uid = opts.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const check = (s: { uid: number; mode: number }): string | null => {
    if (uid !== undefined && s.uid !== uid) return "voice.env is not owned by the user running Kirie";
    const mode = s.mode & 0o777;
    if ((mode & 0o077) !== 0) return `voice.env has mode ${mode.toString(8).padStart(4, "0")}; run chmod 600 on it`;
    return null;
  };
  const early = check(st);
  if (early) return { status: "ignored", reason: early, values: empty };
  // Open without following links and check the open file itself, so the file cannot be swapped
  // between the check and the read.
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile()) return { status: "ignored", reason: "voice.env is not a regular file", values: empty };
    const late = check(fst);
    if (late) return { status: "ignored", reason: late, values: empty };
    return { status: "ok", values: parseEnvLines(readFileSync(fd, "utf8")) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return { status: "ignored", reason: "voice.env is a symlink; use a regular file", values: empty };
    return { status: "ignored", reason: `voice.env could not be read (${code ?? "error"})`, values: empty };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The part of CredentialStore the resolver needs. */
export interface VoiceCredentialLookup {
  list(): string[];
  get(key: string): Promise<string | undefined>;
}

export interface VoiceSecretResolution {
  value?: string;
  source: "voice.env" | "credential-store" | "none";
  /** A configured value that was refused, and why. Never contains the value. */
  problem?: string;
}

async function storeHoldsValue(credentials: VoiceCredentialLookup, value: string): Promise<boolean> {
  for (const key of credentials.list()) {
    try {
      if ((await credentials.get(key)) === value) return true;
    } catch {
      // An unreadable entry cannot vouch for the value.
    }
  }
  return false;
}

/**
 * Resolve one voice secret. `configPath` names the config key for messages
 * ("voice.twilio.authToken"); `configValue` is the loaded config value.
 */
export async function resolveVoiceSecret(
  name: VoiceSecretName,
  sources: {
    envFile: VoiceEnvFile;
    configValue?: string;
    configPath: string;
    credentials?: VoiceCredentialLookup;
  },
): Promise<VoiceSecretResolution> {
  if (sources.envFile.status === "ok") {
    const fromFile = sources.envFile.values.get(name);
    if (fromFile) return { value: fromFile, source: "voice.env" };
  }
  const raw = sources.configValue?.trim();
  if (!raw) return { source: "none" };
  const credKey = VOICE_SECRET_CREDENTIAL_KEYS[name];
  const ref = CREDENTIAL_REF_RE.exec(raw);
  if (ref) {
    const value = sources.credentials ? await sources.credentials.get(ref[1]!).catch(() => undefined) : undefined;
    if (value) return { value, source: "credential-store" };
    return { source: "none", problem: `${sources.configPath} refers to credential "${ref[1]}", which is not in the credential store (pnpm cli credentials set ${credKey})` };
  }
  if (sources.credentials && (await storeHoldsValue(sources.credentials, raw))) {
    return { value: raw, source: "credential-store" };
  }
  return {
    source: "none",
    problem: `${sources.configPath} is plaintext in config.yaml and is ignored; use "$credential:${credKey}" or ~/.kirie/secrets/voice.env`,
  };
}
