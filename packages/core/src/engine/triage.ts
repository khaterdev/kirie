/**
 * TriageRunner - Tier 2 of the Proactive Intelligence Layer.
 *
 * Reads the HEARTBEAT.md checklist, combines it with detected signals,
 * and calls a fast LLM (Haiku) via the Claude Agent SDK to make smart
 * triage decisions about what to notify, queue, or ignore.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import type { Signal } from "./signals.js";
import type { ProactiveConfig } from "../config/schema.js";
import type { HeartbeatLogStore } from "../mcp/tools/heartbeat-logs.js";

const log = pino({ name: "triage" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A decision made by the triage LLM for a given signal or checklist item */
export interface TriageDecision {
  /** What to do with this signal */
  action: "notify-now" | "queue-digest" | "silent" | "escalate";
  /** Message to send (for notify-now and queue-digest actions) */
  message?: string;
  /** Which signal this decision applies to (if applicable) */
  signalId?: string;
}

/** Result of a triage run */
export interface TriageResult {
  decisions: TriageDecision[];
  /** Number of signals that were triaged */
  signalsProcessed: number;
  /** Whether the LLM was called (false if skipped) */
  llmCalled: boolean;
}

// ---------------------------------------------------------------------------
// TriageRunner
// ---------------------------------------------------------------------------

/**
 * The TriageRunner reads the HEARTBEAT.md checklist and uses an LLM
 * to make triage decisions about detected signals.
 *
 * Uses the Claude Agent SDK (same auth as the main agent) so no
 * ANTHROPIC_API_KEY environment variable is required.
 */
export class TriageRunner {
  private readonly config: ProactiveConfig;
  private readonly heartbeatFilePath: string;
  private readonly heartbeatLogStore: HeartbeatLogStore | null;

  constructor(config: ProactiveConfig, heartbeatLogStore?: HeartbeatLogStore) {
    this.config = config;
    this.heartbeatLogStore = heartbeatLogStore ?? null;
    // Resolve ~ in heartbeat file path
    const rawPath = config.heartbeatFile;
    this.heartbeatFilePath = rawPath.startsWith("~")
      ? resolve(homedir(), rawPath.slice(2))
      : resolve(rawPath);
  }

  /**
   * Run triage on the given signals.
   * Reads the heartbeat file, builds a prompt, and calls the triage LLM.
   */
  async triage(signals: Signal[]): Promise<TriageResult> {
    // Read the heartbeat checklist
    const checklist = this.readHeartbeatFile();

    // If no checklist and no signals, skip entirely
    if (!checklist && signals.length === 0) {
      return { decisions: [], signalsProcessed: 0, llmCalled: false };
    }

    // Build the triage prompt
    const prompt = this.buildPrompt(signals, checklist);

    try {
      const startMs = Date.now();
      const decisions = await this.callTriageLLM(prompt);
      const durationMs = Date.now() - startMs;

      // Log triage LLM call to heartbeat DB (only when something happened)
      if (this.heartbeatLogStore && decisions.length > 0) {
        this.heartbeatLogStore.log({
          tick_number: 0,
          tier: "tier2",
          category: "triage_llm_call",
          level: "info",
          title: `Triage LLM call: ${signals.length} signals processed, ${decisions.length} decisions`,
          content: `Prompt length: ${prompt.length} chars. Decisions: ${decisions.map((d) => d.action).join(", ")}`,
          metadata: {
            signalsProcessed: signals.length,
            decisionsCount: decisions.length,
            actions: decisions.map((d) => d.action),
          },
          duration_ms: durationMs,
        });
      }

      return {
        decisions,
        signalsProcessed: signals.length,
        llmCalled: true,
      };
    } catch (err) {
      log.error({ err }, "triage LLM call failed");
      return { decisions: [], signalsProcessed: signals.length, llmCalled: false };
    }
  }

  /**
   * Read the HEARTBEAT.md file from disk.
   * Returns null if the file doesn't exist or is empty.
   */
  private readHeartbeatFile(): string | null {
    try {
      if (!existsSync(this.heartbeatFilePath)) {
        log.debug({ path: this.heartbeatFilePath }, "heartbeat file not found");
        return null;
      }

      const content = readFileSync(this.heartbeatFilePath, "utf-8").trim();
      if (!content) return null;

      return content;
    } catch (err) {
      log.warn({ err, path: this.heartbeatFilePath }, "failed to read heartbeat file");
      return null;
    }
  }

