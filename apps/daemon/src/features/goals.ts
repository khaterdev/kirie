import { join } from "node:path";
import {
  createGoalCommands,
  createGoalJudge,
  createModuleLogger,
  defaultOneShotCwd,
  effectiveSettingFlag,
  GOAL_SETTING_KEY,
  GOAL_TASK_PROFILE,
  GoalController,
  GoalStore,
  parseSessionKey,
  type ChannelName,
  type SdkCallContext,
} from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

const log = createModuleLogger("goals-feature");

/**
 * One GoalStore per database file for the life of the process, so an
 * in-process restart reuses the connection instead of leaking one. The store
 * is never closed while a worker or the stdio subprocess may still use it.
 */
const stores = new Map<string, GoalStore>();

function openGoalStore(path: string): GoalStore {
  let store = stores.get(path);
  if (!store) {
    store = new GoalStore(path);
    stores.set(path, store);
  }
  return store;
}

/** One plain message to a goal's chat, through the adapter (which scrubs it). */
async function sendToGoalChat(ctx: DaemonContext, sessionKey: string, text: string): Promise<void> {
  const parts = parseSessionKey(sessionKey);
  if (!parts) {
    log.warn("goal message not sent: invalid session key");
    return;
  }
  const channel = parts.channel as ChannelName;
  const adapter = ctx.channelRegistry.getById(channel);
  if (!adapter || !ctx.channelRegistry.isRunning(channel)) {
    log.warn({ channel }, "goal message not sent: channel is not running");
    return;
  }
  await adapter.sendText({ ctx: { chatId: parts.chatId }, text, plain: true });
}

function checkCallContext(sessionKey: string, cwd: string): SdkCallContext {
  const parts = parseSessionKey(sessionKey);
  return {
    kind: "goal",
    sessionKey,
    ...(parts ? { channel: parts.channel, chatType: parts.chatType } : {}),
    ownerDm: false,
    interactive: false,
    label: "goal check command",
    cwd,
  };
}

/**
 * /goal judge loop (item 7, PLAN C.7). Ships off: `/goal on` sets the
 * `goals.enabled` runtime override. Registers the goal worker's controller,
 * profile and outcome handlers in TaskHooks, the /goal command, and a 2 s
 * poll (started in phase 2) that starts queued goals, asks the owner about
 * agent-created ones, enforces deadlines and applies goal_stop requests.
 */
export const setupGoals: FeatureSetup = (ctx) => {
  const config = () => ctx.config.goals;
  const isEnabled = () => effectiveSettingFlag(ctx.settings, GOAL_SETTING_KEY, ctx.config.goals.enabled);
  const store = openGoalStore(join(ctx.dataDir, "goals.db"));

  const controller = new GoalController({
    store,
    tasks: ctx.backgroundTaskStore,
    taskManager: ctx.backgroundTaskManager,
    config,
    isEnabled,
    judge: createGoalJudge({
      model: ctx.config.goals.judgeModel ?? ctx.config.proactive.tier2Model,
      sdkOptions: ctx.sdkOptions,
      cwd: defaultOneShotCwd(ctx.dataDir),
    }),
    evaluateCheck: (command, c) =>
      ctx.sdkOptions.evaluate({ tool: "Bash", input: { command }, cwd: c.cwd, ctx: checkCallContext(c.sessionKey, c.cwd) }),
    ask: (req) => ctx.ownerPrompts.ask(req),
    askTimeoutMs: ctx.config.commands.promptTimeoutSeconds * 1000,
    sendToChat: (sessionKey, text) => sendToGoalChat(ctx, sessionKey, text),
    audit: ctx.audit,
    defaultCwd: ctx.agentCwd,
  });

  ctx.taskHooks.registerController(GOAL_TASK_PROFILE, (task) => controller.taskController(task));
  ctx.taskHooks.registerProfile(GOAL_TASK_PROFILE, (task) => controller.taskProfile(task));
  ctx.taskHooks.registerCompletionHandler(GOAL_TASK_PROFILE, (task) => controller.onTaskCompleted(task));
  ctx.taskHooks.registerFailureHandler(GOAL_TASK_PROFILE, (task) => controller.onTaskFailed(task));

  ctx.commands.registerAll(
    createGoalCommands({ controller, settings: ctx.settings, isEnabled, config, defaultCwd: ctx.agentCwd }),
  );

  // Before the task manager resumes tasks (phase 1 runs first).
  controller.reconcileOnStartup();
  controller.syncSwitches();
  const unsubscribe = ctx.settings.onChange(GOAL_SETTING_KEY, () => controller.syncSwitches());

  return {
    name: "goals",
    start: () => controller.start(),
    stop: () => {
      unsubscribe();
      controller.shutdown();
    },
  };
};
