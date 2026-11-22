/**
 * InternalApi - feature routes on the loopback control plane (PLAN B.9).
 *
 * A feature mounts a Hono sub-app under `/api/<name>` during its setup; the
 * GatewayServer mounts every app when it is constructed and seals the registry.
 *
 * These routes are callable by the agent (it has unrestricted Bash and can
 * curl them) and by any local process. So nothing mounted here may approve,
 * apply, confirm, arm, change approval or sandbox mode, answer a prompt,
 * reveal a secret, or add a webhook, plugin or account path. Read-only status
 * and bounded, audited actions only.
 */

import type { Hono } from "hono";

const NAME_RE = /^[a-z][a-z-]{1,30}$/;

/** Paths under /api that gateway/routes.ts already serves. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["usage", "proactive", "channel-action"]);

export class InternalApi {
  private readonly mounted = new Map<string, Hono>();
  private sealed = false;

  /** Mount a feature's loopback routes under /api/<name>. Call during feature setup, before the gateway starts. */
  mount(name: string, app: Hono): void {
    if (this.sealed) {
      throw new Error(`InternalApi.mount("${name}") called after the gateway was built; mount during feature setup`);
    }
    if (!NAME_RE.test(name)) throw new Error(`Invalid internal API name "${name}"`);
    if (RESERVED_NAMES.has(name)) throw new Error(`Internal API name "${name}" is reserved by the gateway`);
    if (this.mounted.has(name)) throw new Error(`Internal API "${name}" is already mounted`);
    this.mounted.set(name, app);
  }

  apps(): ReadonlyArray<{ name: string; app: Hono }> {
    return [...this.mounted.entries()].map(([name, app]) => ({ name, app }));
  }

  /** Called by GatewayServer once it has mounted the apps. Later mounts throw. */
  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }
}
