import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v3";
import type { UserModelConfig } from "../../config/sections/usermodel.js";
import { RuntimeSettings } from "../../config/runtime-settings.js";
import { effectiveSettingFlag } from "../../config/sections/effective.js";
import { PromptAddenda, appendPromptAddenda } from "../../engine/prompt-addenda.js";
import { buildBackgroundTaskSystemPrompt, buildPrompt } from "../../engine/prompt-builder.js";
import type { OneShotRunner } from "../reflection.js";
import { fakeAudit } from "../learning.test-util.js";
import { USER_MODEL_CHECK_TICKS, createUserModelSystem, type UserModelSystem } from "./system.js";
import { OWNER_ID, tempUserModelEnv, testOwners, userModelConfig, type TempUserModelEnv } from "./usermodel.test-util.js";

let env: TempUserModelEnv | null = null;
let system: UserModelSystem | null = null;
afterEach(() => {
  system?.close();
  system = null;
  env?.cleanup();
  env = null;
});

const NOW = new Date("2026-11-23T12:00:00Z");

function make(cfgOver: Partial<UserModelConfig> = {}) {
  env = tempUserModelEnv();
  const cfg = userModelConfig(cfgOver);
  const settings = new RuntimeSettings(join(env.dir, "state", "runtime-settings.json"));
  const runner = vi.fn(async () => ({ value: { ops: [] }, costUsd: 0.001 }));
  const digest: string[] = [];
  system = createUserModelSystem({
    dataDir: env.dir,
    chatHistoryPath: env.historyPath,
    config: () => cfg,
    enabled: () => effectiveSettingFlag(settings, "userModel.enabled", cfg.enabled),
    configEnabled: () => cfg.enabled,
    inject: () => effectiveSettingFlag(settings, "userModel.inject", cfg.inject),
    configInject: () => cfg.inject,
    model: () => "utility-model",
    owners: testOwners,
    settings,
    audit: fakeAudit(),
    sharedEmbedder: null,
    embedderOptions: { localAvailable: () => false },
    intake: () => null,
    digestLine: (t) => digest.push(t),
    runner: runner as unknown as OneShotRunner,
    now: () => NOW,
  });
  system.store.insert({ category: "communication", statement: "Prefers short replies", kind: "explicit", confidence: 0.7, evidence: [], now: NOW });
  system.store.insert({ category: "preference", statement: "Maybe likes jazz", kind: "inferred", confidence: 0.4, evidence: [], now: NOW });
  system.refreshCard();
  return { system, settings, runner, digest };
}

const OWNER_DM_CTX = { kind: "chat" as const, channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true };

