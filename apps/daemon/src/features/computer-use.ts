import { homedir } from "node:os";
import {
  ComputerUseService,
  approvalSandboxInfoFrom,
  computerUsePromptAddendum,
  createComputerUseCommands,
  createComputerUseGate,
  createComputerUseStatusApp,
  createModuleLogger,
  defaultComputerUseExec,
  defaultComputerUseIsExecutable,
  isDangerousText,
  originOf,
  removeComputerUseServers,
  COMPUTER_USE_MCP_PREFIX,
  COMPUTER_USE_SETUP_DOC,
} from "@kirie/core";
import type { ComputerUseDriverDeps } from "@kirie/core";
import type { DaemonContext, FeatureSetup } from "./types.js";

const log = createModuleLogger("feature:computer-use");

export interface ComputerUseFeatureOptions {
  /** Driver process access (tests inject fakes; nothing real runs). */
  driver?: ComputerUseDriverDeps;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const services = new WeakMap<DaemonContext, ComputerUseService>();

/** The computer-use service of a running daemon (tests and later features). Undefined before setup ran. */
export function computerUseServiceFor(ctx: DaemonContext): ComputerUseService | undefined {
  return services.get(ctx);
}

/** How often, and how many times, a busy session is retried after a disarm (its driver child keeps running until then). */
const REFRESH_RETRY_MS = 30_000;
const REFRESH_MAX_ATTEMPTS = 120;

/**
 * Restart a v2 session so its next turn is spawned with the current
 * computer-use options. A busy session is retried every 30 s (up to an hour)
 * when `retry` is set, so a session that had the driver does not keep its
 * `cua-driver mcp` child after a disarm. The gates deny every call meanwhile.
 */
function refreshSession(ctx: DaemonContext, sessionKey: string, retry: boolean, attempt = 0): void {
  const v2 = ctx.v2Sessions;
  if (!v2) return;
  if (v2.isBusy(sessionKey)) {
    if (!retry || attempt >= REFRESH_MAX_ATTEMPTS) return;
    const t = setTimeout(() => refreshSession(ctx, sessionKey, retry, attempt + 1), REFRESH_RETRY_MS);
    t.unref?.();
    return;
  }
  void v2.closeAndWait(sessionKey, 5_000).catch((err: unknown) => {
    log.warn({ err, sessionKey }, "could not restart the session after a computer-use change");
  });
}

/**
 * Computer use (item 13, PLAN C.13). Three switches, all required: the macOS
 * grants on CuaDriver.app (the owner's), `computerUse.enabled` (read at start)
 * and the in-memory arming window (`/computer on`).
 *
 * Registered whatever the config says: the prefix claim (denies unless armed),
 * the options contributor (removes inherited cua servers and hides their tools
 * unless the spawn is the owner's DM while armed), the gate (policy and the
 * Bash tripwire), `/computer` (so `off` works as a kill switch) and the
 * read-only status route.
 */
export function createComputerUseSetup(opts: ComputerUseFeatureOptions = {}): FeatureSetup {
  return (ctx) => {
    const cfg = ctx.config.computerUse;

    // The driver is only ever added per spawn by the contributor, never to the shared map.
    const removed = removeComputerUseServers(ctx.mcpServers);
    if (removed.length > 0) {
      log.warn({ servers: removed }, "computer use: removed cua-driver MCP servers from config; Kirie adds the driver itself, only while armed");
    }

    const driver: ComputerUseDriverDeps = opts.driver ?? {
      exec: defaultComputerUseExec,
      isExecutable: defaultComputerUseIsExecutable,
      homeDir: homedir(),
    };

    const service = new ComputerUseService({
      config: cfg,
      driver,
      originOf: (c) => originOf(c, ctx.turnContext),
      isDangerousText: (text) => isDangerousText(text, { realpath: (p) => p }),
      audit: ctx.audit,
      prompts: ctx.ownerPrompts,
      sandboxMode: () => approvalSandboxInfoFrom(ctx.settings, ctx.config.sandbox).mode,
      onDisarmed: (reason, sessions) => {
        for (const key of sessions) refreshSession(ctx, key, true);
        if (reason === "timeout") void ctx.notifyOwner("Computer use window ended; desktop control is off again.");
      },
      ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
      ...(opts.clearTimer ? { clearTimer: opts.clearTimer } : {}),
    });
    services.set(ctx, service);

    ctx.sdkOptions.claimMcpPrefix(COMPUTER_USE_MCP_PREFIX, (c) => service.claimAllows(c));
    ctx.sdkOptions.registerContributor("computer-use", (options, c) => service.contribute(options, c), 60);
    ctx.sdkOptions.registerGate(createComputerUseGate(service));

    ctx.commands.registerAll(createComputerUseCommands({
      service,
      refreshSession: (key) => refreshSession(ctx, key, false),
    }));
    ctx.internalApi.mount("computer-use", createComputerUseStatusApp(service));
    ctx.promptAddenda.register("computer-use", (p) => computerUsePromptAddendum(cfg.enabled, p));

    return {
      name: "computer-use",
      start() {
        if (!cfg.enabled) return;
        // Not awaited: a hung driver command (5 s timeout each) must not delay the daemon's start.
        // Nothing depends on it: /computer on probes again before it arms.
        void service.probe().then((status) => {
          if (!status.healthy) {
            log.error({ problems: status.problems }, `computer use is enabled but the driver is not ready; see ${COMPUTER_USE_SETUP_DOC}`);
          } else {
            log.info({ version: status.version }, "computer use: driver ready (disarmed until /computer on)");
          }
        });
      },
      async stop() {
        await service.disarm("shutdown");
      },
    };
  };
}

export const setupComputerUse: FeatureSetup = createComputerUseSetup();
