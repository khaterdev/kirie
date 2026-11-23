/**
 * `createUserModelSystem`: builds the user model from its dependencies (PLAN
 * C.5). The daemon feature module (`apps/daemon/src/features/usermodel.ts`)
 * calls it once per start and registers what it returns: the `/profile`
 * command, the `user-model` prompt addendum, the turn listener, the heartbeat
 * handler and the `user_fact.add` proposal kind.
 *
 * Off by default (`userModel.enabled`): while off, nothing is derived, the
 * addendum is empty and the query tool answers `{ enabled: false }`.
 */

import { join } from "node:path";
import type { EmbeddingProvider } from "@kirie/memory";
import type { ChannelName } from "../../channels/normalizer.js";
import type { CommandDefinition } from "../../commands/types.js";
import type { RuntimeSettings } from "../../config/runtime-settings.js";
import type { UserModelConfig } from "../../config/sections/usermodel.js";
import type { PromptAddendumContext } from "../../engine/prompt-addenda.js";
import type { SdkOptionsPipeline } from "../../engine/sdk-options.js";
import { createModuleLogger } from "../../logging/logger.js";
import type { TurnCompleteEvent } from "../../routing/pipeline.js";
import type { AuditTrail } from "../../security/audit-trail.js";
import type { ProposalKindHandler } from "../applier.js";
import type { ProposalIntake } from "../intake.js";
import { LearningKv, learningDbPath, openLearningDb, type LearningDb } from "../learning-db.js";
import type { OneShotRunner } from "../reflection.js";
import { createUserFactApplyHandler } from "./apply.js";
import { renderUserModelAddendum, renderUserModelCard, userModelCardPath, writeUserModelCard } from "./card.js";
import { createUserModelCommands } from "./commands.js";
import { USER_MODEL_CONSOLIDATE_EVERY_DAYS, consolidateUserModel } from "./consolidate.js";
import { UserModelDeriver } from "./deriver.js";
import { selectUserModelEmbedder, type UserModelEmbedderChoice, type UserModelEmbedderOptions } from "./embedder.js";
import { UserFactStore } from "./fact-store.js";
import { retireUserFactProposals } from "./proposals.js";
import { openUserModelHistorySource, type UserModelHistorySource } from "./source.js";

const log = createModuleLogger("usermodel");

/** Heartbeat ticks are 10 s apart: the run check every 10 minutes. */
export const USER_MODEL_CHECK_TICKS = 60;
const CONSOLIDATED_KEY = "usermodel:last_consolidated_at";
const DAY_MS = 86_400_000;

export interface UserModelSystemDeps {
  /** ~/.kirie */
  dataDir: string;
  /** Default `<dataDir>/learning.db` */
  dbPath?: string;
  /** Default `<dataDir>/chat-history.db`, opened read-only */
  chatHistoryPath?: string;
  /** Default `<dataDir>/USER.md` */
  cardPath?: string;
  config: () => UserModelConfig;
  /** Effective and configured `userModel.enabled` */
  enabled: () => boolean;
  configEnabled: () => boolean;
  /** Effective and configured `userModel.inject` */
  inject: () => boolean;
  configInject: () => boolean;
  /** `userModel.model ?? proactive.tier2Model` */
  model: () => string;
  owners: { isOwner(channel: ChannelName, senderId: string): boolean };
  settings: Pick<RuntimeSettings, "set" | "delete">;
  audit: Pick<AuditTrail, "record">;
  /** The daemon's embedding provider (reused only when it is the local model) */
  sharedEmbedder: EmbeddingProvider | null;
  /** `requireApproval`: the learning system's intake, or null */
  intake: () => ProposalIntake | null;
  /** One line in the next proposals digest */
  digestLine?: (text: string) => void;
  /** Close idle chat sessions so a removed card stops reaching the owner's live session */
  closeSessions?: () => void;
  sdkOptions?: SdkOptionsPipeline;
  /** Test seams */
  runner?: OneShotRunner;
  history?: UserModelHistorySource;
  embedderOptions?: Pick<UserModelEmbedderOptions, "localAvailable" | "createLocal">;
  now?: () => Date;
}

export interface UserModelSystem {
  readonly db: LearningDb;
  readonly kv: LearningKv;
  readonly store: UserFactStore;
  readonly deriver: UserModelDeriver;
  readonly history: UserModelHistorySource;
  readonly applyHandler: ProposalKindHandler;
  readonly commands: CommandDefinition[];
  /** The `user-model` prompt addendum */
  addendum(ctx: PromptAddendumContext): string | null;
  /** Pipeline turn listener: owner turns only feed idle tracking */
  onTurnComplete(ev: TurnCompleteEvent): void;
  /** Heartbeat tick: derivation check every 10 minutes, consolidation weekly */
  onTick(tickNumber: number): void;
  /** Current card body */
  card(): string;
  /** Re-render the card and USER.md */
  refreshCard(opts?: { closeSessions?: boolean }): void;
  embedderSource(): UserModelEmbedderChoice["source"];
  close(): void;
}

