import pino from "pino";
import type { UnifiedMessage } from "../channels/normalizer.js";
import { IdentityResolver, type ResolvedIdentity } from "./auth.js";
import { AuthorizationEngine, type AuthorizationResult } from "./authz.js";
import { RateLimiter, type RateLimitResult } from "./rate-limiter.js";
import { InputGuard, InputGuardError } from "./input-guard.js";

const log = pino({ name: "security-gate" });

/**
 * Per-channel security restrictions extracted from channel config.
 */
export interface ChannelSecurityRestrictions {
  /** Only allow messages from these user IDs. Empty = no restriction. */
  allowedUserIds?: readonly (string | number)[];
  /** Whether groups are allowed on this channel */
  allowGroups?: boolean;
}

/**
 * Result of a SecurityGate check.
 */
export type GateResult =
  | { passed: true; identity: ResolvedIdentity; wrappedText: string }
  | { passed: false; reason: string; retryAfterMs?: number };

/**
 * SecurityGate chains the security checks in order:
 *   0. Per-channel restrictions (allowedUserIds, allowGroups)
 *   1. Identity resolution (auth)
 *   2. Authorization (authz)
 *   3. Rate limiting
 *   4. Input guard (sanitization + suspicious pattern detection)
 *
 * If any step fails, the pipeline short-circuits with a descriptive reason.
 */
export class SecurityGate {
  private readonly identityResolver: IdentityResolver;
  private readonly authzEngine: AuthorizationEngine;
  private readonly rateLimiter: RateLimiter;
  private readonly inputGuard: InputGuard;
  private readonly channelRestrictions: Map<string, ChannelSecurityRestrictions>;

  constructor(deps: {
    identityResolver: IdentityResolver;
    authzEngine: AuthorizationEngine;
    rateLimiter: RateLimiter;
    inputGuard: InputGuard;
    /** Per-channel security restrictions keyed by channel name */
    channelRestrictions?: Record<string, ChannelSecurityRestrictions>;
  }) {
    this.identityResolver = deps.identityResolver;
    this.authzEngine = deps.authzEngine;
    this.rateLimiter = deps.rateLimiter;
    this.inputGuard = deps.inputGuard;
    this.channelRestrictions = new Map(
      Object.entries(deps.channelRestrictions ?? {}),
    );
  }

  /**
   * Run all security checks on an incoming message.
   *
   * @param message - The incoming unified message from a channel
   * @returns GateResult indicating pass/fail with details
   */
  check(message: UnifiedMessage): GateResult {
    // 0. Per-channel restrictions
    const restrictions = this.channelRestrictions.get(message.channel);
    if (restrictions) {
      // Check allowedUserIds
      if (restrictions.allowedUserIds && restrictions.allowedUserIds.length > 0) {
        const allowed = restrictions.allowedUserIds.map(String);
        if (!allowed.includes(String(message.senderId))) {
          log.info(
            { channel: message.channel, senderId: message.senderId },
            "sender not in channel allowlist",
          );
          return { passed: false, reason: "User not in channel allowlist" };
        }
      }

      // Check allowGroups
      if (
        restrictions.allowGroups === false &&
        (message.chatType === "group" || message.chatType === "thread")
      ) {
        log.info(
          { channel: message.channel, chatId: message.chatId },
          "groups disabled for channel",
        );
        return { passed: false, reason: "Groups are disabled for this channel" };
      }
    }

    // 1. Resolve identity
    const identity = this.identityResolver.resolveIdentity(
      message.channel,
      message.senderId,
    );

    log.debug(
      { channel: message.channel, senderId: message.senderId, role: identity.role },
      "identity resolved",
    );

    // 2. Authorization check
    const authzResult: AuthorizationResult = this.authzEngine.authorize(
      identity,
      "message",
      { chatType: message.chatType },
    );

    if (!authzResult.allowed) {
      log.info(
        { canonicalId: identity.canonicalId, reason: authzResult.reason },
        "authorization denied",
      );
      return { passed: false, reason: authzResult.reason ?? "Not authorized" };
    }

    // 3. Rate limiting
    const rateResult: RateLimitResult = this.rateLimiter.consume(
      message.channel,
      message.senderId,
      message.chatType,
    );

    if (!rateResult.allowed) {
      log.info(
        { canonicalId: identity.canonicalId, retryAfterMs: rateResult.retryAfterMs },
        "rate limited",
      );
      return {
        passed: false,
        reason: `Rate limit exceeded. Try again in ${Math.ceil((rateResult.retryAfterMs ?? 0) / 1000)} seconds.`,
        retryAfterMs: rateResult.retryAfterMs,
      };
    }

    // 4. Input guard
    try {
      const wrappedText = this.inputGuard.wrap(message);

      // Detect and log suspicious patterns (non-blocking)
      const suspicious = this.inputGuard.detectSuspicious(message.text);
      if (suspicious.length > 0) {
        log.warn(
          {
            canonicalId: identity.canonicalId,
            patterns: suspicious.map((s) => s.description),
          },
          "suspicious input patterns detected",
        );
      }

      return { passed: true, identity, wrappedText };
    } catch (err) {
      if (err instanceof InputGuardError) {
        log.info(
          { canonicalId: identity.canonicalId, error: err.message },
          "input guard rejected",
        );
        return { passed: false, reason: err.message };
      }
      throw err;
    }
  }
}
