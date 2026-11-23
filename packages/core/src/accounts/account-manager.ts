/**
 * AccountManager (PLAN C.1): the single writer of account state.
 *
 * Selection is fill-first by priority with a sticky active account: Kirie stays
 * on it until it is limited, signed out, disabled, or the owner switches.
 * With zero imported (or zero enabled) accounts everything is inert:
 * `acquire()` returns `{ accountId: null, env: undefined }` and every call
 * site spawns exactly as before the feature existed.
 *
 * An account takes part only after the owner imports it. Rotation away from a
 * limited or signed-out account happens only when rotation is on. Benches are
 * absolute epoch times in SQLite, re-checked lazily, so they survive restarts
 * and no timer can leak.
 *
 * Identity pin: before an account's first use after start, and at most every
 * 10 minutes, the account uuid in its identity file is read again. A different
 * uuid (or no login at all) puts the account in `auth_error` and it is not used.
 */

import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModuleLogger } from "../logging/logger.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { AccountsConfig } from "../config/sections/accounts.js";
import type { FailureInfo } from "../engine/failure.js";
import type {
  AccountAcquireResult,
  ResilienceAccountSource,
  TranscriptCarry,
} from "../engine/resilience.js";
import { buildAccountEnv } from "./account-env.js";
import {
  ACCOUNT_ID_RE,
  type AccountStore,
  type ClaudeAccount,
} from "./account-store.js";
import {
  AccountPathError,
  accountDataDir,
  carryTranscript,
  checkLogin,
  discoverConfigDirs,
  identityFilePath,
  normalizeConfigDirPath,
  readAccountIdentity,
  suggestedAccountId,
  validateConfigDir,
  type DiscoveredConfigDir,
  type IdentityReadResult,
  type LoginCheck,
  type SecurityRunner,
} from "./config-dir.js";
import type { AccountVerifier, AccountVerifyResult } from "./account-verify.js";

const log = createModuleLogger("accounts");

/** Re-read the identity file at most this often per account. */
export const IDENTITY_RECHECK_MS = 10 * 60_000;
/** A weekly limit with no parseable reset is benched this long. */
export const WEEKLY_LIMIT_DEFAULT_MS = 24 * 60 * 60_000;
/** A bench never ends sooner than this. */
const MIN_BENCH_MS = 60_000;
const MESSAGE_MAX = 200;

export type AccountRotationCause = "limit" | "auth" | "model_limit" | "disabled" | "primary";

export interface AccountRotatedEvent {
  from: string | null;
  to: string;
  cause: AccountRotationCause;
  /** Reset time of the account rotated away from, when known */
  fromResetAtMs?: number;
  fromLimitType?: string;
}

export interface AccountAuthErrorEvent {
  accountId: string;
  reason: "auth" | "identity_changed" | "not_logged_in";
}

export interface AccountsExhaustedEvent {
  earliest: { accountId: string; atMs: number } | null;
}

export interface AccountManagerEvents {
  rotated: [AccountRotatedEvent];
  exhausted: [AccountsExhaustedEvent];
  auth_error: [AccountAuthErrorEvent];
  recovered: [{ accountId: string }];
  limited: [{ accountId: string; untilMs: number; limitType?: string }];
}

export class AccountImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountImportError";
  }
}

export interface AccountImportOutcome {
  account: ClaudeAccount;
  /** Undefined when verification did not run */
  verify?: AccountVerifyResult;
  login: LoginCheck;
  becameActive: boolean;
}

export interface DiscoveredAccountDir extends DiscoveredConfigDir {
  /** Id of the imported account for this dir, if any */
  importedAs: string | null;
}

/** What an account looks like to commands and tools. */
export interface AccountView {
  id: string;
  kind: ClaudeAccount["kind"];
  configDir: string | null;
  label: string | null;
  subscription: string | null;
  enabled: boolean;
  priority: number;
  status: ClaudeAccount["status"];
  limitedUntil: number | null;
  limitType: string | null;
  lastError: string | null;
  active: boolean;
  usable: boolean;
}

