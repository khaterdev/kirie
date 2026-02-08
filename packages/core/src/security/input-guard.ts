// ---------------------------------------------------------------------------
// InputGuard - prompt injection defense via XML boundary wrapping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnifiedMessageLike {
  channel: string;
  senderId: string;
  senderName?: string;
  text?: string;
  chatType?: string;
  chatId?: string;
  media?: ReadonlyArray<{ type: string; size?: number }>;
}

export interface InputGuardOptions {
  maxTextBytes?: number;
  maxMediaBytes?: number;
}

export interface SuspiciousPatternMatch {
  pattern: string;
  description: string;
  offset: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TEXT_BYTES = 16 * 1024; // 16 KB
const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB

const SUSPICIOUS_PATTERNS: Array<{ regex: RegExp; description: string }> = [
  {
    regex: /(?:system|assistant)\s*(?:prompt|message|instruction)/i,
    description: "Attempts to reference system/assistant prompt",
  },
  {
    regex: /ignore\s+(?:previous|prior|above|all)\s+(?:instructions?|prompts?|rules?)/i,
    description: "Attempts to override prior instructions",
  },
  {
    regex: /you\s+are\s+now\s+(?:a|an|in)\s/i,
    description: "Attempts to redefine AI role",
  },
  {
    regex: /\bDAN\b.*\bmode\b/i,
    description: "DAN jailbreak pattern",
  },
  {
    regex: /<\/?(?:system|assistant|tool_use|tool_result|function_call|function_result)\b/i,
    description: "XML tag injection targeting Claude message structure",
  },
  {
    regex: /\[(?:INST|SYS|SYSTEM)\]/i,
    description: "Instruction delimiter injection",
  },
  {
    regex: /(?:pretend|act\s+as\s+if|imagine)\s+(?:you|that|there)\s+(?:are|is|have|has)\s+no\s+(?:rules?|restrictions?|guidelines?|limitations?)/i,
    description: "Attempts to remove restrictions via roleplay",
  },
  {
    regex: /\bbase64\s*[:=]\s*[A-Za-z0-9+/]{20,}/,
    description: "Embedded base64 payload",
  },
  {
    regex: /\u200b|\u200c|\u200d|\u2060|\ufeff/,
    description: "Zero-width character obfuscation",
  },
];

// Control characters to strip (C0 except \t \n \r, plus C1 range, plus some specials)
const CONTROL_CHAR_REGEX =
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b\u200c\u200d\u2060\ufeff]/g;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InputGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputGuardError";
  }
}

// ---------------------------------------------------------------------------
// InputGuard
// ---------------------------------------------------------------------------

export class InputGuard {
  private readonly maxTextBytes: number;
  private readonly maxMediaBytes: number;

  constructor(options: InputGuardOptions = {}) {
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    this.maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  }

  /**
   * Wrap a user message in XML boundaries for prompt injection defense.
   *
   * Output format:
   * ```
   * <user_message channel="telegram" sender="12345">
   * message text here
   * </user_message>
   * ```
   */
  wrap(message: UnifiedMessageLike): string {
    const text = message.text ?? "";
    this.validateSize(message);

    const sanitized = this.sanitize(text);
    const escapedChannel = this.escapeXmlAttr(message.channel);
    const escapedSender = this.escapeXmlAttr(message.senderId);

    const attrs = [`channel="${escapedChannel}"`, `sender="${escapedSender}"`];

    if (message.chatType) {
      attrs.push(`chat_type="${this.escapeXmlAttr(message.chatType)}"`);
    }
    if (message.chatId) {
      attrs.push(`chat_id="${this.escapeXmlAttr(message.chatId)}"`);
    }

    return `<user_message ${attrs.join(" ")}>\n${sanitized}\n</user_message>`;
  }

  /**
   * Detect suspicious patterns in user input.
   * Returns matches found. These are logged but not blocked —
   * the XML wrapping itself is the defense mechanism.
   */
  detectSuspicious(text: string): SuspiciousPatternMatch[] {
    const matches: SuspiciousPatternMatch[] = [];

    for (const { regex, description } of SUSPICIOUS_PATTERNS) {
      const match = regex.exec(text);
      if (match) {
        matches.push({
          pattern: match[0],
          description,
          offset: match.index,
        });
      }
    }

    return matches;
  }

  /**
   * Sanitize text by stripping control characters while preserving
   * tabs, newlines, and carriage returns.
   */
  sanitize(text: string): string {
    return text.replace(CONTROL_CHAR_REGEX, "");
  }

  /**
   * Validate message size constraints.
   * Throws InputGuardError if limits are exceeded.
   */
  validateSize(message: UnifiedMessageLike): void {
    const text = message.text ?? "";
    const textBytes = Buffer.byteLength(text, "utf-8");

    if (textBytes > this.maxTextBytes) {
      throw new InputGuardError(
        `Message text exceeds maximum size: ${textBytes} bytes > ${this.maxTextBytes} bytes limit`,
      );
    }

    if (message.media) {
      for (const item of message.media) {
        if (item.size !== undefined && item.size > this.maxMediaBytes) {
          throw new InputGuardError(
            `Media attachment exceeds maximum size: ${item.size} bytes > ${this.maxMediaBytes} bytes limit (type: ${item.type})`,
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private escapeXmlAttr(value: string): string {
    return value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
