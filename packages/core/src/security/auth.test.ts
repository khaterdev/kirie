import { describe, it, expect } from "vitest";
import { IdentityResolver } from "./auth.js";
import type { SecurityConfig } from "../config/schema.js";

function makeSecurityConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    owner: {
      identities: {
        telegram: ["owner-tg-123"],
        discord: ["owner-dc-456"],
        whatsapp: [],
        signal: [],
        slack: [],
      },
    },
    dmPolicy: "owner-only",
    groupPolicy: "mention-only",
    rateLimit: {
      perUser: { maxRequests: 30, windowMs: 60000 },
      perGroup: { maxRequests: 60, windowMs: 60000 },
    },
    ...overrides,
  } as SecurityConfig;
}

describe("IdentityResolver", () => {
  describe("resolveIdentity", () => {
    it("resolves owner identity", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });

      const identity = resolver.resolveIdentity("telegram", "owner-tg-123");
      expect(identity.role).toBe("owner");
      expect(identity.canonicalId).toBe("telegram:owner-tg-123");
      expect(identity.channel).toBe("telegram");
      expect(identity.senderId).toBe("owner-tg-123");
    });

    it("resolves admin identity", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
        admins: { telegram: ["admin-tg-789"] },
      });

      const identity = resolver.resolveIdentity("telegram", "admin-tg-789");
      expect(identity.role).toBe("admin");
    });

    it("resolves explicit user identity", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
        users: { telegram: ["user-tg-111"] },
      });

      const identity = resolver.resolveIdentity("telegram", "user-tg-111");
      expect(identity.role).toBe("user");
    });

    it("assigns readonly to unrecognized user in owner-only mode", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({ dmPolicy: "owner-only" }),
      });

      const identity = resolver.resolveIdentity("telegram", "unknown-user");
      expect(identity.role).toBe("readonly");
    });

    it("assigns readonly to unrecognized user in allowlist mode", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({ dmPolicy: "allowlist" }),
      });

      const identity = resolver.resolveIdentity("telegram", "unknown-user");
      expect(identity.role).toBe("readonly");
    });

    it("assigns user to unrecognized user in open mode", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({ dmPolicy: "open" }),
      });

      const identity = resolver.resolveIdentity("telegram", "unknown-user");
      expect(identity.role).toBe("user");
    });

    it("resolves owner on different channels independently", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });

      const tg = resolver.resolveIdentity("telegram", "owner-tg-123");
      expect(tg.role).toBe("owner");

      const dc = resolver.resolveIdentity("discord", "owner-dc-456");
      expect(dc.role).toBe("owner");

      // Same telegram owner ID on discord is not recognized
      const cross = resolver.resolveIdentity("discord", "owner-tg-123");
      expect(cross.role).not.toBe("owner");
    });

    it("converts numeric sender IDs to strings", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({
          owner: {
            identities: {
              telegram: [12345 as unknown as string],
              discord: [],
              whatsapp: [],
              signal: [],
              slack: [],
            },
          },
        }),
      });

      const identity = resolver.resolveIdentity("telegram", "12345");
      expect(identity.role).toBe("owner");
    });
  });

  describe("isOwner", () => {
    it("returns true for owner", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });
      expect(resolver.isOwner("telegram", "owner-tg-123")).toBe(true);
    });

    it("returns false for non-owner", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });
      expect(resolver.isOwner("telegram", "random-user")).toBe(false);
    });

    it("returns false for owner ID on wrong channel", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });
      expect(resolver.isOwner("discord", "owner-tg-123")).toBe(false);
    });
  });

  describe("isAdmin", () => {
    it("returns true for owner (owner >= admin)", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });
      expect(resolver.isAdmin("telegram", "owner-tg-123")).toBe(true);
    });

    it("returns true for admin", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
        admins: { telegram: ["admin-1"] },
      });
      expect(resolver.isAdmin("telegram", "admin-1")).toBe(true);
    });

    it("returns false for regular user", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig(),
      });
      expect(resolver.isAdmin("telegram", "random")).toBe(false);
    });
  });

  describe("policy accessors", () => {
    it("returns the configured DM policy", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({ dmPolicy: "allowlist" }),
      });
      expect(resolver.getDmPolicy()).toBe("allowlist");
    });

    it("returns the configured group policy", () => {
      const resolver = new IdentityResolver({
        securityConfig: makeSecurityConfig({ groupPolicy: "all" }),
      });
      expect(resolver.getGroupPolicy()).toBe("all");
    });
  });

  describe("fromConfig", () => {
    it("creates resolver from SecurityConfig", () => {
      const config = makeSecurityConfig();
      const resolver = IdentityResolver.fromConfig(config);
      expect(resolver.isOwner("telegram", "owner-tg-123")).toBe(true);
    });
  });
});
