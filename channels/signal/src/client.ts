/**
 * signal-cli REST API client + SSE event stream.
 *
 * Communicates with signal-cli-rest-api (https://github.com/bbernhard/signal-cli-rest-api)
 * which exposes signal-cli as a REST service with SSE for real-time message delivery.
 */

import type { UnifiedMessage, ChatType, MessageListener } from "@kirie/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignalClientConfig {
  /** Base URL of the signal-cli REST API (e.g. "http://localhost:8080") */
  apiUrl: string;
  /** The phone number registered with signal-cli (e.g. "+1234567890") */
  phoneNumber: string;
}

/** Envelope from the SSE event stream */
export interface SignalEnvelope {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceName?: string;
    sourceUuid?: string;
    timestamp?: number;
    dataMessage?: {
      timestamp?: number;
      message?: string;
      groupInfo?: {
        groupId?: string;
        type?: string;
      };
      attachments?: Array<{
        contentType?: string;
        filename?: string;
        id?: string;
        size?: number;
      }>;
      quote?: {
        id?: number;
        author?: string;
        text?: string;
      };
    };
    typingMessage?: {
      action?: string;
      timestamp?: number;
      groupId?: string;
    };
    receiptMessage?: {
      type?: string;
      timestamps?: number[];
    };
  };
  account?: string;
}

/** Response from sending a message */
export interface SignalSendResult {
  timestamp: string;
}

/** Attachment to send */
export interface SignalAttachment {
  filename: string;
  base64: string;
  contentType?: string;
}

// ---------------------------------------------------------------------------
// SignalClient
// ---------------------------------------------------------------------------

export class SignalClient {
  private readonly apiUrl: string;
  private readonly phoneNumber: string;
  private abortController: AbortController | null = null;
  private readonly listeners: MessageListener[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(config: SignalClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/+$/, "");
    this.phoneNumber = config.phoneNumber;
  }

  /**
   * Register a listener for incoming messages.
   */
  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  /**
   * Start listening for events via SSE.
   */
  async startListening(signal: AbortSignal): Promise<void> {
    this.abortController = new AbortController();

    // Link the external signal to our internal controller
    signal.addEventListener(
      "abort",
      () => {
        this.abortController?.abort();
      },
      { once: true },
    );

    this.connected = true;
    this.connectSSE();
  }

  /**
   * Stop listening and clean up.
   */
  stop(): void {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Check if the signal-cli API is reachable and return API info.
   */
  async healthCheck(): Promise<{ version: string }> {
    const res = await fetch(`${this.apiUrl}/v1/about`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`signal-cli API health check failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { versions?: string[] };
    return { version: data.versions?.[0] ?? "unknown" };
  }

  /**
   * List registered accounts on the signal-cli instance.
   */
  async listAccounts(): Promise<string[]> {
    const res = await fetch(`${this.apiUrl}/v1/accounts`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Failed to list accounts: ${res.status}`);
    }
    const data = (await res.json()) as string[];
    return data;
  }

  /**
   * Send a text message.
   */
  async sendMessage(
    recipient: string,
    message: string,
    options?: { quoteTimestamp?: number; quoteAuthor?: string },
  ): Promise<SignalSendResult> {
    const body: Record<string, unknown> = {
      message,
      number: this.phoneNumber,
      recipients: [recipient],
    };

    if (options?.quoteTimestamp) {
      body["quote_timestamp"] = options.quoteTimestamp;
      body["quote_author"] = options.quoteAuthor;
    }

    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to send Signal message: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { timestamp?: string };
    return { timestamp: data.timestamp ?? String(Date.now()) };
  }

  /**
   * Send a message to a group.
   */
  async sendGroupMessage(
    groupId: string,
    message: string,
  ): Promise<SignalSendResult> {
    const body = {
      message,
      number: this.phoneNumber,
      recipients: [groupId],
    };

    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to send Signal group message: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { timestamp?: string };
    return { timestamp: data.timestamp ?? String(Date.now()) };
  }

