/**
 * The environment a Claude process is spawned with for one account (PLAN C.1).
 *
 * `Options.env` replaces the child's environment, so the lease env is a full
 * copy of the daemon's env. Every variable that could override the chosen
 * login is removed first: an inherited `CLAUDE_CONFIG_DIR` or API key would
 * silently win over the account Kirie picked.
 *
 * The default account is "CLAUDE_CONFIG_DIR unset". It is never represented
 * as `CLAUDE_CONFIG_DIR=~/.claude`: that selects a different Keychain item and
 * a different identity file, i.e. a different (wrong) login.
 */

/** Variables that select or override a Claude login. All are removed from a lease env. */
export const ACCOUNT_AUTH_OVERRIDES: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export type ClaudeAccountKind = "default" | "config_dir";

/** The part of an account that decides its environment. */
export interface AccountEnvSource {
  kind: ClaudeAccountKind;
  /** Exact absolute path, no trailing slash. Null for the default account. */
  configDir: string | null;
}

/**
 * Build the child environment for an account. The base object is not changed.
 * Values that are undefined in the base are dropped (the SDK wants strings).
 */
export function buildAccountEnv(
  account: AccountEnvSource,
  base: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const key of ACCOUNT_AUTH_OVERRIDES) delete env[key];
  if (account.kind === "config_dir") {
    if (!account.configDir) throw new Error("a config_dir account needs its directory");
    env.CLAUDE_CONFIG_DIR = account.configDir;
  }
  return env;
}

/**
 * Merge extra static variables over a lease env without letting them change
 * the login (the auth override keys are ignored).
 */
export function mergeStaticEnv(leaseEnv: Record<string, string>, extra: Record<string, string> | undefined): Record<string, string> {
  if (!extra) return leaseEnv;
  const out = { ...leaseEnv };
  for (const [key, value] of Object.entries(extra)) {
    if (!ACCOUNT_AUTH_OVERRIDES.includes(key)) out[key] = value;
  }
  return out;
}
