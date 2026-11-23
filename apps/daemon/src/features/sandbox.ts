import { homedir } from "node:os";
import {
  SANDBOX_CONTRIBUTOR_NAME,
  SANDBOX_CONTRIBUTOR_ORDER,
  SandboxController,
  createSandboxCommands,
  createSandboxContributor,
  createSandboxPathGuard,
  createSandboxStatusApp,
  runSandboxNativeProbe,
  type HeartbeatTickEvent,
} from "@kirie/core";
import { approvalEngineFor } from "./approvals.js";
import type { DaemonContext, FeatureSetup } from "./types.js";

const controllers = new WeakMap<DaemonContext, SandboxController>();

/** The sandbox controller of a running daemon (tests and later features). Undefined before setup ran. */
export function sandboxControllerFor(ctx: DaemonContext): SandboxController | undefined {
  return controllers.get(ctx);
}

/**
 * Sandboxed execution (item 10, PLAN C.10). Default `off`: the contributor
 * then leaves every option untouched and the gate passes everything.
 *
 * Setup registers the `sandbox` contributor (50), the `sandbox-path-guard`
 * gate (200), the `sandbox` prompt addendum, `/sandbox`, and the read-only
 * `/api/sandbox/status` route, and points the approval engine at the live
 * sandbox state. Start brings the docker container up when the mode is
 * docker (fail closed otherwise) and runs health checks on heartbeat ticks.
 */
export const setupSandbox: FeatureSetup = (ctx) => {
  const controller = new SandboxController({
    config: ctx.config.sandbox,
    settings: ctx.settings,
    dataDir: ctx.dataDir,
    agentCwd: ctx.agentCwd,
    home: homedir(),
    audit: ctx.audit,
    notifyOwner: (text) => { void ctx.notifyOwner(text); },
    sessions: ctx.v2Sessions,
    nativeProbe: (buildSettings) =>
      runSandboxNativeProbe({
        dataDir: ctx.dataDir,
        model: ctx.config.proactive.tier2Model,
        buildSettings,
        sdkOptions: ctx.sdkOptions,
      }),
  });
  controllers.set(ctx, controller);

  ctx.sdkOptions.registerContributor(
    SANDBOX_CONTRIBUTOR_NAME,
    createSandboxContributor({ source: controller, spawns: controller.spawns }),
    SANDBOX_CONTRIBUTOR_ORDER,
  );
  const gate = createSandboxPathGuard({ source: controller, spawns: controller.spawns, audit: ctx.audit, stats: controller.stats });
  ctx.sdkOptions.registerGate(gate);
  ctx.promptAddenda.register("sandbox", (p) => controller.addendum(p));
  ctx.commands.registerAll(createSandboxCommands({ controller }));
  ctx.internalApi.mount("sandbox", createSandboxStatusApp(controller));

  // The approval engine skips its built-in dangerous rules only for the docker
  // shell tool, only with network none, and only while the container is healthy.
  approvalEngineFor(ctx)?.setSandboxInfo(() => controller.approvalInfo());

  const onTick = (ev: HeartbeatTickEvent): void => controller.onTick(ev.tickNumber);

  return {
    name: "sandbox",
    async start() {
      await controller.start();
      ctx.heartbeat.on("tick", onTick);
    },
    async stop() {
      ctx.heartbeat.off("tick", onTick);
      ctx.sdkOptions.unregisterGate(gate.name);
      await controller.stop();
      controllers.delete(ctx);
    },
  };
};