  /**
   * Send an attachment.
   */
  async sendAttachment(
    recipient: string,
    attachment: SignalAttachment,
    message?: string,
  ): Promise<SignalSendResult> {
    const body = {
      message: message ?? "",
      number: this.phoneNumber,
      recipients: [recipient],
      base64_attachments: [
        `data:${attachment.contentType ?? "application/octet-stream"};filename=${attachment.filename};base64,${attachment.base64}`,
      ],
    };

    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to send Signal attachment: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { timestamp?: string };
    return { timestamp: data.timestamp ?? String(Date.now()) };
  }

  // -----------------------------------------------------------------------
  // SSE Connection
  // -----------------------------------------------------------------------

  private connectSSE(): void {
    if (!this.connected || !this.abortController) return;

    const encodedNumber = encodeURIComponent(this.phoneNumber);
    const url = `${this.apiUrl}/v1/receive/${encodedNumber}`;

    // Use fetch with streaming for SSE (native Node.js approach, no external deps)
    void this.streamSSE(url);
  }

  private async streamSSE(url: string): Promise<void> {
    if (!this.abortController) return;

    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error("SSE response has no body");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (this.connected) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        const events = buffer.split("\n\n");
        // Keep the last incomplete chunk in the buffer
        buffer = events.pop() ?? "";

        for (const event of events) {
          if (!event.trim()) continue;
          this.processSSEEvent(event);
        }
      }
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        return; // Normal shutdown
      }

      // Reconnect after delay
      if (this.connected) {
        this.reconnectTimer = setTimeout(() => {
          this.connectSSE();
        }, 5000);
      }
    }
  }

  private processSSEEvent(raw: string): void {
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        data += line.slice(5).trim();
      }
    }

    if (!data) return;

    try {
      const envelope = JSON.parse(data) as SignalEnvelope;
      const unified = this.normalizeEnvelope(envelope);
      if (unified) {
        void Promise.all(this.listeners.map((l) => l(unified)));
      }
    } catch {
      // Skip malformed events
    }
  }

  // -----------------------------------------------------------------------
  // Message normalization
  // -----------------------------------------------------------------------

  private normalizeEnvelope(envelope: SignalEnvelope): UnifiedMessage | null {
    const env = envelope.envelope;
    const dataMsg = env.dataMessage;

    // Only handle data messages (not receipts, typing, etc.)
    if (!dataMsg) return null;

    const source = env.sourceNumber ?? env.source ?? env.sourceUuid;
    if (!source) return null;

    // Skip messages from ourselves
    if (source === this.phoneNumber) return null;

    const isGroup = !!dataMsg.groupInfo?.groupId;
    const chatType: ChatType = isGroup ? "group" : "dm";
    const chatId = isGroup
      ? dataMsg.groupInfo!.groupId!
      : source;

    const media = dataMsg.attachments?.map((att) => ({
      type: "document" as const,
      url: att.id ?? "",
      filename: att.filename,
      mimeType: att.contentType,
      sizeBytes: att.size,
    }));

    const timestamp = dataMsg.timestamp ?? env.timestamp ?? Date.now();

    // Build rich reply context from Signal's quote object
    let replyTo: UnifiedMessage["replyTo"];
    let replyToId: string | undefined;
    if (dataMsg.quote) {
      const quote = dataMsg.quote;
      replyToId = quote.id ? String(quote.id) : undefined;
      replyTo = {
        messageId: quote.id ? String(quote.id) : "",
        text: quote.text || undefined,
        senderId: quote.author || undefined,
        senderName: undefined, // Signal doesn't provide display name via REST API
      };
    }

    return {
      id: String(timestamp),
      channel: "signal",
      senderId: source,
      senderName: env.sourceName ?? source,
      text: dataMsg.message ?? "",
      chatType,
      chatId,
      threadId: undefined,
      replyToId,
      replyTo,
      media: media && media.length > 0 ? media : undefined,
      timestamp,
      raw: envelope,
    };
  }
}
