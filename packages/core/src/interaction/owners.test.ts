import { describe, it, expect } from "vitest";
import { OwnerDirectory, interactionActor } from "./owners.js";

const none = { telegram: [], discord: [], whatsapp: [], signal: [], slack: [] };

describe("OwnerDirectory", () => {
  it("compares ids as strings, including numeric Telegram ids", () => {
    const owners = new OwnerDirectory({ ...none, telegram: [1001, " 1002 "] });
    expect(owners.isOwner("telegram", "1001")).toBe(true);
    expect(owners.isOwner("telegram", "1002")).toBe(true);
    expect(owners.isOwner("telegram", "1003")).toBe(false);
  });

  it("is per channel", () => {
    const owners = new OwnerDirectory({ ...none, discord: ["1001"] });
    expect(owners.isOwner("discord", "1001")).toBe(true);
    expect(owners.isOwner("telegram", "1001")).toBe(false);
    expect(owners.hasOwner("telegram")).toBe(false);
    expect(owners.hasOwner("discord")).toBe(true);
  });

  it("fails closed with no identities, empty ids or odd input", () => {
    for (const owners of [new OwnerDirectory(none), new OwnerDirectory(undefined), new OwnerDirectory(null)]) {
      expect(owners.isOwner("telegram", "")).toBe(false);
      expect(owners.isOwner("telegram", "1001")).toBe(false);
      expect(owners.primary()).toBeNull();
    }
    const withBlank = new OwnerDirectory({ ...none, telegram: ["", "  "] });
    expect(withBlank.isOwner("telegram", "")).toBe(false);
    expect(withBlank.hasOwner("telegram")).toBe(false);
    const owners = new OwnerDirectory({ ...none, telegram: ["1001"] });
    expect(owners.isOwner("telegram", undefined as unknown as string)).toBe(false);
    expect(owners.isOwner("telegram", " ")).toBe(false);
  });

  it("picks the primary DM: telegram, then discord, then slack", () => {
    expect(new OwnerDirectory({ ...none, slack: ["U1"], discord: ["D1"], telegram: [7, 8] }).primary()).toEqual({ channel: "telegram", chatId: "7" });
    expect(new OwnerDirectory({ ...none, slack: ["U1"], discord: ["D1"] }).primary()).toEqual({ channel: "discord", chatId: "D1" });
    expect(new OwnerDirectory({ ...none, slack: ["U1"] }).primary()).toEqual({ channel: "slack", chatId: "U1" });
    expect(new OwnerDirectory({ ...none, whatsapp: ["W1"] }).primary()).toBeNull();
  });

  it("builds actor strings", () => {
    const owners = new OwnerDirectory({ ...none, telegram: [1] });
    expect(interactionActor(owners, "telegram", "1")).toBe("owner:telegram:1");
    expect(interactionActor(owners, "telegram", "2")).toBe("user:telegram:2");
  });
});
