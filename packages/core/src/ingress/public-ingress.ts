/**
 * PublicIngress - the public listener (PLAN B.9).
 *
 * A second HTTP listener, separate from the control plane on 18789: its own
 * Hono-free root handler, its own port (`ingress.port`, default 18787), bound
 * to 127.0.0.1 only and reached through a tunnel. It shares no code with
 * gateway/routes.ts.
 *
 * - The root answers `GET /healthz` with `ok`, hands requests under a mounted
 *   prefix to that sub-app, and answers everything else 404 with an empty body.
 *   No CORS, no auth: each sub-app authenticates its own requests.
 * - A sub-app receives the request unchanged: full path, raw query string and
 *   raw body, nothing parsed. Build it with `new Hono().basePath(prefix)` (or
 *   match the full paths). It sets its own body limit and rate limits.
 * - The listener exists only while something is mounted: `ensureStarted()`
 *   does nothing when nothing is mounted, and `stopIfIdle()` closes it once the
 *   last prefix is unmounted. With webhooks and voice off, the port is not bound.
 */

import type { Server } from "node:http";
import type { Logger } from "pino";
import { serve } from "@hono/node-server";
import type { IngressConfig } from "../config/sections/ingress.js";
import { createModuleLogger } from "../logging/logger.js";

/** The part of a Hono app the ingress needs. */
export interface IngressSubApp {
  fetch(request: Request): Response | Promise<Response>;
}

const PREFIX_RE = /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/;

/** Node server hardening (PLAN B.9). */
export const INGRESS_SERVER_LIMITS = {
  requestTimeoutMs: 10_000,
  headersTimeoutMs: 5_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: 64,
} as const;

export class PublicIngress {
  private readonly cfg: IngressConfig;
  private readonly log: Logger;
  private readonly mounts = new Map<string, IngressSubApp>();
  private readonly lastRequest = new Map<string, number>();
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  private boundPort: number | null = null;

  constructor(cfg: IngressConfig, deps: { log?: Logger } = {}) {
    this.cfg = cfg;
    this.log = deps.log ?? createModuleLogger("public-ingress");
  }

  /** prefix /^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/. Duplicate or overlapping prefixes throw. The sub-app does its own authentication. */
  mount(prefix: string, app: IngressSubApp): void {
    if (!PREFIX_RE.test(prefix)) throw new Error(`Invalid ingress prefix "${prefix}"`);
    if (prefix === "/healthz") throw new Error(`Ingress prefix "${prefix}" is reserved`);
    for (const existing of this.mounts.keys()) {
      if (existing === prefix) throw new Error(`Ingress prefix "${prefix}" is already mounted`);
      if (existing.startsWith(`${prefix}/`) || prefix.startsWith(`${existing}/`)) {
        throw new Error(`Ingress prefix "${prefix}" overlaps "${existing}"`);
      }
    }
    this.mounts.set(prefix, app);
    this.log.info({ prefix }, "ingress prefix mounted");
  }

  unmount(prefix: string): void {
    if (this.mounts.delete(prefix)) {
      this.lastRequest.delete(prefix);
      this.log.info({ prefix }, "ingress prefix unmounted");
    }
  }

  mountedPrefixes(): string[] {
    return [...this.mounts.keys()];
  }

  /** `ingress.publicBaseUrl` without a trailing slash, or null when unset. */
  get publicBaseUrl(): string | null {
    const url = this.cfg.publicBaseUrl?.trim();
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** The bound port while listening, else null. */
  get port(): number | null {
    return this.boundPort;
  }

  /** Binds 127.0.0.1:<ingress.port> when at least one prefix is mounted. Idempotent. */
  async ensureStarted(): Promise<void> {
    if (this.server) return;
    if (this.mounts.size === 0) {
      this.log.debug("ingress not started: nothing is mounted");
      return;
    }
    if (!this.starting) {
      this.starting = this.listen().finally(() => { this.starting = null; });
    }
    await this.starting;
  }

  /** Stops the listener when nothing is mounted. */
  async stopIfIdle(): Promise<void> {
    if (this.mounts.size === 0) await this.stop();
  }

  /** Closes the listener (stopDaemon and restartDaemon). Mounts are kept. */
  async stop(): Promise<void> {
    if (this.starting) {
      try { await this.starting; } catch { /* a failed start leaves nothing to close */ }
    }
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    this.log.info("ingress listener stopped");
  }

  isListening(): boolean {
    return this.server?.listening ?? false;
  }

  lastRequestAt(prefix: string): number | null {
    return this.lastRequest.get(prefix) ?? null;
  }

  /** The root handler. Exposed for tests. */
  async handle(request: Request): Promise<Response> {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return emptyResponse(400);
    }
    if (pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const prefix = this.match(pathname);
    if (!prefix) return emptyResponse(404);
    const app = this.mounts.get(prefix);
    if (!app) return emptyResponse(404);
    this.lastRequest.set(prefix, Date.now());
    try {
      return await app.fetch(request);
    } catch (err) {
      this.log.error({ prefix, err: err instanceof Error ? err.message : String(err) }, "ingress sub-app failed");
      return emptyResponse(500);
    }
  }

  private match(pathname: string): string | null {
    for (const prefix of this.mounts.keys()) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix;
    }
    return null;
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = serve({
        fetch: (req: Request) => this.handle(req),
        port: this.cfg.port,
        hostname: "127.0.0.1",
      }) as unknown as Server;
      server.requestTimeout = INGRESS_SERVER_LIMITS.requestTimeoutMs;
      server.headersTimeout = INGRESS_SERVER_LIMITS.headersTimeoutMs;
      server.keepAliveTimeout = INGRESS_SERVER_LIMITS.keepAliveTimeoutMs;
      server.maxConnections = INGRESS_SERVER_LIMITS.maxConnections;
      server.once("listening", () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.cfg.port;
        this.server = server;
        this.log.info({ port: this.boundPort, prefixes: this.mountedPrefixes() }, "ingress listener started on 127.0.0.1");
        resolve();
      });
      server.once("error", (err) => {
        this.log.error({ err: err.message, port: this.cfg.port }, "ingress listener failed to start");
        reject(err);
      });
    });
  }
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}
