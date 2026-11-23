/**
 * Computer use policy: the pure decision function behind the `computer-use`
 * tool gate (PLAN C.13, R5 item 13 "Decision order").
 *
 * No I/O: the gate resolves the pids an input names before calling it and
 * passes the results in `ctx.apps`. Same inputs, same decision.
 */

import type { ComputerUseConfig } from "../config/sections/computer-use.js";
import {
  classifyComputerUseTool,
  COMPUTER_USE_KEY_TOOLS,
  COMPUTER_USE_NO_TYPING_EXTRA_TOOLS,
  COMPUTER_USE_TEXT_TOOLS,
  COMPUTER_USE_TYPING_TOOLS,
  COMPUTER_USE_WINDOW_OBSERVE_TOOLS,
  type ComputerUseToolClass,
} from "./tools.js";

export interface ComputerUseAppInfo {
  readonly bundleId: string;
  readonly name?: string;
}

export interface ComputerUseArmState {
  readonly armed: boolean;
  /** Epoch ms when the window ends. */
  readonly until?: number;
  /** App scope given to /computer on (names or bundle ids). Empty or missing: any app not denied. */
  readonly apps?: readonly string[];
  readonly armedBy?: string;
  readonly armedAt?: number;
}

export interface ComputerUsePolicyContext {
  readonly cfg: ComputerUseConfig;
  readonly arm: ComputerUseArmState;
  /** Grant key -> expiry (epoch ms; Infinity = until disarm). */
  readonly grants: ReadonlyMap<string, number>;
  readonly now: number;
  /** The owner's own DM, a main-thread call of an interactive chat turn the owner sent. Never voice, never a task. */
  readonly ownerInteractive: boolean;
  /** Apps for the pids the input names (see computerUseInputPids). null = could not be identified. */
  readonly apps: ReadonlyMap<number, ComputerUseAppInfo | null>;
  /** The approvals dangerous-text classifier, injected. */
  isDangerousText(text: string): boolean;
}

export type ComputerUseDecision =
  | { kind: "allow"; toolClass: ComputerUseToolClass; app?: ComputerUseAppInfo; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; toolClass: ComputerUseToolClass; app?: ComputerUseAppInfo; reason: string }
  | { kind: "ask"; toolClass: ComputerUseToolClass; app: ComputerUseAppInfo; grantKey: string; summary: string; updatedInput?: Record<string, unknown> };

export const COMPUTER_USE_OFF_REASON = "Computer use is off. The owner can arm it with /computer on.";
export const COMPUTER_USE_NOT_OWNER_REASON =
  "Computer use is only available in the owner's own direct chat, for messages the owner sent (never in groups, scheduled, background, goal, loop, webhook, voice or subagent work).";

/** Common display names to bundle ids, for `launch_app` by name and for `/computer on Notes`. */
export const COMPUTER_USE_KNOWN_APPS: Readonly<Record<string, string>> = {
  notes: "com.apple.Notes",
  finder: "com.apple.finder",
  reminders: "com.apple.reminders",
  calendar: "com.apple.iCal",
  textedit: "com.apple.TextEdit",
  preview: "com.apple.Preview",
  mail: "com.apple.mail",
  messages: "com.apple.MobileSMS",
  music: "com.apple.Music",
  photos: "com.apple.Photos",
  pages: "com.apple.iWork.Pages",
  numbers: "com.apple.iWork.Numbers",
  keynote: "com.apple.iWork.Keynote",
  safari: "com.apple.Safari",
  "google chrome": "com.google.Chrome",
  chrome: "com.google.Chrome",
  firefox: "org.mozilla.firefox",
  terminal: "com.apple.Terminal",
  iterm: "com.googlecode.iterm2",
  iterm2: "com.googlecode.iterm2",
  "system settings": "com.apple.systempreferences",
  "system preferences": "com.apple.systempreferences",
  "keychain access": "com.apple.keychainaccess",
  passwords: "com.apple.Passwords",
  "1password": "com.1password.1password",
  bitwarden: "com.bitwarden.desktop",
};

function lower(s: string): string {
  return s.toLowerCase();
}

function inList(bundleId: string, list: readonly string[]): boolean {
  const b = lower(bundleId);
  return list.some((entry) => lower(entry) === b);
}

/** Bundle id for a name or bundle id the owner or the model typed; null when unknown. */
export function computerUseBundleIdFor(nameOrId: string): string | null {
  const t = nameOrId.trim();
  if (!t) return null;
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(t)) return t;
  return COMPUTER_USE_KNOWN_APPS[lower(t)] ?? null;
}

/** True when an entry of the arming scope names this app (bundle id, known name, display name, or last bundle id part). */
export function computerUseAppInScope(app: ComputerUseAppInfo, scope: readonly string[]): boolean {
  const id = lower(app.bundleId);
  const last = id.split(".").pop() ?? id;
  const name = app.name ? lower(app.name) : undefined;
  return scope.some((raw) => {
    const entry = lower(raw.trim());
    if (!entry) return false;
    if (entry === id || entry === last || (name !== undefined && entry === name)) return true;
    const mapped = COMPUTER_USE_KNOWN_APPS[entry];
    return mapped !== undefined && lower(mapped) === id;
  });
}

function pidOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value)) return Number(value);
  return null;
}

/** The pids an input names (`pid`, `process_id`). The gate resolves these before calling decideComputerUse. */
export function computerUseInputPids(input: Record<string, unknown>): number[] {
  const pids = new Set<number>();
  for (const key of ["pid", "process_id", "processId"]) {
    const pid = pidOf(input[key]);
    if (pid !== null) pids.add(pid);
  }
  return [...pids];
}

function launchTarget(input: Record<string, unknown>): ComputerUseAppInfo | null {
  for (const key of ["bundle_id", "bundleId", "bundle_identifier", "app", "app_name", "name"]) {
    const v = input[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const id = computerUseBundleIdFor(v);
    if (id) return { bundleId: id, name: v.includes(".") ? undefined : v.trim() };
  }
  return null;
}

// ── Hotkeys ────────────────────────────────────────────────────────────────

const KEY_ALIASES: Readonly<Record<string, string>> = {
  "⌘": "cmd", command: "cmd", meta: "cmd", super: "cmd", win: "cmd", cmd: "cmd",
  "⌥": "opt", option: "opt", alt: "opt", opt: "opt",
  "⌃": "ctrl", control: "ctrl", ctrl: "ctrl",
  "⇧": "shift", shift: "shift",
  "⌫": "delete", backspace: "delete", delete: "delete", del: "delete", forwarddelete: "delete",
  "⎋": "esc", escape: "esc", esc: "esc",
  return: "enter", enter: "enter",
};

function normalizeKeyToken(token: string): string {
  const t = lower(token.trim());
  return KEY_ALIASES[t] ?? t;
}

function splitKeys(text: string): string[] {
  return text.split(/[+\s,]+/).filter(Boolean);
}

/** Normalized key set of a combo like "Cmd+Shift+Q" or ["command", "shift", "q"]. */
export function normalizeComputerUseHotkey(combo: string | readonly string[]): string[] {
  const tokens = typeof combo === "string" ? splitKeys(combo) : combo.flatMap((k) => splitKeys(String(k)));
  return [...new Set(tokens.map(normalizeKeyToken))].sort();
}

/** Every key the input of a key tool names, across the field shapes the driver may use. */
export function computerUseInputKeys(input: Record<string, unknown>): string[] {
  const tokens: string[] = [];
  for (const key of ["keys", "key", "combo", "hotkey", "shortcut", "modifiers", "modifier"]) {
    const v = input[key];
    if (typeof v === "string") tokens.push(...splitKeys(v));
    else if (Array.isArray(v)) for (const item of v) if (typeof item === "string") tokens.push(...splitKeys(item));
  }
  return normalizeComputerUseHotkey(tokens);
}

/** The blocked combo the pressed keys contain, if any (superset match, order and case ignored). */
export function blockedComputerUseHotkey(pressed: readonly string[], blocked: readonly string[]): string | null {
  const set = new Set(pressed);
  for (const combo of blocked) {
    const keys = normalizeComputerUseHotkey(combo);
    if (keys.length > 0 && keys.every((k) => set.has(k))) return combo;
  }
  return null;
}

/** All string values of an input, for the text check. */
function inputStrings(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(input)) {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const item of v) if (typeof item === "string") out.push(item);
  }
  return out;
}

/** Characters of text an acting tool would type, for the audit (never the text itself). */
export function computerUseTypedChars(tool: string, input: Record<string, unknown>): number | undefined {
  if (!COMPUTER_USE_TEXT_TOOLS.includes(tool)) return undefined;
  return inputStrings(input).reduce((n, s) => n + s.length, 0);
}

function appLabel(app: ComputerUseAppInfo): string {
  return app.name ? `${app.name} (${app.bundleId})` : app.bundleId;
}

export function computerUseGrantKey(app: ComputerUseAppInfo): string {
  return `computer:act:${app.bundleId}`;
}

function grantLive(grants: ReadonlyMap<string, number>, key: string, now: number): boolean {
  const until = grants.get(key);
  return until !== undefined && until > now;
}

// ── The decision ───────────────────────────────────────────────────────────

/**
 * Decide one call to a cua-driver tool. `tool` is the bare name ("click").
 * First match wins:
 *  1. feature off, not armed, or window over: deny
 *  2. not the owner's interactive DM turn: deny
 *  3. blocked (unknown names included): deny
 *  4. full-display capture: only with screenshots "desktop"
 *  5. screenshots "off": include_screenshot forced to false
 *  6. target app: a pid that resolved; launch_app names its app; acting and window-reading tools need a target
 *  7. app tiers: denied apps, the arming scope, allowedApps, observe-only apps, no-typing apps (typing, keys, menus, drag)
 *  8. hard blocks for acting tools in every approval mode: blocked hotkeys, dangerous text
 *  9. observe: allow
 * 10. act: by approval mode (armed-only allows, per-app asks once per app per window, per-action always asks)
 */
