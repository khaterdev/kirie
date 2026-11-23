/**
 * VoiceAdapter: the phone call as a Kirie channel (id "voice").
 *
 * Inbound: the call flow emits one UnifiedMessage per spoken turn of an owner
 * number (channel "voice", chatType "dm", chatId and senderId the caller's
 * E.164, id "voice-<token>-<turn>"). Nobody else ever produces a message.
 *
 * Outbound: the pipeline answers with sendText. A reply that belongs to the
 * live turn (its replyToId is that turn's message id) is spoken. Anything else
 * (a deferred turn, a call that already ended, an unsolicited result) is
 * forwarded to the owner's Telegram DM, prefixed "From your call:". Text
 * reaching sendText has already passed the registry's outbound scrubber.
 *
 * The adapter names no provider.
 */

import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  MessageListener,
  SendTextParams,
  SendTypingParams,
  SentMessage,
  UnifiedMessage,
} from "@kirie/core";
import { createModuleLogger } from "@kirie/core";
import { parseVoiceTurnMessageId } from "./session.js";
import type { VoiceTurnEmission } from "./flow.js";

const log = createModuleLogger("voice-adapter");

export interface VoiceAdapterDeps {
  /** True when the reply answered a live turn. */
  deliverReply(turnRef: { token: string; turn: number } | null, text: string): boolean;
  /** Forward text to the owner's DM on the primary channel. */
  forwardToOwner(text: string): Promise<void>;
  /** Null when ready; else why voice is not usable (shown in channel status). */
  notReadyReason(): string | null;
  maxTextLength: number;
}

export class VoiceAdapter implements ChannelAdapter {
  readonly id = "voice";
  readonly capabilities: ChannelCapabilities;
  private readonly deps: VoiceAdapterDeps;
  private readonly listeners: MessageListener[] = [];
  private running = false;
  private connectedAt: number | undefined;
  private sent = 0;

  constructor(deps: VoiceAdapterDeps) {
    this.deps = deps;
    this.capabilities = {
      sendMedia: false,
      sendReaction: false,
      editMessage: false,
      deleteMessage: false,
      sendTyping: false,
      threads: false,
      multipleImages: false,
      reactions: false,
      replyContext: false,
      voiceMessages: false,
      maxTextLength: deps.maxTextLength,
      interactiveButtons: false,
    };
  }

  async start(_signal: AbortSignal): Promise<void> {
    this.running = true;
    this.connectedAt = Date.now();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connectedAt = undefined;
  }

  getStatus(): ChannelStatus {
    const reason = this.deps.notReadyReason();
    if (!this.running) return { state: "disconnected", failureCount: 0 };
    if (reason) return { state: "error", failureCount: 0, lastError: reason };
    return { state: "connected", failureCount: 0, ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}) };
  }

  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  /** Called by the call flow for each owner turn. */
  emitTurn(turn: VoiceTurnEmission): void {
    const remote = turn.call.remote;
    if (!remote) return;
    const message: UnifiedMessage = {
      id: turn.messageId,
      channel: "voice",
      senderId: remote,
      senderName: "Owner (phone)",
      text: turn.text,
      chatType: "dm",
      chatId: remote,
      timestamp: Date.now(),
      raw: { provider: turn.call.provider, callId: turn.call.callId, ...(turn.confidence !== undefined ? { confidence: turn.confidence } : {}) },
    };
    for (const listener of this.listeners) {
      try {
        const r = listener(message);
        if (r && typeof (r as Promise<void>).catch === "function") {
          (r as Promise<void>).catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, "voice listener failed"));
        }
      } catch (err) {
        log.error({ err: err instanceof Error ? err.message : String(err) }, "voice listener failed");
      }
    }
  }

  async sendText(params: SendTextParams): Promise<SentMessage[]> {
    const ref = parseVoiceTurnMessageId(params.ctx.replyToId);
    const spoken = this.deps.deliverReply(ref, params.text);
    if (!spoken && params.text.trim()) {
      await this.deps.forwardToOwner(`From your call:\n${params.text}`);
    }
    return [{ id: `voice-out-${++this.sent}`, timestamp: Date.now() }];
  }

  async sendTyping(_params: SendTypingParams): Promise<void> {
    // Nothing to show on a phone line.
  }
}
