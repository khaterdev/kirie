/**
 * A2UI (Agent-to-UI) protocol for real-time state communication
 * between agents and canvas UI.
 */

/** A2UI message types */
export type A2UIMessage =
  | { type: "push"; data: Record<string, unknown> }
  | { type: "reset" }
  | { type: "navigate"; url: string }
  | { type: "eval"; code: string }
  | { type: "snapshot"; format?: "html" | "text" };

/** State manager for A2UI */
export class A2UIState {
  private state: Record<string, unknown> = {};
  private listeners: Array<(msg: A2UIMessage) => void> = [];

  push(data: Record<string, unknown>): void {
    Object.assign(this.state, data);
    this.notify({ type: "push", data });
  }

  reset(): void {
    this.state = {};
    this.notify({ type: "reset" });
  }

  getState(): Record<string, unknown> {
    return { ...this.state };
  }

  onMessage(listener: (msg: A2UIMessage) => void): void {
    this.listeners.push(listener);
  }

  removeListener(listener: (msg: A2UIMessage) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  private notify(msg: A2UIMessage): void {
    for (const listener of this.listeners) {
      listener(msg);
    }
  }
}
