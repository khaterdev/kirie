import type { SecurityConfig } from "../config/schema.js";
import type { ChannelName } from "../channels/normalizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical role hierarchy (highest to lowest privilege) */
export type Role = "owner" | "admin" | "user" | "readonly";

/** Resolved identity for a channel sender */
export interface ResolvedIdentity {
  /** Assigned role based on identity resolution */
  readonly role: Role;
  /** Canonical identifier: "{channel}:{senderId}" */
  readonly canonicalId: string;
  /** Original channel name */
  readonly channel: ChannelName;
  /** Original platform sender ID */
  readonly senderId: string;
}

export interface IdentityResolverOptions {
  /** Security config section from KirieConfig */
  securityConfig: SecurityConfig;
  /** Additional admin identities per channel */
  admins?: Partial<Record<ChannelName, readonly string[]>>;
  /** Additional allowlisted user identities per channel */
  users?: Partial<Record<ChannelName, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// IdentityResolver
// ---------------------------------------------------------------------------

export class IdentityResolver {
  private readonly ownerIds: Map<string, Set<string>>;
  private readonly adminIds: Map<string, Set<string>>;
  private readonly userIds: Map<string, Set<string>>;
  private readonly dmPolicy: string;
  private readonly groupPolicy: string;

  constructor(options: IdentityResolverOptions) {
    const { securityConfig } = options;

    this.dmPolicy = securityConfig.dmPolicy;
    this.groupPolicy = securityConfig.groupPolicy;

    // Build owner identity sets
    this.ownerIds = new Map();
    const ownerIdentities = securityConfig.owner.identities;
    for (const [channel, ids] of Object.entries(ownerIdentities)) {
      const stringIds = (ids as Array<string | number>).map(String);
      if (stringIds.length > 0) {
        this.ownerIds.set(channel, new Set(stringIds));
      }
    }

    // Build admin identity sets
    this.adminIds = new Map();
    if (options.admins) {
      for (const [channel, ids] of Object.entries(options.admins)) {
        if (ids && ids.length > 0) {
          this.adminIds.set(channel, new Set(ids.map(String)));
        }
      }
    }

    // Build user identity sets
    this.userIds = new Map();
    if (options.users) {
      for (const [channel, ids] of Object.entries(options.users)) {
        if (ids && ids.length > 0) {
          this.userIds.set(channel, new Set(ids.map(String)));
        }
      }
    }
  }

  /**
   * Resolve a channel-specific sender ID to a canonical identity with role.
   */
  resolveIdentity(channel: ChannelName, senderId: string): ResolvedIdentity {
    const sid = String(senderId);
    const canonicalId = `${channel}:${sid}`;

    // Check owner
    const ownerSet = this.ownerIds.get(channel);
    if (ownerSet?.has(sid)) {
      return { role: "owner", canonicalId, channel, senderId: sid };
    }

    // Check admin
    const adminSet = this.adminIds.get(channel);
    if (adminSet?.has(sid)) {
      return { role: "admin", canonicalId, channel, senderId: sid };
    }

    // Check user allowlist
    const userSet = this.userIds.get(channel);
    if (userSet?.has(sid)) {
      return { role: "user", canonicalId, channel, senderId: sid };
    }

    // Default: user (open policy) or readonly (restricted policy)
    const defaultRole = this.getDefaultRole();
    return { role: defaultRole, canonicalId, channel, senderId: sid };
  }

  /**
   * Quick check: is this sender the owner on this channel?
   */
  isOwner(channel: ChannelName, senderId: string): boolean {
    const ownerSet = this.ownerIds.get(channel);
    return ownerSet?.has(String(senderId)) ?? false;
  }

  /**
   * Quick check: does this sender have at least admin-level access?
   */
  isAdmin(channel: ChannelName, senderId: string): boolean {
    const identity = this.resolveIdentity(channel, senderId);
    return identity.role === "owner" || identity.role === "admin";
  }

  /**
   * Get the DM policy setting.
   */
  getDmPolicy(): string {
    return this.dmPolicy;
  }

  /**
   * Get the group policy setting.
   */
  getGroupPolicy(): string {
    return this.groupPolicy;
  }

  /**
   * Update the configuration at runtime (e.g., after config reload).
   */
  static fromConfig(securityConfig: SecurityConfig): IdentityResolver {
    return new IdentityResolver({ securityConfig });
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private getDefaultRole(): Role {
    // In owner-only mode, unrecognized senders get readonly
    if (this.dmPolicy === "owner-only") {
      return "readonly";
    }
    // In allowlist mode, unrecognized senders get readonly
    if (this.dmPolicy === "allowlist") {
      return "readonly";
    }
    // In open mode, everyone gets user
    return "user";
  }
}
