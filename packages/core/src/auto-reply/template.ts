export interface TemplateContext {
  sender: { name: string; id: string };
  channel: { name: string; type: string; id: string };
  timestamp: string;
  date: string;
  custom?: Record<string, string>;
}

export function applyTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (match, path: string) => {
    const parts = path.split(".");
    let value: unknown = context;
    for (const part of parts) {
      value = (value as Record<string, unknown>)?.[part];
      if (value === undefined) {
        // Check custom vars
        if (context.custom?.[path]) return context.custom[path];
        return match; // Keep original if not found
      }
    }
    return String(value);
  });
}

export function buildTemplateContext(opts: {
  senderName: string;
  senderId: string;
  channel: string;
  chatType: string;
  chatId: string;
  custom?: Record<string, string>;
}): TemplateContext {
  const now = new Date();
  return {
    sender: { name: opts.senderName, id: opts.senderId },
    channel: { name: opts.channel, type: opts.chatType, id: opts.chatId },
    timestamp: now.toISOString(),
    date: now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    custom: opts.custom,
  };
}
