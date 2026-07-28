import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pino from "pino";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt-builder.js";

const log = pino({ name: "workspace-manager" });

/**
 * Configuration for the WorkspaceManager.
 */
export interface WorkspaceManagerConfig {
  /** Data directory (e.g. ~/.kirie) */
  dataDir: string;
  /** Absolute path to the compiled stdio-server.js entry point */
  stdioServerPath: string;
  /** Custom instructions to append to CLAUDE.md */
  customInstructions?: string;
}

/**
 * WorkspaceManager manages the V2 session workspace at ~/.kirie/workspace/.
 *
 * This workspace contains:
 * - CLAUDE.md: Kirie's system prompt content (read by Claude Code automatically)
 * - .claude/settings.json: MCP server config pointing to the stdio server script
 *
 * Each V2 subprocess uses this workspace as its cwd, so Claude Code
 * discovers the MCP server config from .claude/settings.json and reads
 * CLAUDE.md as its custom instructions.
 */
export class WorkspaceManager {
  private readonly config: WorkspaceManagerConfig;
  private readonly workspacePath: string;

  constructor(config: WorkspaceManagerConfig) {
    this.config = config;
    this.workspacePath = join(config.dataDir, "workspace");
  }

  /**
   * Create or update the workspace directory, writing CLAUDE.md and
   * .claude/settings.json. Returns the absolute workspace path.
   */
  ensureWorkspace(): string {
    mkdirSync(this.workspacePath, { recursive: true });
    mkdirSync(join(this.workspacePath, ".claude"), { recursive: true });

    this.writeClaudeMd();
    this.writeSettings();

    log.info({ workspacePath: this.workspacePath }, "workspace ensured");
    return this.workspacePath;
  }

  /**
   * Update CLAUDE.md when config changes (e.g. custom instructions).
   */
  updatePrompt(customInstructions?: string): void {
    this.config.customInstructions = customInstructions;
    this.writeClaudeMd();
    log.info("CLAUDE.md updated");
  }

  /**
   * Get the workspace path.
   */
  getWorkspacePath(): string {
    return this.workspacePath;
  }

  /**
   * Write CLAUDE.md with Kirie's system prompt content.
   * Claude Code automatically reads this file as custom instructions.
   */
  private writeClaudeMd(): void {
    const lines: string[] = [];

    lines.push(DEFAULT_SYSTEM_PROMPT);

    if (this.config.customInstructions) {
      lines.push("");
      lines.push(this.config.customInstructions);
    }

    lines.push("");
    lines.push(this.buildSelfLearningRules());
    lines.push("");
    lines.push(this.buildToolGuidance());

    const content = lines.join("\n");
    writeFileSync(join(this.workspacePath, "CLAUDE.md"), content, "utf-8");
  }

  /**
   * Write .claude/settings.json with the MCP server configuration.
   * Claude Code discovers MCP servers from this file in the workspace directory.
   */
  private writeSettings(): void {
    const settings = {
      permissions: {
        allow: [
          // MCP tools from Kirie's stdio server
          "mcp__kirie-tools__*",
          // Built-in Claude Code tools — pre-allow so subprocesses
          // don't hit permission prompts (belt-and-suspenders with bypassPermissions)
          "Bash(*)",
          "Read",
          "Write",
          "Edit",
          "MultiEdit",
          "Glob",
          "Grep",
          "WebFetch",
          "WebSearch",
          "NotebookEdit",
        ],
      },
      mcpServers: {
        "kirie-tools": {
          type: "stdio",
          command: "node",
          args: [resolve(this.config.stdioServerPath)],
          env: {
            KIRIE_DB_DIR: resolve(this.config.dataDir),
          },
        },
      },
    };

    writeFileSync(
      join(this.workspacePath, ".claude", "settings.json"),
      JSON.stringify(settings, null, 2),
      "utf-8",
    );
  }

  private buildSelfLearningRules(): string {
    return `<self_learning_rules>
You have persistent memory and tools available via the kirie-tools MCP server:

Memory Tools:
- memory_store: Store key-value data with optional tags
- memory_recall: Retrieve by exact key
- memory_search: Full-text search across stored memories
- memory_list: List all memories (optionally filtered by tag)
- memory_delete: Remove a memory by key

Schedule Tools:
- schedule_create: Create cron-based scheduled reminders
- schedule_list: List all schedules
- schedule_delete: Delete a schedule

Messaging Tools:
- send_message: Send messages through any connected channel
- list_channels: List registered channels and their status

Chat History Tools:
- chat_history_recent: Get recent messages for a session
- chat_history_search: Search across all chat history

Background Task Tools (IMPORTANT — read carefully):
- background_task_create: Start a persistent async background task that runs in a SEPARATE session
- background_task_list: List tasks for a session
- background_task_result: Get a task's full result

CRITICAL — Background Tasks:
When the user asks you to run something "in the background", "as a sub-agent", "asynchronously",
or any similar phrasing, you MUST use the MCP tool "background_task_create" (via kirie-tools).
DO NOT use Claude Code's built-in "Task" tool — it spawns sub-agents inside YOUR process that
die when your turn ends, making them useless for persistent background work.

background_task_create writes the task to a database. A separate daemon process picks it up
and runs it in its own independent session that persists even after your turn completes.
The result is automatically delivered to the user when the background task finishes.

Example usage:
  Call mcp__kirie-tools__background_task_create with:
    sessionKey: (from <session_context> tag)
    description: "Research latest AI news"
    prompt: "Search the web for the latest AI news from the past week and summarize the top 5 stories."

Session Key:
Every message includes a <session_context> tag with your session_key (e.g. "telegram:dm:12345").
ALWAYS use this exact session_key when calling background_task_create, background_task_list,
chat_history_recent, or chat_history_search. Do NOT invent or guess session keys.

Self-learning behavior:
- When you learn something important, save it to memory
- When you discover a useful workflow, document it as a skill
- Before complex tasks, check your memory for relevant prior knowledge
- Use background_task_create for long-running operations that don't need immediate response
</self_learning_rules>`;
  }

  private buildToolGuidance(): string {
    return `<tool_guidance>
You are running as Kirie, a persistent AI assistant. Your tools are available through the kirie-tools MCP server.

When interacting with users:
- Be concise in messaging contexts, detailed when depth is needed
- Check memory before answering to leverage past context
- Store important facts and preferences for future reference
- Use background tasks for operations that take a long time
</tool_guidance>`;
  }
}
