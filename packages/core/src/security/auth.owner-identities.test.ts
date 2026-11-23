import { describe, it, expect } from "vitest";
import { IdentityResolver } from "./auth.js";
import type { SecurityConfig } from "../config/schema.js";

function resolver(): IdentityResolver {
  const securityConfig = {
    owner: { identities: { telegram: ["owner-tg-1"], discord: [], slack: [], whatsapp: [], signal: [] } },
    dmPolicy: "owner-only",
    groupPolicy: "mention-only",
  } as unknown as SecurityConfig;
  return new IdentityResolver({ securityConfig });
}

describe("IdentityResolver.addOwnerIdentities", () => {
  it("adds owner ids for a new channel", () => {
    const r = resolver();
    expect(r.resolveIdentity("voice", "+201001234567").role).toBe("readonly");
    r.addOwnerIdentities("voice", ["+201001234567"]);
    expect(r.resolveIdentity("voice", "+201001234567").role).toBe("owner");
    expect(r.isOwner("voice", "+201001234567")).toBe(true);
    expect(r.isOwner("voice", "+14155550100")).toBe(false);
  });

  it("keeps existing owners and ignores empty input", () => {
    const r = resolver();
    r.addOwnerIdentities("telegram", ["owner-tg-2", ""]);
    r.addOwnerIdentities("voice", []);
    expect(r.isOwner("telegram", "owner-tg-1")).toBe(true);
    expect(r.isOwner("telegram", "owner-tg-2")).toBe(true);
    expect(r.isOwner("telegram", "")).toBe(false);
    expect(r.isOwner("voice", "")).toBe(false);
  });

  it("does not grant the ids on another channel", () => {
    const r = resolver();
    r.addOwnerIdentities("voice", ["+201001234567"]);
    expect(r.isOwner("telegram", "+201001234567")).toBe(false);
  });
});