export interface AccountManagerOptions {
  store: AccountStore;
  /** Live accounts config */
  config: () => AccountsConfig;
  /** Effective rotation switch (runtime override ?? config) */
  rotationEnabled: () => boolean;
  home?: string;
  now?: () => number;
  /** Env the lease env is built from (default: process.env) */
  baseEnv?: () => NodeJS.ProcessEnv;
  /** Scrubs stored error text */
  scrub?: (text: string) => string;
  audit?: Pick<AuditTrail, "record">;
  verify?: AccountVerifier;
  readIdentity?: (file: string) => IdentityReadResult;
  runSecurity?: SecurityRunner;
  platform?: NodeJS.Platform;
}

function cap(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_MAX ? `${flat.slice(0, MESSAGE_MAX - 3)}...` : flat;
}

export class AccountManager implements ResilienceAccountSource {
  private readonly store: AccountStore;
  private readonly opts: AccountManagerOptions;
  private readonly now: () => number;
  private readonly home: string;
  private readonly events = new EventEmitter();
  private readonly identityCheckedAt = new Map<string, number>();
  private exhaustedNotified = false;

  constructor(opts: AccountManagerOptions) {
    this.store = opts.store;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.home = opts.home ?? homedir();
  }

  on<E extends keyof AccountManagerEvents>(event: E, listener: (...args: AccountManagerEvents[E]) => void): () => void {
    const fn = listener as (...args: unknown[]) => void;
    this.events.on(event, fn);
    return () => this.events.off(event, fn);
  }