export function createUserModelSystem(deps: UserModelSystemDeps): UserModelSystem {
  const db = openLearningDb(deps.dbPath ?? learningDbPath(deps.dataDir));
  const kv = new LearningKv(db);
  const store = new UserFactStore(db);
  const history = deps.history ?? openUserModelHistorySource(deps.chatHistoryPath ?? join(deps.dataDir, "chat-history.db"));
  const cardPath = deps.cardPath ?? userModelCardPath(deps.dataDir);
  const now = (): Date => deps.now?.() ?? new Date();

  let choice: UserModelEmbedderChoice | null = null;
  const embedderChoice = (): UserModelEmbedderChoice =>
    (choice ??= selectUserModelEmbedder({
      allowRemote: deps.config().allowRemoteEmbeddings,
      shared: deps.sharedEmbedder,
      ...deps.embedderOptions,
    }));
  const embedder = (): EmbeddingProvider | null => embedderChoice().provider;

  let cardText = "";
  const renderCard = (): string => renderUserModelCard(store.list({ status: "active" }), deps.config().promptBudgetChars);
  const refreshCard = (opts: { closeSessions?: boolean } = {}): void => {
    try {
      cardText = renderCard();
      // Written even while off, so a forgotten statement never lingers in USER.md.
      writeUserModelCard(cardPath, cardText);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "user model card refresh failed");
    }
    if (opts.closeSessions) {
      try {
        deps.closeSessions?.();
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err) }, "closing idle sessions failed");
      }
    }
  };
  cardText = renderCard();

  const deriver = new UserModelDeriver({
    db,
    store,
    kv,
    history,
    owners: deps.owners,
    config: deps.config,
    enabled: deps.enabled,
    model: deps.model,
    embedder,
    intake: deps.intake,
    cwd: join(deps.dataDir, "tmp", "oneshot"),
    ...(deps.sdkOptions ? { sdkOptions: deps.sdkOptions } : {}),
    ...(deps.runner ? { runner: deps.runner } : {}),
    audit: deps.audit,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const applyHandler = createUserFactApplyHandler({
    store,
    config: deps.config,
    embedder,
    onChanged: () => refreshCard(),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const commands = createUserModelCommands({
    store,
    deriver,
    kv,
    history,
    settings: deps.settings,
    audit: deps.audit,
    enabled: deps.enabled,
    configEnabled: deps.configEnabled,
    inject: deps.inject,
    configInject: deps.configInject,
    config: deps.config,
    card: () => cardText,
    refresh: refreshCard,
    embedder,
    embedderSource: () => embedderChoice().source,
    retireProposals: (hashes) => retireUserFactProposals(db, hashes, now()),
    ...(deps.now ? { now: deps.now } : {}),
  });

  const afterRun = (r: Awaited<ReturnType<UserModelDeriver["run"]>>): void => {
    if (r.changed.length === 0 && r.counts.proposed === 0) return;
    refreshCard();
    if (r.reason === "interrupted") return;
    const c = r.counts;
    const parts: string[] = [];
    if (c.added > 0) parts.push(`+${c.added} fact${c.added === 1 ? "" : "s"}`);
    if (c.updated > 0) parts.push(`${c.updated} updated`);
    if (c.proposed > 0) parts.push(`${c.proposed} awaiting approval`);
    if (parts.length > 0) deps.digestLine?.(`User model: ${parts.join(", ")}. /profile recent`);
  };

  let checking = false;
  const runCheck = async (): Promise<void> => {
    if (checking) return;
    checking = true;
    try {
      const last = Date.parse(kv.get(CONSOLIDATED_KEY) ?? "");
      if (deps.enabled() && (!Number.isFinite(last) || now().getTime() - last >= USER_MODEL_CONSOLIDATE_EVERY_DAYS * DAY_MS)) {
        const r = consolidateUserModel(store, now());
        kv.set(CONSOLIDATED_KEY, now().toISOString());
        if (r.merged + r.decayed + r.suppressed > 0) {
          deps.audit.record({ feature: "usermodel", action: "consolidate", actor: "system", detail: { ...r } });
          refreshCard();
        }
      }
      const r = await deriver.maybeRun();
      if (r) afterRun(r);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "user model check failed");
    } finally {
      checking = false;
    }
  };

  return {
    db,
    kv,
    store,
    deriver,
    history,
    applyHandler,
    commands,
    addendum(ctx) {
      if (!deps.enabled() || !deps.inject()) return null;
      if (ctx.channel === "voice") return null;
      if (ctx.kind === "chat") {
        // Only the owner's own DM: never a group, never another sender.
        if (!ctx.ownerDm || ctx.chatType !== "dm" || ctx.senderRole !== "owner") return null;
      } else if (!deps.config().injectBackground) {
        return null;
      }
      return renderUserModelAddendum(cardText);
    },
    onTurnComplete(ev) {
      if (ev.origin !== "owner_message") return;
      deriver.noteOwnerTurn(ev.endedAt);
    },
    onTick(tickNumber) {
      if (tickNumber % USER_MODEL_CHECK_TICKS !== 0) return;
      if (!deps.enabled()) return;
      void runCheck();
    },
    card: () => cardText,
    refreshCard,
    embedderSource: () => embedderChoice().source,
    close() {
      history.close();
      db.close();
    },
  };
}