  /**
   * Build the triage prompt for the LLM.
   */
  private buildPrompt(signals: Signal[], checklist: string | null): string {
    const now = new Date();
    const timezone = this.config.activeHours.timezone;

    // Get time in configured timezone
    let timeStr: string;
    try {
      timeStr = now.toLocaleString("en-US", { timeZone: timezone });
    } catch {
      timeStr = now.toISOString();
    }

    const parts: string[] = [];

    parts.push(`You are a triage assistant for Kirie, a personal AI assistant.`);
    parts.push(`Current time: ${timeStr} (${timezone})`);
    parts.push("");

    if (signals.length > 0) {
      parts.push("## Detected Signals");
      parts.push("");
      for (const signal of signals) {
        parts.push(`- [${signal.severity.toUpperCase()}] ${signal.title} (id: ${signal.id})`);
        parts.push(`  Details: ${signal.details}`);
        parts.push(`  Source: ${signal.source}`);
        parts.push("");
      }
    }

    // Inject recent heartbeat activity summary for pattern awareness
    if (this.heartbeatLogStore) {
      try {
        const summary = this.heartbeatLogStore.recentSummary(24);
        if (summary && !summary.includes("no heartbeat activity")) {
          parts.push("## Recent Heartbeat Activity");
          parts.push("");
          parts.push(summary);
          parts.push("");
        }
      } catch { /* non-fatal */ }
    }

    if (checklist) {
      parts.push("## Proactive Checklist (HEARTBEAT.md)");
      parts.push("");
      parts.push(checklist);
      parts.push("");
    }

    parts.push("## Instructions");
    parts.push("");
    parts.push("Evaluate each signal and checklist item. For each one that needs action, return a JSON decision.");
    parts.push("");
    parts.push("STRICT RULES:");
    parts.push("- NEVER generate greetings, \"good morning\" messages, time-of-day pleasantries, or status summaries.");
    parts.push("- NEVER create notifications for things that don't require the owner's immediate attention.");
    parts.push("- You are a signal processor, NOT a chat assistant. Do NOT be conversational.");
    parts.push("- If no signals are present and no checklist items require urgent action right now, you MUST return [].");
    parts.push("- A checklist item only warrants action if there's a specific, time-sensitive reason RIGHT NOW.");
    parts.push('- "Be aware of X" or "monitor Y" checklist items are NOT actionable — return [] for them.');
    parts.push("");
    parts.push("Action types:");
    parts.push('- "notify-now": ONLY for genuinely urgent items requiring the owner\'s immediate attention. Use sparingly.');
    parts.push('- "queue-digest": For items worth mentioning in the daily summary but not urgent.');
    parts.push('- "silent": For signals that have been noted but need no action.');
    parts.push('- "escalate": For complex issues that need deep investigation (spawns a background agent). Use when the issue is too complex for a simple notification and requires autonomous investigation/remediation.');
    parts.push("");
    parts.push("Each decision has:");
    parts.push('- "action": one of "notify-now", "queue-digest", "silent", "escalate"');
    parts.push('- "message": the notification message text (required for notify-now and queue-digest)');
    parts.push('- "signalId": the signal ID this applies to (REQUIRED for notify-now and escalate — must match a signal from the Detected Signals section)');
    parts.push("");
    parts.push("If nothing needs attention, return an empty array: []");
    parts.push("");
    parts.push("IMPORTANT: Return ONLY the JSON array, no other text or markdown formatting.");

    return parts.join("\n");
  }

  /**
   * Call the triage LLM via the Claude Agent SDK.
   * Uses the same auth as the main agent — no API key env var needed.
   */
  private async callTriageLLM(prompt: string): Promise<TriageDecision[]> {
    const model = this.config.tier2Model;

    const stream = query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        systemPrompt: "You are a triage decision engine. Return only valid JSON arrays. No tools, no conversation — just analyze and return decisions.",
        permissionMode: "bypassPermissions",
        allowedTools: [],
      },
    });

    let resultText = "";

    for await (const msg of stream as AsyncGenerator<SDKMessage, void>) {
      switch (msg.type) {
        case "assistant": {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              resultText += block.text;
            }
          }
          break;
        }
        case "result": {
          if (msg.subtype === "success" && msg.result) {
            resultText = msg.result;
          }
          break;
        }
        default:
          break;
      }
    }

    if (!resultText) {
      log.warn("triage LLM returned no text content");
      return [];
    }

    return this.parseDecisions(resultText);
  }

  /**
   * Parse the LLM response text into TriageDecision objects.
   * Handles various formatting issues (markdown code blocks, etc.)
   */
  private parseDecisions(text: string): TriageDecision[] {
    // Strip markdown code blocks if present
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned) as unknown;

      if (!Array.isArray(parsed)) {
        log.warn("triage LLM returned non-array JSON");
        return [];
      }

      const decisions: TriageDecision[] = [];
      for (const item of parsed) {
        if (
          typeof item === "object" &&
          item !== null &&
          "action" in item &&
          typeof (item as Record<string, unknown>).action === "string"
        ) {
          const action = (item as Record<string, unknown>).action as string;
          if (["notify-now", "queue-digest", "silent", "escalate"].includes(action)) {
            decisions.push({
              action: action as TriageDecision["action"],
              message: typeof (item as Record<string, unknown>).message === "string"
                ? (item as Record<string, unknown>).message as string
                : undefined,
              signalId: typeof (item as Record<string, unknown>).signalId === "string"
                ? (item as Record<string, unknown>).signalId as string
                : undefined,
            });
          }
        }
      }

      return decisions;
    } catch (err) {
      log.warn({ err, text: cleaned.slice(0, 200) }, "failed to parse triage LLM response");
      return [];
    }
  }
}
