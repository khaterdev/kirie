/**
 * AutoReplyEngine - lightweight command matching that runs before the agent.
 * Registered commands are matched against incoming message text.
 * If a match is found, the handler returns a response string directly,
 * bypassing the AI agent entirely for fast, deterministic replies.
 */

export interface AutoReplyCommand {
  /** Command name, e.g. "/help" */
  name: string;
  /** Regex pattern to match against message text */
  pattern: RegExp;
  /** Human-readable description shown in /help */
  description: string;
  /** Handler that produces the reply text */
  handler: (args: string, context: AutoReplyContext) => string | Promise<string>;
}

export interface AutoReplyContext {
  senderName: string;
  senderId: string;
  channel: string;
  chatType: string;
  chatId: string;
}

export class AutoReplyEngine {
  private commands = new Map<string, AutoReplyCommand>();

  /** Register a command. Overwrites if name already exists. */
  register(command: AutoReplyCommand): void {
    this.commands.set(command.name, command);
  }

  /**
   * Try to match a message against registered commands.
   * Returns the reply string if a command matches, or null if none match.
   */
  async match(text: string, context: AutoReplyContext): Promise<string | null> {
    const trimmed = text.trim();
    for (const cmd of this.commands.values()) {
      const m = trimmed.match(cmd.pattern);
      if (m) {
        // Everything after the matched command is treated as args
        const args = trimmed.slice(m[0].length).trim();
        return cmd.handler(args, context);
      }
    }
    return null;
  }

  /** List all registered commands (for /help output). */
  listCommands(): Array<{ name: string; description: string }> {
    return [...this.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
    }));
  }
}
