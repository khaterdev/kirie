import { join } from "node:path";
import {
  buildWebhookTaskProfile,
  createWebhookCommands,
  defaultOneShotCwd,
  effectiveSettingFlag,
  runOneShot,
  WEBHOOK_TASK_PROFILE,
  WebhookService,
  WebhookStore,
  type BackgroundTask,
} from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

/** Structured output of the `summarize` one-shot call. */
const SUMMARY_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
} as const;

function parseSummary(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as { summary?: unknown }).summary === "string") {
    return (value as { summary: string }).summary;
  }
  throw new Error("summary missing");
}

async function probeHealth(url: string): Promise<boolean> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  return res.ok && (await res.text()).trim() === "ok";
}

/**
 * Webhook triggers (item 6, PLAN C.6).
 *
 * Off by default. `/hooks` is mounted on the public ingress (127.0.0.1:18787)
 * only while `webhooks.enabled` is effective (config or `/webhook on`) AND at
 * least one hook is enabled, so the port is not bound before then. The
 * database and the secrets are not touched until the feature is on or the
 * owner uses `/webhook`.
 */
export const setupWebhooks: FeatureSetup = (ctx: DaemonContext) => {
  const cfg = () => ctx.config.webhooks;
  const isEnabled = (): boolean => effectiveSettingFlag(ctx.settings, "webhooks.enabled", cfg().enabled);

  const service = new WebhookService({
    openStore: () => new WebhookStore(join(ctx.dataDir, "webhooks.db")),
    config: cfg,
    secrets: ctx.credentialStore,
    registerKnownSecret: (value, label) => ctx.scrubber.addKnownSecret(value, label),
    audit: ctx.audit,
    notifyOwner: (text, opts) => ctx.notifyOwner(text, opts),
    sendToChat: async (channel, chatId, text) => {
      const adapter = ctx.channelRegistry.getById(channel);
      if (!adapter || !ctx.channelRegistry.isRunning(channel)) return false;
      await adapter.sendText({ ctx: { chatId }, text, plain: true });
      return true;
    },
    summarize: async ({ system, prompt, label }) => {
      const res = await runOneShot({
        kind: "oneshot",
        model: ctx.config.proactive.tier2Model,
        system,
        prompt,
        schema: SUMMARY_SCHEMA,
        parse: parseSummary,
        timeoutMs: 90_000,
        maxBudgetUsd: 0.25,
        label,
        sdkOptions: ctx.sdkOptions,
        cwd: defaultOneShotCwd(ctx.dataDir),
      });
      return res.value;
    },
    createTask: (sessionKey, description, prompt, meta) => ctx.backgroundTaskStore.create(sessionKey, description, prompt, meta),
    taskStatus: (id) => ctx.backgroundTaskStore.get(id)?.status ?? null,
    secretsDir: join(ctx.dataDir, "secrets"),
    publicBaseUrl: () => ctx.ingress.publicBaseUrl,
    trustedIpHeader: () => ctx.config.ingress.trustedIpHeader,
  });

  let loaded = false;
  let mounted = false;

  /** Mount /hooks and bind the listener exactly when webhooks are on and a hook is enabled. */
  async function reconcileListener(): Promise<void> {
    const want = isEnabled() && service.store.listHooks().some((h) => h.enabled);
    if (want) {
      if (!loaded) {
        await service.load();
        loaded = true;
      }
      if (!mounted) {
        ctx.ingress.mount("/hooks", service.ingressApp());
        mounted = true;
      }
      await ctx.ingress.ensureStarted();
    } else {
      if (mounted) {
        ctx.ingress.unmount("/hooks");
        mounted = false;
      }
      await ctx.ingress.stopIfIdle();
    }
  }

  /**
   * `full` only while the config flag, the hook's opt-in and its profile all
   * still say so. Any error answers "no": a throwing profile factory would make
   * the task manager fall back to the default (all-tools) background profile.
   */
  const fullAllowed = (task: BackgroundTask): boolean => {
    try {
      if (!cfg().allowFullProfile) return false;
      const hookId = task.meta?.data?.hookId;
      if (typeof hookId !== "string") return false;
      const hook = service.store.getHook(hookId);
      return hook !== null && hook.allowFull && hook.toolProfile === "full";
    } catch {
      return false;
    }
  };

  // Task hooks first, so a webhook task resumed at start always finds its restricted profile.
  ctx.taskHooks.registerProfile(WEBHOOK_TASK_PROFILE, (task) =>
    buildWebhookTaskProfile(task.meta?.data?.toolProfile, {
      fullAllowed: fullAllowed(task),
      kirieToolsServer: ctx.mcpServers["kirie-tools"],
    }));
  // The stored prompt is the framed webhook_event block; it replaces the generic
  // "use every tool you have" background-task message.
  ctx.taskHooks.registerController(WEBHOOK_TASK_PROFILE, () => ({
    initialMessage: (task) => task.prompt,
    onTurnResult: async () => ({ action: "finish" }),
  }));
  ctx.taskHooks.registerCompletionHandler(WEBHOOK_TASK_PROFILE, (task) => service.onTaskCompleted(task));
  ctx.taskHooks.registerFailureHandler(WEBHOOK_TASK_PROFILE, (task) => service.onTaskFailed(task));

  ctx.commands.registerAll(createWebhookCommands({
    service,
    config: cfg,
    isEnabled,
    setEnabled: async (enabled, by) => {
      ctx.settings.set("webhooks.enabled", enabled, by);
      await reconcileListener();
    },
    onHooksChanged: reconcileListener,
    listener: () => ({
      listening: mounted && ctx.ingress.isListening(),
      port: ctx.ingress.port,
      publicBaseUrl: ctx.ingress.publicBaseUrl,
    }),
    probeHealth,
    audit: ctx.audit,
  }));

  return {
    name: "webhooks",
    start: async () => {
      service.sweepSecretFiles();
      if (isEnabled()) await reconcileListener();
    },
    stop: async () => {
      if (mounted) {
        ctx.ingress.unmount("/hooks");
        mounted = false;
      }
      service.stop();
    },
  };
};