describe("user model addendum (the card reaches only the owner's own DM)", () => {
  it("is absent while the model is off (the default)", () => {
    const { system } = make();
    expect(system.addendum(OWNER_DM_CTX)).toBeNull();
  });

  it("is present for the owner in their DM when on, and contains only card-eligible facts", () => {
    const { system } = make({ enabled: true });
    const text = system.addendum(OWNER_DM_CTX)!;
    expect(text).toContain("<user_model");
    expect(text).toContain("Prefers short replies");
    expect(text).not.toContain("jazz");
  });

  it("is absent for another sender, a group, a voice call, with inject off, and in background prompts by default", () => {
    const { system, settings } = make({ enabled: true });
    expect(system.addendum({ ...OWNER_DM_CTX, senderRole: "user", ownerDm: false })).toBeNull();
    expect(system.addendum({ ...OWNER_DM_CTX, chatType: "group", ownerDm: false })).toBeNull();
    // Even a context that claims ownerDm for a group is refused.
    expect(system.addendum({ ...OWNER_DM_CTX, chatType: "group" })).toBeNull();
    expect(system.addendum({ ...OWNER_DM_CTX, senderRole: "user" })).toBeNull();
    expect(system.addendum({ ...OWNER_DM_CTX, channel: "voice" })).toBeNull();
    expect(system.addendum({ kind: "background", ownerDm: false })).toBeNull();
    settings.set("userModel.inject", false, "test");
    expect(system.addendum(OWNER_DM_CTX)).toBeNull();
  });

  it("goes into background prompts only with injectBackground", () => {
    const { system } = make({ enabled: true, injectBackground: true });
    expect(system.addendum({ kind: "background", ownerDm: false })).toContain("Prefers short replies");
  });

  it("through the real prompt builder: in the owner's DM prompt, not in a stranger's, a group's or the background prompt", () => {
    const { system } = make({ enabled: true });
    const addenda = new PromptAddenda();
    addenda.register("user-model", (p) => system.addendum(p));
    const config = { dataDir: env!.dir, addenda, maxTurns: 10, model: "m" };
    const prompt = (role: "owner" | "user", chatType: "dm" | "group"): string =>
      buildPrompt({
        config,
        channel: { channel: "telegram", chatType, chatId: chatType === "dm" ? OWNER_ID : "-5" },
        sender: { name: "x", platformId: role === "owner" ? OWNER_ID : "2002", role },
      }).systemPrompt.append;
    expect(prompt("owner", "dm")).toContain("Prefers short replies");
    expect(prompt("user", "dm")).not.toContain("Prefers short replies");
    expect(prompt("owner", "group")).not.toContain("Prefers short replies");
    expect(buildBackgroundTaskSystemPrompt(config)).not.toContain("Prefers short replies");
    expect(appendPromptAddenda("base", addenda, { kind: "chat", ownerDm: false })).toBe("base");
  });

  it("USER.md mirrors the card, 0600", () => {
    make({ enabled: true });
    const path = join(env!.dir, "USER.md");
    expect(readFileSync(path, "utf8")).toContain("Prefers short replies");
    expect(readFileSync(path, "utf8")).not.toContain("jazz");
  });
});

describe("user model heartbeat", () => {
  it("never derives while off, whatever the tick", async () => {
    const { system, runner } = make();
    env!.addRow({ content: "hello", createdAt: "2026-11-20 10:00:00" });
    for (let t = 1; t <= 10; t++) system.onTick(t * USER_MODEL_CHECK_TICKS);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner).not.toHaveBeenCalled();
  });

  it("when on, a tick with enough idle owner messages runs the deriver and queues a digest line", async () => {
    const { system, runner, digest } = make({ enabled: true, minNewMessages: 2, minHoursBetweenRuns: 0 });
    const a = env!.addRow({ content: "I prefer short replies", createdAt: "2026-11-20 10:00:00" });
    env!.addRow({ content: "and I use pnpm", createdAt: "2026-11-20 10:01:00" });
    runner.mockImplementation((async () => ({
      value: { ops: [{ op: "add", category: "tooling", statement: "Uses pnpm", kind: "explicit", evidence: [`c:${a}`] }] },
      costUsd: 0.001,
    })) as never);
    system.onTick(USER_MODEL_CHECK_TICKS - 1);
    expect(runner).not.toHaveBeenCalled();
    system.onTick(USER_MODEL_CHECK_TICKS);
    await vi.waitFor(() => expect(digest).toHaveLength(1));
    expect(digest[0]).toBe("User model: +1 fact. /profile recent");
    expect(system.card()).toContain("Uses pnpm");
  });

  it("the card file is left alone when there is nothing to write and no file", () => {
    env = tempUserModelEnv();
    const settings = new RuntimeSettings(join(env.dir, "state", "rs.json"));
    system = createUserModelSystem({
      dataDir: env.dir, chatHistoryPath: env.historyPath, config: () => userModelConfig(), enabled: () => false, configEnabled: () => false,
      inject: () => true, configInject: () => true, model: () => "m", owners: testOwners, settings, audit: fakeAudit(),
      sharedEmbedder: null, embedderOptions: { localAvailable: () => false }, intake: () => null,
    });
    system.refreshCard();
    expect(existsSync(join(env.dir, "USER.md"))).toBe(false);
    expect(settings.get("userModel.enabled", z.boolean())).toBeUndefined();
  });
});
