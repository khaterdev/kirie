/**
 * The `approvals` tool gate (order 900, last in the chain so it judges the
 * final input; PLAN B.1, C.9).
 *
 * allow -> pass, deny -> deny with the fixed agent message, ask -> ask whose
 * `resolve` waits for the owner through `ApprovalPrompter.request`.
 *
 * Failure policy: if the engine itself throws, the gate passes in `yolo` (and
 * logs it) and asks in `ask`. It never throws into the chain.
 */

import { createModuleLogger } from "../logging/logger.js";
import type { ToolGate, ToolGateCall, ToolGateVerdict } from "../engine/sdk-options.js";
import type { AuditTrail } from "../security/audit-trail.js";
import type { ApprovalEngine } from "./engine.js";
import type { ApprovalPrompter } from "./prompter.js";
import type { ApprovalEvaluation, ApprovalMode, ApprovalToolCall } from "./types.js";

const log = createModuleLogger("approvals");

export const APPROVALS_GATE_NAME = "approvals";
export const APPROVALS_GATE_ORDER = 900;

/** Counters since start (plain allows are counted, not audited). */
export class ApprovalStats {
  allowed = 0;
  allowedFlagged = 0;
  asked = 0;
  denied = 0;
  errors = 0;
  readonly since = Date.now();

  snapshot(): { allowed: number; allowedFlagged: number; asked: number; denied: number; errors: number; since: number } {
    return { allowed: this.allowed, allowedFlagged: this.allowedFlagged, asked: this.asked, denied: this.denied, errors: this.errors, since: this.since };
  }
}

export interface ApprovalsGateOptions {
  audit?: Pick<AuditTrail, "record">;
  stats?: ApprovalStats;
}

function actorOf(call: ApprovalToolCall): string {
  return call.ctx.sessionKey ? `agent:${call.ctx.sessionKey}` : `agent:${call.ctx.label}`;
}

function auditDecision(audit: ApprovalsGateOptions["audit"], action: string, ev: ApprovalEvaluation, call: ApprovalToolCall): void {
  try {
    audit?.record({
      feature: "approvals",
      action,
      actor: actorOf(call),
      detail: {
        tool: call.tool,
        hash: ev.hash.slice(0, 16),
        rules: ev.findings.map((f) => f.ruleId),
        uncertain: ev.uncertain.map((u) => u.code),
        mode: ev.mode,
        context: call.ctx.label,
        ...(call.agentType ? { subagent: call.agentType } : {}),
        ...(ev.findings[0]?.reason ? { reason: ev.findings[0].reason.slice(0, 200) } : {}),
      },
    });
  } catch (err) {
    log.warn({ err }, "approval audit record failed");
  }
}

export function createApprovalsGate(engine: ApprovalEngine, prompter: ApprovalPrompter, opts: ApprovalsGateOptions = {}): ToolGate {
  const stats = opts.stats ?? new ApprovalStats();
  return {
    name: APPROVALS_GATE_NAME,
    order: APPROVALS_GATE_ORDER,
    check(gateCall: ToolGateCall): ToolGateVerdict {
      const call: ApprovalToolCall = {
        tool: gateCall.tool,
        input: gateCall.input,
        cwd: gateCall.cwd,
        ctx: gateCall.ctx,
        ...(gateCall.agentId ? { agentId: gateCall.agentId } : {}),
        ...(gateCall.agentType ? { agentType: gateCall.agentType } : {}),
      };
      let ev: ApprovalEvaluation;
      try {
        ev = engine.evaluate(call);
      } catch (err) {
        stats.errors++;
        let mode: ApprovalMode = "ask";
        try {
          mode = engine.mode();
        } catch {
          mode = "ask";
        }
        log.error({ err, tool: call.tool, mode }, "approval engine threw");
        if (mode === "yolo") return { decision: "pass" };
        ev = {
          decision: "ask", mode, scope: "dangerous", findings: [{ ruleId: "engine.error", severity: "dangerous", reason: "approval engine error" }],
          uncertain: [], allowlisted: false, summary: "approval needed: approval engine error", messageForAgent: "", hash: "0".repeat(64), engineError: true,
        };
      }

      if (ev.decision === "allow") {
        if (ev.findings.length > 0 || ev.uncertain.length > 0) {
          stats.allowedFlagged++;
          auditDecision(opts.audit, ev.allowlisted ? "allowed.allowlist" : "allowed.flagged", ev, call);
        } else {
          stats.allowed++;
        }
        return { decision: "pass" };
      }
      if (ev.decision === "deny") {
        stats.denied++;
        auditDecision(opts.audit, ev.findings[0]?.severity === "hardline" ? "denied.hardline" : "denied.denylist", ev, call);
        return { decision: "deny", reason: ev.messageForAgent };
      }
      stats.asked++;
      const toolUseId = gateCall.toolUseId;
      return {
        decision: "ask",
        summary: ev.summary,
        resolve: async (signal: AbortSignal) => {
          const r = await prompter.request(ev, call, { signal, toolUseId });
          return { approved: r.approved, reason: r.messageForAgent, ...(r.stop ? { interrupt: true } : {}) };
        },
      };
    },
  };
}