export function decideComputerUse(tool: string, input: Record<string, unknown>, ctx: ComputerUsePolicyContext): ComputerUseDecision {
  const { cfg, arm } = ctx;
  const toolClass = classifyComputerUseTool(tool, cfg.tools);
  const deny = (reason: string, app?: ComputerUseAppInfo): ComputerUseDecision => ({ kind: "deny", toolClass, reason, ...(app ? { app } : {}) });

  // 1.
  if (!cfg.enabled || !arm.armed || (arm.until !== undefined && ctx.now >= arm.until)) return deny(COMPUTER_USE_OFF_REASON);
  // 2.
  if (!ctx.ownerInteractive) return deny(COMPUTER_USE_NOT_OWNER_REASON);
  // 3.
  if (toolClass === "blocked") return deny(`The computer-use tool "${tool}" is not allowed.`);
  // 4.
  if (toolClass === "capture") {
    if (cfg.screenshots !== "desktop") return deny("Full-screen capture is off (computerUse.screenshots is not \"desktop\"). Use get_window_state for one window.");
    return { kind: "allow", toolClass };
  }
  // 5.
  let updatedInput: Record<string, unknown> | undefined;
  if (cfg.screenshots === "off") {
    if (tool === "get_window_state" || (toolClass === "observe" && input.include_screenshot !== undefined && input.include_screenshot !== false)) {
      updatedInput = { ...input, include_screenshot: false };
    } else if (input.include_screenshot !== undefined && input.include_screenshot !== false) {
      return deny("Screenshots are off for computer use: call again with include_screenshot set to false.");
    }
  }
  const withInput = updatedInput ? { updatedInput } : {};

  // 6.
  let app: ComputerUseAppInfo | undefined;
  const pids = computerUseInputPids(input);
  if (pids.length > 1) return deny("Pass one pid per call.");
  if (pids.length === 1) {
    const resolved = ctx.apps.get(pids[0]!);
    if (!resolved) return deny(`Could not identify the app for pid ${pids[0]}. Use list_apps or list_windows to find the target window's pid.`);
    app = resolved;
  } else if (tool === "launch_app") {
    const target = launchTarget(input);
    if (!target) return deny("launch_app needs the app's bundle id (bundle_id), for example com.apple.Notes.");
    app = target;
  }
  if (!app && (toolClass === "act" || COMPUTER_USE_WINDOW_OBSERVE_TOOLS.includes(tool))) {
    return deny("Pass the pid of the target window (use list_windows to find it).");
  }

  // 7.
  if (app) {
    const label = appLabel(app);
    if (inList(app.bundleId, cfg.deniedApps)) return deny(`${label} is on the denied list; computer use cannot see or touch it.`, app);
    if (arm.apps && arm.apps.length > 0 && !computerUseAppInScope(app, arm.apps)) {
      return deny(`${label} is outside this arming window (allowed: ${arm.apps.join(", ")}).`, app);
    }
    if (cfg.allowedApps.length > 0 && !inList(app.bundleId, cfg.allowedApps)) {
      return deny(`${label} is not in computerUse.allowedApps.`, app);
    }
    if (toolClass === "act" && inList(app.bundleId, cfg.observeOnlyApps)) {
      return deny(`${label} is view-only for computer use (browsers: use the browser tool instead).`, app);
    }
    if ((COMPUTER_USE_TYPING_TOOLS.includes(tool) || COMPUTER_USE_NO_TYPING_EXTRA_TOOLS.includes(tool)) && inList(app.bundleId, cfg.noTypingApps)) {
      return deny(`Typing, menus and drag into ${label} are not allowed (terminals and editors run commands outside the approval gate).`, app);
    }
  }

  if (toolClass === "observe") return { kind: "allow", toolClass, ...(app ? { app } : {}), ...withInput };

  // From here the tool acts and has a target.
  const target = app as ComputerUseAppInfo;

  // 8.
  if (COMPUTER_USE_KEY_TOOLS.includes(tool)) {
    const hit = blockedComputerUseHotkey(computerUseInputKeys(input), cfg.blockedHotkeys);
    if (hit) return deny(`The key combination ${hit} is blocked for computer use.`, target);
  }
  if (COMPUTER_USE_TEXT_TOOLS.includes(tool)) {
    for (const text of inputStrings(input)) {
      if (text && ctx.isDangerousText(text)) return deny("The text to type looks like a dangerous shell command; it is blocked.", target);
    }
  }

  // 10.
  const grantKey = computerUseGrantKey(target);
  const summary = `Computer use wants to act in ${appLabel(target)} (${tool}).`;
  switch (cfg.approval) {
    case "armed-only":
      return { kind: "allow", toolClass, app: target, ...withInput };
    case "per-action":
      return { kind: "ask", toolClass, app: target, grantKey, summary, ...withInput };
    case "per-app":
    default:
      if (grantLive(ctx.grants, grantKey, ctx.now)) return { kind: "allow", toolClass, app: target, ...withInput };
      return { kind: "ask", toolClass, app: target, grantKey, summary, ...withInput };
  }
}
