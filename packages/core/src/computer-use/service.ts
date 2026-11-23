/**
 * ComputerUseService: the live state behind the computer-use feature (PLAN C.13).
 *
 * Holds the three switches Kirie controls (the config flag, read at start; the
 * cached driver probe; the in-memory arming window) and answers the questions
 * the contributor, the prefix claim, the gate, the commands and the status
 * route ask. Arming happens only through `arm()`, which only the `/computer`
 * owner command calls.
 */

import { homedir } from "node:os";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ComputerUseConfig } from "../config/sections/computer-use.js";
import type { SdkCallContext } from "../engine/sdk-options.js";
import type { TurnOrigin } from "../engine/turn-context.js";
import type { AuditRecord } from "../security/audit-trail.js";
import { createModuleLogger } from "../logging/logger.js";
import { ComputerUseArming, clampComputerUseMinutes, type ComputerUseDisarmReason } from "./arming.js";
import {
  createComputerUseAppResolver,
  probeComputerUseDriver,
  stopComputerUseDriver,
  type ComputerUseDriverDeps,
  type ComputerUseDriverStatus,
} from "./driver.js";
import { applyComputerUseSessionOptions } from "./mcp-config.js";
import type { ComputerUseAppInfo, ComputerUseArmState } from "./policy.js";

const log = createModuleLogger("computer-use");

export interface ComputerUseAuditSink {
  record(rec: Omit<AuditRecord, "ts">): void;
  recent?(filter: { feature?: string; limit?: number }): AuditRecord[];
}

export interface ComputerUseApprovalPrompts {
  requestApproval(req: { kind: string; title: string; body?: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ outcome: string; optionId: string; code: string }>;
}

export interface ComputerUseServiceDeps {
  config: ComputerUseConfig;
  driver: ComputerUseDriverDeps;
  /** Origin of the turn a call belongs to (originOf with the daemon's TurnContextRegistry). */
  originOf: (ctx: SdkCallContext) => TurnOrigin;
  /** The approvals dangerous-text classifier. */
  isDangerousText: (text: string) => boolean;
  audit?: ComputerUseAuditSink;
  prompts?: ComputerUseApprovalPrompts;
  /** Effective sandbox mode; computer use cannot work from a docker sandbox. */
  sandboxMode?: () => string;
  /** Called after a window closed: the sessions that were given the server, so idle ones can be restarted without it. */
  onDisarmed?: (reason: ComputerUseDisarmReason, offeredSessions: string[]) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Override the pid resolver (tests). */
  resolveApp?: (pid: number) => Promise<ComputerUseAppInfo | null>;
}

export interface ComputerUseStatusSnapshot {
  enabled: boolean;
  installed: boolean | null;
  healthy: boolean | null;
  armed: boolean;
  minutesLeft: number;
  apps: string[];
  approval: ComputerUseConfig["approval"];
  screenshots: ComputerUseConfig["screenshots"];
  problems: string[];
}

export type ComputerUseArmResult =
  | { ok: true; state: ComputerUseArmState; minutes: number; capped: boolean; status: ComputerUseDriverStatus }
  | { ok: false; reason: "disabled" | "not-installed" | "unhealthy" | "cancelled"; status?: ComputerUseDriverStatus };

export class ComputerUseService {
  readonly config: ComputerUseConfig;
  readonly arming: ComputerUseArming;
  readonly resolveApp: (pid: number) => Promise<ComputerUseAppInfo | null>;
  private status: ComputerUseDriverStatus | null = null;
  private readonly offered = new Set<string>();
  private disarmActor = "system";
  private readonly deps: ComputerUseServiceDeps;
  private readonly now: () => number;

  constructor(deps: ComputerUseServiceDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.arming = new ComputerUseArming({
      now: this.now,
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
      ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
      onDisarm: (reason, previous) => this.afterDisarm(reason, previous),
    });
    this.resolveApp = deps.resolveApp ?? createComputerUseAppResolver({ exec: deps.driver.exec, now: this.now });
  }

  // ── Driver ────────────────────────────────────────────────────────────

