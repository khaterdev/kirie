import { describe, it, expect } from "vitest";
import { AuthorizationEngine } from "./authz.js";
import type { ResolvedIdentity, Role } from "./auth.js";

function makeIdentity(role: Role, channel = "telegram", senderId = "user-1"): ResolvedIdentity {
  return {
    role,
    canonicalId: `${channel}:${senderId}`,
    channel,
    senderId,
  };
}

describe("AuthorizationEngine", () => {
  describe("role hierarchy", () => {
    it("owner can perform all actions", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const owner = makeIdentity("owner");

      expect(engine.authorize(owner, "message").allowed).toBe(true);
      expect(engine.authorize(owner, "command").allowed).toBe(true);
      expect(engine.authorize(owner, "tool_invoke").allowed).toBe(true);
      expect(engine.authorize(owner, "admin_command").allowed).toBe(true);
      expect(engine.authorize(owner, "config_change").allowed).toBe(true);
    });

    it("admin can perform message, command, tool_invoke", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const admin = makeIdentity("admin");

      expect(engine.authorize(admin, "message").allowed).toBe(true);
      expect(engine.authorize(admin, "command").allowed).toBe(true);
      expect(engine.authorize(admin, "tool_invoke").allowed).toBe(true);
    });

    it("admin cannot perform admin_command or config_change", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const admin = makeIdentity("admin");

      const r1 = engine.authorize(admin, "admin_command");
      expect(r1.allowed).toBe(false);
      expect(r1.reason).toContain("owner");

      const r2 = engine.authorize(admin, "config_change");
      expect(r2.allowed).toBe(false);
    });

    it("user can send messages", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const user = makeIdentity("user");
      expect(engine.authorize(user, "message").allowed).toBe(true);
    });

    it("user cannot perform command or tool_invoke without whitelist", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const user = makeIdentity("user");

      expect(engine.authorize(user, "command").allowed).toBe(false);
      expect(engine.authorize(user, "tool_invoke").allowed).toBe(false);
    });

    it("user can invoke whitelisted tools", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
        userAllowedTools: ["memory_store", "memory_recall"],
      });
      const user = makeIdentity("user");

      const r1 = engine.authorize(user, "tool_invoke", { toolName: "memory_store" });
      expect(r1.allowed).toBe(true);

      const r2 = engine.authorize(user, "tool_invoke", { toolName: "memory_recall" });
      expect(r2.allowed).toBe(true);

      const r3 = engine.authorize(user, "tool_invoke", { toolName: "admin_tool" });
      expect(r3.allowed).toBe(false);
    });

    it("readonly cannot perform any action", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });
      const readonly = makeIdentity("readonly");

      expect(engine.authorize(readonly, "message").allowed).toBe(false);
      expect(engine.authorize(readonly, "command").allowed).toBe(false);
      expect(engine.authorize(readonly, "tool_invoke").allowed).toBe(false);
      expect(engine.authorize(readonly, "admin_command").allowed).toBe(false);
      expect(engine.authorize(readonly, "config_change").allowed).toBe(false);
    });
  });

  describe("DM policy enforcement", () => {
    it("owner-only: only owner can DM", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "owner-only",
        groupPolicy: "all",
      });

      const owner = makeIdentity("owner");
      const admin = makeIdentity("admin");

      expect(engine.authorize(owner, "message", { chatType: "dm" }).allowed).toBe(true);
      const r = engine.authorize(admin, "message", { chatType: "dm" });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("owner-only");
    });

    it("allowlist: readonly users cannot DM", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "allowlist",
        groupPolicy: "all",
      });

      const user = makeIdentity("user");
      const readonly = makeIdentity("readonly");

      expect(engine.authorize(user, "message", { chatType: "dm" }).allowed).toBe(true);

      const r = engine.authorize(readonly, "message", { chatType: "dm" });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("allowlist");
    });

    it("open: all roles can DM (except readonly which fails role check)", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });

      expect(engine.authorize(makeIdentity("user"), "message", { chatType: "dm" }).allowed).toBe(true);
    });
  });

  describe("Group policy enforcement", () => {
    it("disabled: no one can interact in groups", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "disabled",
      });

      const owner = makeIdentity("owner");
      const r = engine.authorize(owner, "message", { chatType: "group" });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain("disabled");
    });

    it("disabled: no one can interact in threads", () => {
      const engine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "disabled",
      });

      const r = engine.authorize(makeIdentity("owner"), "message", { chatType: "thread" });
      expect(r.allowed).toBe(false);
    });

    it("mention-only and all: pass through to role check", () => {
      const mentionEngine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "mention-only",
      });
      const allEngine = new AuthorizationEngine({
        dmPolicy: "open",
        groupPolicy: "all",
      });

      const user = makeIdentity("user");
      expect(mentionEngine.authorize(user, "message", { chatType: "group" }).allowed).toBe(true);
      expect(allEngine.authorize(user, "message", { chatType: "group" }).allowed).toBe(true);
    });
  });

  describe("static methods", () => {
    it("hasMinRole checks role hierarchy", () => {
      expect(AuthorizationEngine.hasMinRole("owner", "owner")).toBe(true);
      expect(AuthorizationEngine.hasMinRole("owner", "admin")).toBe(true);
      expect(AuthorizationEngine.hasMinRole("admin", "admin")).toBe(true);
      expect(AuthorizationEngine.hasMinRole("admin", "owner")).toBe(false);
      expect(AuthorizationEngine.hasMinRole("user", "admin")).toBe(false);
      expect(AuthorizationEngine.hasMinRole("readonly", "user")).toBe(false);
    });

    it("compareRoles returns correct ordering", () => {
      expect(AuthorizationEngine.compareRoles("owner", "admin")).toBeGreaterThan(0);
      expect(AuthorizationEngine.compareRoles("admin", "admin")).toBe(0);
      expect(AuthorizationEngine.compareRoles("user", "admin")).toBeLessThan(0);
      expect(AuthorizationEngine.compareRoles("readonly", "owner")).toBeLessThan(0);
    });

    it("getPermittedActions returns correct actions for each role", () => {
      const ownerActions = AuthorizationEngine.getPermittedActions("owner");
      expect(ownerActions).toContain("message");
      expect(ownerActions).toContain("admin_command");
      expect(ownerActions).toContain("config_change");

      const adminActions = AuthorizationEngine.getPermittedActions("admin");
      expect(adminActions).toContain("message");
      expect(adminActions).toContain("command");
      expect(adminActions).not.toContain("admin_command");

      const userActions = AuthorizationEngine.getPermittedActions("user");
      expect(userActions).toContain("message");
      expect(userActions).not.toContain("command");

      const readonlyActions = AuthorizationEngine.getPermittedActions("readonly");
      expect(readonlyActions).toHaveLength(0);
    });
  });
});
