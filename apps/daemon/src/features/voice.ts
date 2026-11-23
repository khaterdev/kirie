import { join } from "node:path";
import { createModuleLogger, parseSessionKey, VOICE_TOOLS_ENV_FLAG } from "@kirie/core";
import {
  VoiceService,
  applyVoiceToolProfile,
  createVoiceCommands,
  createVoiceInternalApi,
  loadVoiceCredentials,
  voicePromptAddendum,
} from "@kirie/channel-voice";
import { CallStore, type VoiceFetch } from "@kirie/voice";
import type { DaemonContext, FeatureHandle, FeatureSetup } from "./types.js";

const log = createModuleLogger("voice-feature");

/** Test seams. The daemon passes none. */
export interface VoiceFeatureOptions {
  fetch?: VoiceFetch;
  uid?: number;
  holdMs?: number;
}

/**
 * Voice calls, Twilio and Plivo (item 14, PLAN C.14).
 *
 * With `voice.enabled: false` (the default) nothing is constructed, registered,
 * mounted or callable. With it on:
 * - setup: the service (credentials through the one rule, both providers, the
 *   call store), /voice and /call, the voice-profile contributor, the voice
 *   prompt addendum, /api/voice on the control plane; when voice is already
 *   ready, the voice adapter and the owner's numbers for the security gate.
 * - start: closes call records left open by a restart and mounts the active
 *   provider's routes on the public ingress, only if it is ready and switched
 *   on. Not ready: one log line naming the provider and what is missing; the
 *   daemon starts normally.
 */
export function createVoiceFeature(opts: VoiceFeatureOptions = {}): FeatureSetup {
  return async (ctx: DaemonContext): Promise<FeatureHandle> => {
    const cfg = ctx.config.voice;
    if (!cfg.enabled) return { name: "voice" };

    let adapterRegistered = false;
    let started = false;
    const activate = async (active: boolean): Promise<void> => {
      if (active) ctx.kirieToolsEnv[VOICE_TOOLS_ENV_FLAG] = "1";
      else delete ctx.kirieToolsEnv[VOICE_TOOLS_ENV_FLAG];
      if (!active) return;
      if (!adapterRegistered) {
        ctx.identityResolver.addOwnerIdentities("voice", cfg.ownerNumbers);
        ctx.channelRegistry.register(service.adapter);
        adapterRegistered = true;
      }
      if (started && !ctx.channelRegistry.isRunning("voice")) await ctx.channelRegistry.start("voice");
    };

    const service: VoiceService = await VoiceService.create({
      config: cfg,
      loadCredentials: () => loadVoiceCredentials({
        config: cfg,
        voiceEnvPath: join(ctx.dataDir, "secrets", "voice.env"),
        credentials: ctx.credentialStore,
        ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      }),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ingress: ctx.ingress,
      settings: ctx.settings,
      store: new CallStore(join(ctx.dataDir, "voice-calls")),
      approvals: ctx.ownerPrompts,
      notifyOwner: (text, o) => ctx.notifyOwner(text, o),
      audit: ctx.audit,
      pipeline: {
        isBusy: (key) => ctx.pipeline.isBusy(key),
        addNextTurnNote: (key, note) => ctx.pipeline.addNextTurnNote(key, note),
      },
      addKnownSecret: (value, label) => ctx.scrubber.addKnownSecret(value, label),
      onActiveChange: activate,
      ...(opts.holdMs !== undefined ? { holdMs: opts.holdMs } : {}),
    });

    ctx.commands.registerAll(createVoiceCommands(service, { includeCall: true }));
    ctx.sdkOptions.registerContributor("voice-profile", (o, c) => applyVoiceToolProfile(o, c, cfg.agent.toolProfile), 70);
    ctx.promptAddenda.register("voice", voicePromptAddendum);
    ctx.internalApi.mount("voice", createVoiceInternalApi(service));

    const offComplete = ctx.pipeline.onTurnComplete((ev) => {
      if (ev.channel === "voice") service.flow.turnFinished(ev.senderId, ev.startedAt);
    });
    const offError = ctx.pipeline.onTurnError((ev) => {
      const parts = parseSessionKey(ev.sessionKey);
      if (parts?.channel === "voice") service.flow.turnFailed(parts.chatId);
    });

    // Register the adapter before channels start when voice is already usable.
    if (service.isActive()) await activate(true);

    return {
      name: "voice",
      async start() {
        started = true;
        await service.start();
        const provider = service.activeProvider();
        if (!service.isSwitchedOn()) {
          log.info({ provider }, "voice: enabled in config but switched off (/voice on)");
        } else if (!service.isActive()) {
          const r = service.readiness();
          log.error(
            { provider, missing: r.ready ? [] : r.missing, notes: service.credentialNotes(provider) },
            `voice: enabled in config but NOT started on ${provider}, missing: ${r.ready ? "" : r.missing.join(", ")}. See docs/voice-setup.md`,
          );
        } else {
          log.info({ provider }, "voice: ready");
        }
      },
      async stop() {
        offComplete();
        offError();
        await service.stop();
      },
    };
  };
}

export const setupVoice: FeatureSetup = createVoiceFeature();
