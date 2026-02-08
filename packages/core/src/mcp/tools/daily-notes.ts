/**
 * Daily notes tool handlers for date-keyed memory entries.
 * Uses key format: daily:YYYY-MM-DD
 */

interface MemoryStoreLike {
  recall(key: string): { content: string; tags: string[] } | null;
  store(key: string, content: string, tags?: string[]): void;
}

interface MemoryManagerLike {
  store(key: string, content: string, tags?: string[]): Promise<void>;
}

export function todayKey(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `daily:${yyyy}-${mm}-${dd}`;
}

export function createDailyNoteToolHandlers(
  memoryStore: MemoryStoreLike,
  memoryManager?: MemoryManagerLike,
) {
  return {
    daily_note_append: {
      description:
        "Append a timestamped note to today's daily log. Creates one if it doesn't exist. " +
        "Use this proactively to record events, decisions, and discoveries throughout the day.",
      parameters: {
        type: "object" as const,
        properties: {
          content: {
            type: "string" as const,
            description: "Note text to append to today's daily log",
          },
          date: {
            type: "string" as const,
            description: "Date in YYYY-MM-DD format (defaults to today)",
          },
        },
        required: ["content"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const date = params.date as string | undefined;
        const key = date ? `daily:${date}` : todayKey();
        const dateStr = key.replace("daily:", "");
        const content = params.content as string;

        const existing = memoryStore.recall(key);
        const timestamp = new Date().toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        });

        const entry = existing
          ? `${existing.content}\n- [${timestamp}] ${content}`
          : `# Daily Note — ${dateStr}\n\n- [${timestamp}] ${content}`;

        if (memoryManager) {
          await memoryManager.store(key, entry, ["daily-note"]);
        } else {
          memoryStore.store(key, entry, ["daily-note"]);
        }

        return { key, updated: true };
      },
    },

    daily_note_read: {
      description:
        "Read a daily note. Defaults to today. Use to review what happened on a specific day.",
      parameters: {
        type: "object" as const,
        properties: {
          date: {
            type: "string" as const,
            description: "Date in YYYY-MM-DD format (defaults to today)",
          },
        },
        required: [] as const,
      },
      handler(params: Record<string, unknown>) {
        const date = params.date as string | undefined;
        const key = date ? `daily:${date}` : todayKey();
        const entry = memoryStore.recall(key);
        return entry ?? { key, content: null, message: "No daily note for this date" };
      },
    },
  };
}
