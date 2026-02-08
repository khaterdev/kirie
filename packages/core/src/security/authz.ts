import type { Role, ResolvedIdentity } from "./auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actions that can be authorized */
export type Action =
  | "message"
  | "command"
  | "tool_invoke"
  | "admin_command"
  | "config_change";

export interface AuthorizationResult {
  /** Whether the action is allowed */
  allowed: boolean;
  /** Human-readable reason (set when denied) */
  reason?: string;
}

export interface AuthorizationEngineOptions {
  /** DM policy from security config */
  dmPolicy: "owner-only" | "allowlist" | "open";
  /** Group policy from security config */
  groupPolicy: "mention-only" | "all" | "disabled";
  /** Whitelisted tool names for the "user" role */
  userAllowedTools?: readonly string[];
}

// ---------------------------------------------------------------------------
// Role hierarchy
// ---------------------------------------------------------------------------

/** Numeric weight for role comparison. Higher = more privilege. */
const ROLE_WEIGHT: Record<Role, number> = {
  owner: 40,
  admin: 30,
  user: 20,
  readonly: 10,
};

/** Minimum role required for each action */
const ACTION_MIN_ROLE: Record<Action, Role> = {
  message: "user",
  command: "admin",
  tool_invoke: "admin",
  admin_command: "owner",
  config_change: "owner",
};

// ---------------------------------------------------------------------------
// AuthorizationEngine
// ---------------------------------------------------------------------------

export class AuthorizationEngine {
  private readonly dmPolicy: string;
  private readonly groupPolicy: string;
  private readonly userAllowedTools: Set<string>;

  constructor(options: AuthorizationEngineOptions) {
    this.dmPolicy = options.dmPolicy;
    this.groupPolicy = options.groupPolicy;
    this.userAllowedTools = new Set(options.userAllowedTools ?? []);
  }

  /**
   * Check if an identity is allowed to perform an action.
   */
  authorize(
    identity: ResolvedIdentity,
    action: Action,
    context?: { chatType?: "dm" | "group" | "thread"; toolName?: string },
  ): AuthorizationResult {
    const { role } = identity;

    // Check DM policy
    if (context?.chatType === "dm") {
      const dmResult = this.checkDmPolicy(identity);
      if (!dmResult.allowed) {
        return dmResult;
      }
    }

    // Check group policy
    if (context?.chatType === "group" || context?.chatType === "thread") {
      const groupResult = this.checkGroupPolicy(identity);
      if (!groupResult.allowed) {
        return groupResult;
      }
    }

    // Readonly can never perform any action
    if (role === "readonly") {
      return {
        allowed: false,
        reason: `Role "readonly" cannot perform action "${action}"`,
      };
    }

    // Check role hierarchy against required minimum
    const requiredRole = ACTION_MIN_ROLE[action];
    if (!hasMinRole(role, requiredRole)) {
      // Special case: user role can invoke whitelisted tools
      if (action === "tool_invoke" && role === "user" && context?.toolName) {
        if (this.userAllowedTools.has(context.toolName)) {
          return { allowed: true };
        }
        return {
          allowed: false,
          reason: `Tool "${context.toolName}" requires at least "${requiredRole}" role, but user has "${role}"`,
        };
      }

      return {
        allowed: false,
        reason: `Action "${action}" requires at least "${requiredRole}" role, but user has "${role}"`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if a role meets a minimum role requirement.
   */
  static hasMinRole(role: Role, minRole: Role): boolean {
    return hasMinRole(role, minRole);
  }

  /**
   * Compare two roles. Returns negative if a < b, 0 if equal, positive if a > b.
   */
  static compareRoles(a: Role, b: Role): number {
    return ROLE_WEIGHT[a] - ROLE_WEIGHT[b];
  }

  /**
   * Get all actions a role is permitted to perform.
   */
  static getPermittedActions(role: Role): Action[] {
    const actions: Action[] = [];
    for (const [action, minRole] of Object.entries(ACTION_MIN_ROLE)) {
      if (hasMinRole(role, minRole)) {
        actions.push(action as Action);
      }
    }
    return actions;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private checkDmPolicy(identity: ResolvedIdentity): AuthorizationResult {
    if (this.dmPolicy === "owner-only" && identity.role !== "owner") {
      return {
        allowed: false,
        reason: "DM policy is owner-only; only the owner can interact via DM",
      };
    }

    if (this.dmPolicy === "allowlist" && identity.role === "readonly") {
      return {
        allowed: false,
        reason: "DM policy is allowlist; unrecognized users cannot interact via DM",
      };
    }

    return { allowed: true };
  }

  private checkGroupPolicy(_identity: ResolvedIdentity): AuthorizationResult {
    if (this.groupPolicy === "disabled") {
      return {
        allowed: false,
        reason: "Group interaction is disabled",
      };
    }

    // "mention-only" and "all" are handled at the message routing level,
    // not at the authorization level. If we got here, the message was
    // already determined to be relevant (e.g., bot was mentioned).
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasMinRole(role: Role, minRole: Role): boolean {
  return ROLE_WEIGHT[role] >= ROLE_WEIGHT[minRole];
}
