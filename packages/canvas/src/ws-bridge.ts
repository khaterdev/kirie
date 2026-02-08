/**
 * WebSocket bridge for canvas communication with mobile WebViews.
 * Provides bidirectional A2UI message passing over WebSocket.
 *
 * Uses generic interfaces so consumers can plug in any WebSocket
 * implementation (e.g. `ws`, Bun WebSocket, Deno WebSocket).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { A2UIMessage } from "./a2ui.js";

/** Minimal WebSocket interface for the bridge */
export interface BridgeWebSocket {
  readonly readyState: number;
  send(data: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
}

/** Minimal WebSocketServer interface for the bridge */
export interface BridgeWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: BridgeWebSocket) => void,
  ): void;
  close(): void;
}

/** WebSocket readyState constant for OPEN */
const WS_OPEN = 1;

export class CanvasWebSocketBridge {
  private wss: BridgeWebSocketServer;
  private sessions = new Map<string, Set<BridgeWebSocket>>();

  constructor(wss: BridgeWebSocketServer) {
    this.wss = wss;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      const sessionId = new URL(request.url ?? "/", "http://localhost").searchParams.get("session") ?? "default";
      this.addClient(sessionId, ws);

      ws.on("close", () => {
        this.removeClient(sessionId, ws);
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.onClientMessage?.(sessionId, msg);
        } catch {
          // Invalid message -- ignore
        }
      });
    });
  }

  broadcast(sessionId: string, message: A2UIMessage): void {
    const clients = this.sessions.get(sessionId);
    if (!clients) return;
    const data = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WS_OPEN) {
        ws.send(data);
      }
    }
  }

  broadcastAll(message: A2UIMessage): void {
    const data = JSON.stringify(message);
    for (const clients of this.sessions.values()) {
      for (const ws of clients) {
        if (ws.readyState === WS_OPEN) {
          ws.send(data);
        }
      }
    }
  }

  onClientMessage?: (sessionId: string, msg: unknown) => void;

  private addClient(sessionId: string, ws: BridgeWebSocket): void {
    let clients = this.sessions.get(sessionId);
    if (!clients) {
      clients = new Set();
      this.sessions.set(sessionId, clients);
    }
    clients.add(ws);
  }

  private removeClient(sessionId: string, ws: BridgeWebSocket): void {
    const clients = this.sessions.get(sessionId);
    if (!clients) return;
    clients.delete(ws);
    if (clients.size === 0) this.sessions.delete(sessionId);
  }

  close(): void {
    this.wss.close();
  }
}