  /** Run the read-only probe and cache it. */
  async probe(): Promise<ComputerUseDriverStatus> {
    const status = await probeComputerUseDriver(this.config, this.deps.driver);
    this.status = status;
    this.audit("probe", "system", {
      installed: status.installed,
      healthy: status.healthy,
      problems: status.problems.length,
      ...(status.version ? { version: status.version } : {}),
    });
    return status;
  }

  lastStatus(): ComputerUseDriverStatus | null {
    return this.status;
  }

  // ── Arming ────────────────────────────────────────────────────────────

  /**
   * Open a window. Requires `computerUse.enabled` and a healthy probe (run
   * now). Only the `/computer on` owner command calls this.
   */
  async arm(opts: { minutes?: number; apps?: readonly string[]; by: string; epoch?: number }): Promise<ComputerUseArmResult> {
    if (!this.config.enabled) return { ok: false, reason: "disabled" };
    // A /computer off that arrives while this arm waits (confirmation, probe) wins.
    const epoch = opts.epoch ?? this.arming.epoch();
    if (this.arming.epoch() !== epoch) return { ok: false, reason: "cancelled" };
    const status = await this.probe();
    if (!status.installed) return { ok: false, reason: "not-installed", status };
    if (!status.healthy) return { ok: false, reason: "unhealthy", status };
    if (this.arming.epoch() !== epoch) return { ok: false, reason: "cancelled", status };
    const requested = opts.minutes ?? this.config.armMinutes;
    const minutes = clampComputerUseMinutes(requested, this.config.armMinutes, this.config.maxArmMinutes);
    const state = this.arming.arm({ minutes, ...(opts.apps ? { apps: opts.apps } : {}), by: opts.by });
    this.audit("armed", opts.by, { minutes, apps: state.apps ?? [], approval: this.config.approval, screenshots: this.config.screenshots });
    return { ok: true, state, minutes, capped: minutes !== requested, status };
  }

  /** Close the window now. Works whatever the config says (the kill switch). Also runs `cua-driver stop`. */
  async disarm(reason: ComputerUseDisarmReason, by = "system"): Promise<{ wasArmed: boolean; driverStopped: boolean }> {
    this.disarmActor = by;
    const wasArmed = this.arming.disarm(reason);
    this.disarmActor = "system";
    if (!wasArmed) this.audit("disarmed", by, { reason, wasArmed: false });
    // The owner's /computer off always stops the driver; a shutdown only when a window was open.
    const driverStopped = wasArmed || reason === "owner" ? await this.stopDriver() : false;
    return { wasArmed, driverStopped };
  }

  private afterDisarm(reason: ComputerUseDisarmReason, previous: ComputerUseArmState): void {
    this.audit("disarmed", this.disarmActor, { reason, wasArmed: true, armedBy: previous.armedBy ?? "unknown" });
    const sessions = [...this.offered];
    this.offered.clear();
    if (reason === "timeout") void this.stopDriver();
    try {
      this.deps.onDisarmed?.(reason, sessions);
    } catch (err) {
      log.warn({ err }, "computer-use disarm callback threw");
    }
  }

  private async stopDriver(): Promise<boolean> {
    const stopped = await stopComputerUseDriver(this.config, this.deps.driver);
    if (stopped) this.audit("driver.stopped", "system", {});
    return stopped;
  }

  // ── Who gets the server ───────────────────────────────────────────────

  /** The context is the owner's own interactive DM chat (not voice). Turn origin and subagents are checked per call by the gate. */
  isOwnerChatContext(ctx: SdkCallContext): boolean {
    return ctx.kind === "chat" && ctx.interactive && ctx.ownerDm && ctx.chatType === "dm" && ctx.channel !== "voice";
  }

  /** The `mcp__cua-driver` prefix claim: enabled, armed, owner DM chat. */
  claimAllows(ctx: SdkCallContext): boolean {
    return this.config.enabled && this.arming.isArmed() && this.isOwnerChatContext(ctx);
  }

  /** Whether this spawn gets the cua-driver server. */
  shouldOffer(ctx: SdkCallContext): boolean {
    if (!this.claimAllows(ctx)) return false;
    if (!this.status?.healthy) return false;
    if (this.deps.sandboxMode?.() === "docker") return false;
    return this.safeOrigin(ctx) === "owner_message";
  }

