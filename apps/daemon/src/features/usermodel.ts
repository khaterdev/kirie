import { join } from "node:path";
import {
  USER_FACT_PROPOSAL_KIND,
  USER_MODEL_ENABLED_SETTING,
  USER_MODEL_INJECT_SETTING,
  USER_MODEL_QUERY_TOOL,
  USER_MODEL_TOOLS_ENV,
  createUserModelSystem,
  effectiveSettingFlag,
  type HeartbeatTickEvent,
  type SdkCallContext,
  type UserModelSystem,
} from "@kirie/core";
import { getLearningSystem } from "./learning.js";
import type { DaemonContext, FeatureSetup } from "./types.js";

/**
 * User model (item 5) (PLAN B.10, C.5). Owned by W3-UM.
 *
 * Off by default (`userModel.enabled`, runtime override via `/profile on`).
 * While off nothing is derived, the `user-model` addendum is empty and
 * `user_model_query` answers `{ enabled: false }`. When on:
 * - facts are derived only from the owner's own DM messages, through the
 *   no-tools one-shot runner on the same SDK options pipeline (same account)
 *   as the chats, on heartbeat ticks when the owner has been idle;
 * - the card goes only into the owner's DM chat prompt (background prompts
 *   only with `injectBackground`), never into a group or another sender's
 *   session, never into a voice call;
 * - with `requireApproval`, new or changed facts are filed as `user_fact.add`
 *   proposals and applied only through the owner's `/proposals` approval.
 *
 * `/profile` is the owner command. Nothing is mounted on the InternalApi or
 * the gateway; the query tool reads `learning.db` read-only in the stdio
 * subprocess, and the reserved-mcp gate denies it outside the owner's DM chat.
 */

const systems = new WeakMap<DaemonContext, UserModelSystem>();

/** `user_model_query` is callable only in the owner's own DM chat session. */
export function userModelQueryAllowed(c: SdkCallContext): boolean {
  return c.kind === "chat" && c.ownerDm && c.chatType === "dm" && c.channel !== "voice";
}

/** The running user model, for tests. Null before setup or after stop. */
export function getUserModelSystem(ctx: DaemonContext): UserModelSystem | null {
  return systems.get(ctx) ?? null;
}

export const setupUserModel: FeatureSetup = (ctx) => {
  const cfg = ctx.config.userModel;
  const enabled = (): boolean => effectiveSettingFlag(ctx.settings, USER_MODEL_ENABLED_SETTING, cfg.enabled);
  const inject = (): boolean => effectiveSettingFlag(ctx.settings, USER_MODEL_INJECT_SETTING, cfg.inject);

  const system = createUserModelSystem({
    dataDir: ctx.dataDir,
    chatHistoryPath: join(ctx.dataDir, "chat-history.db"),
    config: () => cfg,
    enabled,
    configEnabled: () => cfg.enabled,
    inject,
    configInject: () => cfg.inject,
    model: () => cfg.model ?? ctx.config.proactive.tier2Model,
    owners: ctx.owners,
    settings: ctx.settings,
    audit: ctx.audit,
    sharedEmbedder: ctx.embeddingProvider,
    intake: () => getLearningSystem(ctx)?.intake ?? null,
    digestLine: (text) => getLearningSystem(ctx)?.notifier.queueLine(text),
    closeSessions: () => { ctx.v2Sessions?.closeIdleSessions(0); },
    sdkOptions: ctx.sdkOptions,
  });
  systems.set(ctx, system);

  // The proposals kind is registered whatever the switch says, so pending
  // user_fact.add proposals stay approvable after /profile off.
  const learning = getLearningSystem(ctx);
  if (learning && !learning.applier.hasKind(USER_FACT_PROPOSAL_KIND)) {
    learning.applier.registerKind(USER_FACT_PROPOSAL_KIND, system.applyHandler);
  }

  // The query tool is in the global allow list (every feature tool is); this gate claim makes
  // the built-in reserved-mcp gate deny it everywhere but the owner's own DM chat.
  ctx.sdkOptions.claimMcpPrefix(USER_MODEL_QUERY_TOOL, userModelQueryAllowed);
  ctx.commands.registerAll(system.commands);
  ctx.promptAddenda.register("user-model", (p) => system.addendum(p));
  const unsubscribeTurns = ctx.pipeline.onTurnComplete((ev) => system.onTurnComplete(ev));
  // The stdio subprocess's user_model_query reads this (no secrets in it).
  ctx.kirieToolsEnv[USER_MODEL_TOOLS_ENV.config] = JSON.stringify(cfg);

  const onTick = (ev: HeartbeatTickEvent): void => system.onTick(ev.tickNumber);

  return {
    name: "usermodel",
    start() {
      system.refreshCard();
      ctx.heartbeat.on("tick", onTick);
    },
    stop() {
      ctx.heartbeat.off("tick", onTick);
      unsubscribeTurns();
      ctx.promptAddenda.unregister("user-model");
      systems.delete(ctx);
      system.close();
    },
  };
};