  private emit<E extends keyof AccountManagerEvents>(event: E, ...args: AccountManagerEvents[E]): void {
    for (const listener of this.events.listeners(event)) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        log.error({ event, err: err instanceof Error ? err.message : String(err) }, "account event listener threw");
      }
    }
  }

  private scrub(text: string): string {
    const s = this.opts.scrub ? this.opts.scrub(text) : text;
    return cap(s);
  }

  private record(action: string, actor: string, detail?: Record<string, unknown>): void {
    this.opts.audit?.record({ feature: "accounts", action, actor, ...(detail ? { detail } : {}) });
  }

  // ── ResilienceAccountSource ───────────────────────────────────────────────

  hasAccounts(): boolean {
    return this.enabledCount() > 0;
  }

  enabledCount(): number {
    return this.store.list().filter((a) => a.enabled).length;
  }

  rotationEnabled(): boolean {
    return this.opts.rotationEnabled();
  }

  maxRotationsPerTurn(): number {
    return this.opts.config().rotation.maxRotationsPerTurn;
  }

  carrySession(): boolean {
    return this.opts.config().rotation.carrySession;
  }

  acquire(opts: { exclude?: ReadonlySet<string>; accept?: (accountId: string) => boolean } = {}): AccountAcquireResult {
    const now = this.now();
    this.recoverExpired(now);
    const enabled = this.store.list().filter((a) => a.enabled);
    if (enabled.length === 0) return { accountId: null, env: undefined, exhausted: false };

    const exclude = opts.exclude;
    const isExcluded = (a: ClaudeAccount): boolean => exclude?.has(a.id) ?? false;
    const accepted = (a: ClaudeAccount): boolean => opts.accept?.(a.id) ?? true;
    const usable = (a: ClaudeAccount): boolean => !isExcluded(a) && accepted(a) && a.status === "ok" && this.identityOk(a);
    const firstUsable = (): ClaudeAccount | undefined => enabled.find((a) => usable(this.store.get(a.id) ?? a));

    const activeId = this.store.getActiveId();
    const active = enabled.find((a) => a.id === activeId);

    if (active && !isExcluded(active) && accepted(active)) {
      if (this.opts.config().rotation.returnToPrimary && this.rotationEnabled()) {
        const primary = firstUsable();
        if (primary && primary.id !== active.id && primary.priority < active.priority) {
          return this.switchTo(active, primary, "primary");
        }
      }
      if (usable(active)) return this.lease(active);
    }

    const current = active ? this.store.get(active.id) ?? active : undefined;
    // The active account is gone or disabled: that is not a rotation decision.
    const mayMove = !current || isExcluded(current) || !accepted(current) || this.rotationEnabled();
    if (mayMove) {
      const next = firstUsable();
      if (next) {
        const cause: AccountRotationCause = !current
          ? "disabled"
          : (isExcluded(current) || !accepted(current)) && current.status === "ok"
            ? "model_limit"
            : current.status === "auth_error"
              ? "auth"
              : "limit";
        return this.switchTo(current ?? null, next, cause);
      }
    }

    // Nothing usable. A limited account may still be tried (its reset may be a
    // guess); a signed-out account, or one whose login changed, never is.
    const earliest = this.earliestReset();
    if (!this.exhaustedNotified && this.rotationEnabled()) {
      this.exhaustedNotified = true;
      this.emit("exhausted", { earliest });
    }
    const fallback = this.limitedFallback(current, enabled);
    if (!fallback) {
      return { accountId: null, env: undefined, exhausted: true, blocked: true, ...(earliest ? { earliestResetAt: earliest.atMs } : {}) };
    }
    return {
      accountId: fallback.id,
      env: buildAccountEnv(fallback, this.baseEnv()),
      exhausted: true,
      ...(earliest ? { earliestResetAt: earliest.atMs } : {}),
    };
  }

  reportFailure(accountId: string, failure: FailureInfo): void {
    if (failure.class === "auth") this.reportAuthError(accountId, failure.message);
    else if (failure.class === "usage_limit_account") this.reportLimit(accountId, failure);
  }

  reportSuccess(accountId: string): void {
    if (!this.store.get(accountId)) return;
    this.store.update(accountId, { lastUsedAt: this.now() });
    this.exhaustedNotified = false;
  }

  carryTranscript(from: string | null, to: string | null, sdkSessionId: string): TranscriptCarry {
    const fromDir = this.dataDirOf(from);
    const toDir = this.dataDirOf(to);
    if (!fromDir || !toDir) return "failed";
    const res = carryTranscript(fromDir, toDir, sdkSessionId);
    if (res.status === "same" || res.status === "copied") return res.status;
    log.warn({ from, to, status: res.status, detail: res.detail }, "could not carry the transcript; the session starts fresh");
    return "failed";
  }

  // ── Limits and auth ───────────────────────────────────────────────────────

  /** Bench an account until its reset time (or the default cooldown). Idempotent. */
  reportLimit(accountId: string, failure: Pick<FailureInfo, "message" | "resetAtMs" | "limitType">): void {
    const acc = this.store.get(accountId);
    if (!acc) return;
    const now = this.now();
    const weekly = (failure.limitType?.startsWith("seven_day") ?? false) || /weekly/i.test(failure.message);
    const fallbackMs = weekly ? WEEKLY_LIMIT_DEFAULT_MS : this.opts.config().rotation.defaultCooldownMinutes * 60_000;
    const until = Math.max(failure.resetAtMs ?? now + fallbackMs, now + MIN_BENCH_MS);
    if (acc.status === "limited" && (acc.limitedUntil ?? 0) >= until) return;
    if (acc.status === "auth_error") return;
    this.store.update(accountId, {
      status: "limited",
      limitedUntil: until,
      limitType: failure.limitType ?? null,
      limitMessage: this.scrub(failure.message),
      lastErrorAt: now,
    });
    this.record("limited", "system", { account: accountId, until: new Date(until).toISOString(), limitType: failure.limitType ?? "unknown" });
    log.warn({ accountId, until: new Date(until).toISOString(), limitType: failure.limitType }, "account benched after a usage limit");
    this.emit("limited", { accountId, untilMs: until, ...(failure.limitType ? { limitType: failure.limitType } : {}) });
  }

  /** Signed out or blocked: no timer; cleared by reset or a passing test. */
  reportAuthError(accountId: string, message: string, reason: AccountAuthErrorEvent["reason"] = "auth"): void {
    const acc = this.store.get(accountId);
    if (!acc || acc.status === "auth_error") return;
    this.store.update(accountId, { status: "auth_error", lastError: this.scrub(message), lastErrorAt: this.now() });
    this.record("auth_error", "system", { account: accountId, reason });
    log.warn({ accountId, reason }, "account marked auth_error");
    this.emit("auth_error", { accountId, reason });
  }

  /** Earliest reset among limited enabled accounts. */
  earliestReset(): { accountId: string; atMs: number } | null {
    let best: { accountId: string; atMs: number } | null = null;
    for (const a of this.store.list()) {
      if (!a.enabled || a.status !== "limited" || a.limitedUntil === null) continue;
      if (!best || a.limitedUntil < best.atMs) best = { accountId: a.id, atMs: a.limitedUntil };
    }
    return best;
  }

  // ── Owner and agent operations ────────────────────────────────────────────

  list(): AccountView[] {
    const now = this.now();
    this.recoverExpired(now);
    const activeId = this.activeAccountId();
    return this.store.list().map((a) => ({
      id: a.id,
      kind: a.kind,
      configDir: a.configDir,
      label: a.label,
      subscription: a.subscription,
      enabled: a.enabled,
      priority: a.priority,
      status: a.status,
      limitedUntil: a.limitedUntil,
      limitType: a.limitType,
      lastError: a.lastError,
      active: a.id === activeId,
      usable: a.enabled && a.status === "ok",
    }));
  }

  get(id: string): ClaudeAccount | null {
    return this.store.get(id);
  }

  /** The stored active id, when it names an existing account. */
  activeAccountId(): string | null {
    const id = this.store.getActiveId();
    return id && this.store.get(id) ? id : null;
  }

  /** Make an account active from the next turn. Clears its limit (an explicit override). */
  use(id: string, actor: string): { account: ClaudeAccount; clearedLimit: boolean } {
    const acc = this.requireAccount(id);
    if (!acc.enabled) throw new AccountImportError(`account ${id} is disabled; enable it first`);
    const clearedLimit = acc.status !== "ok";
    if (clearedLimit) {
      this.store.update(id, { status: "ok", limitedUntil: null, limitType: null, limitMessage: null, lastError: null });
      this.identityCheckedAt.delete(id);
    }
    const from = this.store.getActiveId();
    this.store.setActiveId(id);
    this.record("use", actor, { account: id, from, clearedLimit });
    return { account: this.store.get(id)!, clearedLimit };
  }

  setEnabled(id: string, enabled: boolean, actor: string): ClaudeAccount {
    this.requireAccount(id);
    const updated = this.store.update(id, { enabled })!;
    this.record(enabled ? "enabled" : "disabled", actor, { account: id });
    return updated;
  }

  /** Clear a limit or auth error (one account or all). Also clears that account's model benches. */
  reset(id: string | "all", actor: string): string[] {
    const targets = id === "all" ? this.store.list() : [this.requireAccount(id)];
    for (const acc of targets) {
      this.store.update(acc.id, { status: "ok", limitedUntil: null, limitType: null, limitMessage: null, lastError: null });
      this.store.clearModelLimits(acc.id);
      this.identityCheckedAt.delete(acc.id);
    }
    this.exhaustedNotified = false;
    const ids = targets.map((a) => a.id);
    this.record("reset", actor, { accounts: ids });
    return ids;
  }

  /** Forget an account. The config dir itself is never touched. */
  remove(id: string, actor: string): void {
    this.requireAccount(id);
    this.store.remove(id);
    this.identityCheckedAt.delete(id);
    if (this.store.getActiveId() === id) {
      const next = this.store.list().find((a) => a.enabled) ?? null;
      this.store.setActiveId(next?.id ?? null);
    }
    this.record("removed", actor, { account: id });
  }

  /** `~/.claude` and `~/.claude<N>`, with their state and whether they are imported. Spawns nothing. */
  discover(): DiscoveredAccountDir[] {
    const accounts = this.store.list();
    return discoverConfigDirs({ home: this.home, platform: this.opts.platform, runSecurity: this.opts.runSecurity }).map((d) => {
      const byPath = accounts.find((a) => (d.kind === "default" ? a.kind === "default" : a.configDir === d.path));
      const uuid = d.identity.ok ? d.identity.identity.accountUuid : null;
      const byUuid = uuid ? accounts.find((a) => a.accountUuid === uuid) : undefined;
      return { ...d, importedAs: (byPath ?? byUuid)?.id ?? null };
    });
  }

  /**
   * Import a config dir (R1 "Import"). `onlyDiscovered` limits it to the dirs
   * `discover()` returns (the agent's path). Verification failure imports the
   * account disabled with `auth_error`, and says so.
   */
  async importDir(
    input: string,
    opts: { id?: string; actor: string; verify?: boolean; onlyDiscovered?: boolean },
  ): Promise<AccountImportOutcome> {
    let validated;
    try {
      validated = validateConfigDir(input, { home: this.home, importRoots: this.opts.config().importRoots });
    } catch (err) {
      if (err instanceof AccountPathError) throw new AccountImportError(err.message);
      throw err;
    }
    if (opts.onlyDiscovered) {
      const found = this.discover().some((d) => d.path === validated.path);
      if (!found) throw new AccountImportError("only a directory listed by discover can be imported this way");
    }

    const read = (this.opts.readIdentity ?? readAccountIdentity)(validated.identityFile);
    if (!read.ok) {
      throw new AccountImportError(
        read.reason === "unreadable" ? "the identity file could not be read; try again" : "not logged in (no account in its .claude.json)",
      );
    }
    const identity = read.identity;
    const dupUuid = this.store.findByUuid(identity.accountUuid);
    if (dupUuid) throw new AccountImportError(`this Claude account is already imported as ${dupUuid.id}`);
    const dupPath = this.store.list().find((a) =>
      validated.kind === "default" ? a.kind === "default" : a.configDir === validated.configDir,
    );
    if (dupPath) throw new AccountImportError(`this directory is already imported as ${dupPath.id}`);

    const id = this.pickId(opts.id, validated.path, validated.kind);
    const login = checkLogin(validated.configDir, { home: this.home, platform: this.opts.platform, runSecurity: this.opts.runSecurity });

    let enabled = true;
    let status: ClaudeAccount["status"] = "ok";
    let lastError: string | null = null;
    let subscription: string | null = identity.organizationType ?? null;
    let verify: AccountVerifyResult | undefined;
    const shouldVerify = opts.verify ?? this.opts.config().verifyOnImport;
    if (shouldVerify && this.opts.verify) {
      verify = await this.opts.verify({ kind: validated.kind, configDir: validated.configDir });
      if (verify.ok) {
        subscription = verify.subscription ?? subscription;
      } else {
        enabled = false;
        status = "auth_error";
        lastError = verify.reason === "timeout" ? "login not readable from the daemon" : "not logged in";
      }
    } else if (login === "not_found") {
      enabled = false;
      status = "auth_error";
      lastError = "no saved login found";
    }

    const account = this.store.insert({
      id,
      kind: validated.kind,
      configDir: validated.configDir,
      accountUuid: identity.accountUuid,
      label: identity.label,
      subscription,
      enabled,
      priority: this.store.maxPriority() + 10,
      status,
      limitedUntil: null,
      limitType: null,
      limitMessage: null,
      lastUsedAt: null,
      lastErrorAt: lastError ? this.now() : null,
      lastError,
    });
    this.identityCheckedAt.set(id, this.now());
    let becameActive = false;
    if (!this.activeAccountId()) {
      this.store.setActiveId(id);
      becameActive = true;
    }
    this.record("imported", opts.actor, {
      account: id,
      kind: validated.kind,
      enabled,
      verified: verify ? verify.ok : null,
      ...(verify && !verify.ok ? { reason: verify.reason } : {}),
    });
    return { account, ...(verify ? { verify } : {}), login, becameActive };
  }

  /** Login check plus the zero-quota verify. A pass clears an auth error. */
  async test(id: string, actor: string): Promise<{ login: LoginCheck; verify?: AccountVerifyResult; identity: IdentityReadResult }> {
    const acc = this.requireAccount(id);
    const identity = (this.opts.readIdentity ?? readAccountIdentity)(identityFilePath(acc.configDir, this.home));
    const login = checkLogin(acc.configDir, { home: this.home, platform: this.opts.platform, runSecurity: this.opts.runSecurity });
    const sameIdentity = identity.ok && (!acc.accountUuid || identity.identity.accountUuid === acc.accountUuid);
    let verify: AccountVerifyResult | undefined;
    if (this.opts.verify) verify = await this.opts.verify({ kind: acc.kind, configDir: acc.configDir });
    if (sameIdentity && verify?.ok && acc.status === "auth_error") {
      this.store.update(id, { status: "ok", lastError: null, ...(verify.subscription ? { subscription: verify.subscription } : {}) });
      this.identityCheckedAt.set(id, this.now());
    }
    this.record("tested", actor, { account: id, login, verified: verify ? verify.ok : null, sameIdentity });
    return { login, ...(verify ? { verify } : {}), identity };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private requireAccount(id: string): ClaudeAccount {
    const acc = this.store.get(id);
    if (!acc) throw new AccountImportError(`no account named ${id}`);
    return acc;
  }

  private pickId(requested: string | undefined, path: string, kind: ClaudeAccount["kind"]): string {
    if (requested !== undefined) {
      if (!ACCOUNT_ID_RE.test(requested)) throw new AccountImportError("account ids are 1 to 32 lower-case letters, digits or dashes");
      if (requested === "all") throw new AccountImportError('"all" is reserved');
      if (this.store.get(requested)) throw new AccountImportError(`the id ${requested} is taken`);
      return requested;
    }
    const base = suggestedAccountId(path, kind);
    if (!this.store.get(base)) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base.slice(0, 28)}-${n}`;
      if (!this.store.get(candidate)) return candidate;
    }
    throw new AccountImportError("could not choose an id; pass one with /accounts add <id> <dir>");
  }

  private baseEnv(): NodeJS.ProcessEnv {
    return this.opts.baseEnv?.() ?? process.env;
  }

  private lease(acc: ClaudeAccount): AccountAcquireResult {
    this.exhaustedNotified = false;
    return { accountId: acc.id, env: buildAccountEnv(acc, this.baseEnv()), exhausted: false };
  }

  private switchTo(from: ClaudeAccount | null, to: ClaudeAccount, cause: AccountRotationCause): AccountAcquireResult {
    // Persist the new active account before any process is closed (unlock-chat lesson 3).
    this.store.setActiveId(to.id);
    this.record("rotated", "system", { from: from?.id ?? null, to: to.id, cause });
    log.info({ from: from?.id ?? null, to: to.id, cause }, "active Claude account changed");
    this.emit("rotated", {
      from: from?.id ?? null,
      to: to.id,
      cause,
      ...(from?.limitedUntil ? { fromResetAtMs: from.limitedUntil } : {}),
      ...(from?.limitType ? { fromLimitType: from.limitType } : {}),
    });
    return this.lease(to);
  }

  /**
   * The account an exhausted lease names: the active one when it is merely
   * limited, else (rotation on) the limited account that resets first. Its
   * identity is checked like any other use. Null when none qualifies.
   */
  private limitedFallback(current: ClaudeAccount | undefined, enabled: readonly ClaudeAccount[]): ClaudeAccount | null {
    const fresh = (a: ClaudeAccount): ClaudeAccount | null => this.store.get(a.id);
    const ok = (a: ClaudeAccount | null): a is ClaudeAccount =>
      !!a && a.enabled && a.status === "limited" && this.identityOk(a) && this.store.get(a.id)?.status === "limited";
    const cur = current ? fresh(current) : null;
    if (ok(cur)) return cur;
    if (cur && !this.rotationEnabled()) return null;
    const limited = enabled
      .map(fresh)
      .filter((a): a is ClaudeAccount => !!a && a.status === "limited")
      .sort((a, b) => (a.limitedUntil ?? Infinity) - (b.limitedUntil ?? Infinity));
    return limited.find((a) => ok(a)) ?? null;
  }

  private recoverExpired(now: number): void {
    for (const a of this.store.list()) {
      if (a.status === "limited" && a.limitedUntil !== null && a.limitedUntil <= now) {
        this.store.update(a.id, { status: "ok", limitedUntil: null, limitType: null, limitMessage: null });
        this.record("recovered", "system", { account: a.id });
        this.emit("recovered", { accountId: a.id });
      }
    }
    this.store.pruneModelLimits(now);
  }

  /** The identity pin. True when the account may be used. */
  private identityOk(acc: ClaudeAccount): boolean {
    const now = this.now();
    const last = this.identityCheckedAt.get(acc.id);
    if (last !== undefined && now - last < IDENTITY_RECHECK_MS) return true;
    const read = (this.opts.readIdentity ?? readAccountIdentity)(identityFilePath(acc.configDir, this.home));
    // A file caught mid-write by the CLI is not evidence of anything; look again next time.
    if (!read.ok && read.reason === "unreadable") return true;
    this.identityCheckedAt.set(acc.id, now);
    if (!read.ok) {
      this.reportAuthError(acc.id, "not logged in: the identity file has no account", "not_logged_in");
      return false;
    }
    if (acc.accountUuid && read.identity.accountUuid !== acc.accountUuid) {
      this.reportAuthError(acc.id, "identity changed: the directory is now logged in to a different account", "identity_changed");
      return false;
    }
    return true;
  }

  /** The data dir an account's transcripts live under. null = ambient. Undefined for an unknown id. */
  private dataDirOf(accountId: string | null): string | undefined {
    if (accountId === null) {
      const ambient = this.baseEnv().CLAUDE_CONFIG_DIR;
      return ambient ? normalizeConfigDirPath(ambient, this.home) : join(this.home, ".claude");
    }
    const acc = this.store.get(accountId);
    return acc ? accountDataDir(acc.configDir, this.home) : undefined;
  }
}