  /** The `computer-use` options contributor (order 60). */
  contribute(options: Options, ctx: SdkCallContext): void {
    if (ctx.kind === "judge" || ctx.kind === "triage" || ctx.kind === "oneshot") return;
    const offer = this.shouldOffer(ctx);
    applyComputerUseSessionOptions(options, offer, this.config, this.deps.driver.homeDir ?? homedir());
    if (offer && ctx.sessionKey) this.offered.add(ctx.sessionKey);
  }

  offeredSessions(): string[] {
    return [...this.offered];
  }

  /** Origin of the turn ("system" when none is recorded or the lookup fails). */
  safeOrigin(ctx: SdkCallContext): TurnOrigin {
    try {
      return this.deps.originOf(ctx);
    } catch {
      return "system";
    }
  }

  // ── Policy inputs ─────────────────────────────────────────────────────

  isDangerousText(text: string): boolean {
    try {
      return this.deps.isDangerousText(text);
    } catch {
      return true;
    }
  }

  /** Ask the owner for a per-app grant. Approve stores it until the window closes. Never rejects. */
  async requestGrant(app: ComputerUseAppInfo, grantKey: string, detail: { tool: string; label: string }, store: boolean, signal: AbortSignal): Promise<{ approved: boolean; reason: string }> {
    const epoch = this.arming.epoch();
    const prompts = this.deps.prompts;
    if (!prompts) return { approved: false, reason: "Owner approval is unavailable, so the action is denied." };
    const appName = app.name ? `${app.name} (${app.bundleId})` : app.bundleId;
    let outcome = "unavailable";
    try {
      const res = await prompts.requestApproval({
        kind: "computer",
        title: store ? `Let Kirie control ${appName}?` : `Allow one ${detail.tool} in ${appName}?`,
        body: [
          `Desktop control wants to act in ${appName} (first action: ${detail.tool}).`,
          store ? "Approve lets it act in this app until computer use is turned off or the window ends." : "Approve allows this one action.",
          `From: ${detail.label}. /computer off stops it at any time.`,
        ].join("\n"),
        timeoutMs: this.config.approvalTimeoutSeconds * 1000,
        signal,
      });
      outcome = res.outcome;
    } catch {
      outcome = "unavailable";
    }
    const approved = outcome === "approved";
    // isArmed() first: it closes a window whose time ran out (timers pause while the Mac sleeps).
    if (approved && (!this.arming.isArmed() || this.arming.epoch() !== epoch)) {
      this.audit("grant.stale", "system", { app: app.bundleId, tool: detail.tool });
      return { approved: false, reason: "Computer use was turned off, ended or re-armed while waiting for approval." };
    }
    if (approved && store) this.arming.grant(grantKey, epoch);
    this.audit(approved ? "grant.approved" : "grant.denied", approved ? "owner" : "system", { app: app.bundleId, tool: detail.tool, outcome, perApp: store });
    if (approved) return { approved: true, reason: "approved by the owner" };
    return {
      approved: false,
      reason: outcome === "timeout"
        ? "The owner did not answer the computer-use approval in time; the action is denied."
        : "The owner did not approve this computer-use action. Do not retry it.",
    };
  }

  // ── Status ────────────────────────────────────────────────────────────

  snapshot(): ComputerUseStatusSnapshot {
    const state = this.arming.state();
    return {
      enabled: this.config.enabled,
      installed: this.status ? this.status.installed : null,
      healthy: this.status ? this.status.healthy : null,
      armed: state.armed,
      minutesLeft: this.arming.minutesLeft(),
      apps: [...(state.apps ?? [])],
      approval: this.config.approval,
      screenshots: this.config.screenshots,
      problems: this.status ? [...this.status.problems] : [],
    };
  }

  recentAudit(limit = 5): AuditRecord[] {
    try {
      return this.deps.audit?.recent?.({ feature: "computer-use", limit }) ?? [];
    } catch {
      return [];
    }
  }

  audit(action: string, actor: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit?.record({ feature: "computer-use", action, actor, detail });
    } catch {
      // AuditTrail never throws; a fake might.
    }
  }

  /** Minutes the owner asked for, clamped (exposed for the command's reply). */
  clampMinutes(minutes: number): number {
    return clampComputerUseMinutes(minutes, this.config.armMinutes, this.config.maxArmMinutes);
  }
}
