/**
 * NotificationManager - handles immediate and digest-based notification delivery.
 *
 * Part of the Proactive Intelligence Layer. Receives decisions from the
 * TriageRunner and delivers messages through channel adapters.
 */

import pino from "pino";
import type { ChannelRegistry } from "../channels/registry.js";
import type { Signal } from "./signals.js";
import type { ChannelName } from "../channels/normalizer.js";
import type { HeartbeatService } from "./heartbeat.js";
import { isTransientNetworkError } from "./network-errors.js";

const log = pino({ name: "notifications" });

/**
 * Configuration for the NotificationManager.
 */
export interface NotificationManagerConfig {
  /** Default channel to send notifications through */
  defaultChannel: ChannelName;
  /** Default chat ID for owner notifications */
  defaultChatId: string;
  /** Optional heartbeat service for retrying failed deliveries */
  heartbeat?: HeartbeatService;
}

/**
 * Manages notification delivery: immediate notifications and digest queuing.
 */
export class NotificationManager {
  private readonly channelRegistry: ChannelRegistry;
  private readonly config: NotificationManagerConfig;
  private digestQueue: Signal[] = [];

  constructor(
    channelRegistry: ChannelRegistry,
    config: NotificationManagerConfig,
  ) {
    this.channelRegistry = channelRegistry;
    this.config = config;
  }

  /**
   * Set the heartbeat service for retry support.
   * Called after HeartbeatService is created.
   */
  setHeartbeat(heartbeat: HeartbeatService): void {
    this.config.heartbeat = heartbeat;
  }

  /**
   * Send a notification immediately through a channel adapter.
   *
   * @param message - The message text to send
   * @param channel - Target channel (defaults to configured default)
   * @param chatId - Target chat ID (defaults to configured default)
   */
  async notifyNow(
    message: string,
    channel?: string,
    chatId?: string,
  ): Promise<boolean> {
    const targetChannel = (channel ?? this.config.defaultChannel) as ChannelName;
    const targetChatId = chatId ?? this.config.defaultChatId;

    try {
      const adapter = this.channelRegistry.getById(targetChannel);
      if (!adapter) {
        log.warn({ channel: targetChannel }, "channel adapter not found for notification");
        return false;
      }

      await adapter.sendText({
        ctx: { chatId: targetChatId },
        text: message,
      });

      log.debug({ channel: targetChannel, chatId: targetChatId }, "notification sent");
      return true;
    } catch (err) {
      // On transient network errors, queue for retry via heartbeat
      if (this.config.heartbeat && isTransientNetworkError(err)) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.config.heartbeat.addFailedDelivery(targetChannel, targetChatId, message, errorMsg);
        log.info({ channel: targetChannel, chatId: targetChatId }, "notification queued for retry via heartbeat");
        return false;
      }
      log.error(
        { channel: targetChannel, chatId: targetChatId, err },
        "failed to send notification",
      );
      return false;
    }
  }

  /**
   * Add a signal to the digest queue for batch delivery later.
   */
  queueForDigest(signal: Signal): void {
    this.digestQueue.push(signal);
    log.debug({ signalType: signal.type, queueSize: this.digestQueue.length }, "signal queued for digest");
  }

  /**
   * Compile and send the digest queue as a single formatted message.
   * Clears the queue after sending.
   *
   * @param channel - Target channel (defaults to configured default)
   * @param chatId - Target chat ID (defaults to configured default)
   * @returns true if the digest was sent successfully
   */
  async sendDigest(channel?: string, chatId?: string): Promise<boolean> {
    if (this.digestQueue.length === 0) {
      log.debug("digest queue is empty, skipping");
      return true;
    }

    const message = this.formatDigest(this.digestQueue);
    const sent = await this.notifyNow(message, channel, chatId);

    if (sent) {
      this.digestQueue = [];
    }

    return sent;
  }

  /**
   * Clear the digest queue without sending.
   */
  clearDigest(): void {
    this.digestQueue = [];
  }

  /**
   * Get the current digest queue contents.
   */
  getDigestQueue(): readonly Signal[] {
    return this.digestQueue;
  }

  /**
   * Get the number of signals in the digest queue.
   */
  get digestQueueSize(): number {
    return this.digestQueue.length;
  }

  /**
   * Format an array of signals into a human-readable digest message.
   */
  private formatDigest(signals: Signal[]): string {
    const lines: string[] = [];
    lines.push("📋 **Proactive Digest**\n");

    // Group by severity
    const critical = signals.filter((s) => s.severity === "critical");
    const warnings = signals.filter((s) => s.severity === "warning");
    const info = signals.filter((s) => s.severity === "info");

    if (critical.length > 0) {
      lines.push("🔴 **Critical:**");
      for (const s of critical) {
        lines.push(`  • ${s.title}`);
        if (s.details) lines.push(`    ${s.details}`);
      }
      lines.push("");
    }

    if (warnings.length > 0) {
      lines.push("🟡 **Warnings:**");
      for (const s of warnings) {
        lines.push(`  • ${s.title}`);
      }
      lines.push("");
    }

    if (info.length > 0) {
      lines.push("🔵 **Info:**");
      for (const s of info) {
        lines.push(`  • ${s.title}`);
      }
      lines.push("");
    }

    lines.push(`_${signals.length} signal${signals.length !== 1 ? "s" : ""} total_`);

    return lines.join("\n");
  }
}
