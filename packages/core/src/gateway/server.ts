import type { Server } from "node:http";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { serve } from "@hono/node-server";
import type { GatewayConfig } from "../config/schema.js";
import { createRoutes, type GatewayDeps } from "./routes.js";
import { createModuleLogger } from "../logging/logger.js";
import type { InternalApi } from "./internal-api.js";

const log = createModuleLogger("gateway");

/**
 * Options for creating the gateway server.
 */
export interface GatewayServerOptions {
  /** Gateway configuration from the Kirie config */
  config: GatewayConfig;
  /** Dependencies for route handlers */
  deps: GatewayDeps;
  /** Feature routes, mounted at /api/<name> (PLAN B.9). The registry is sealed here. */
  internalApi?: InternalApi;
}

/**
 * Host header values the loopback control plane accepts: the loopback names
 * with the listening port, plus `gateway.extraAllowedHosts`. Compared
 * case-insensitively. This blocks DNS rebinding: a page on a foreign name that
 * resolves to 127.0.0.1 still sends its own name in Host.
 */
export function gatewayAllowedHosts(port: number, extra: readonly string[] = []): Set<string> {
  const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  for (const h of extra) {
    const v = h.trim().toLowerCase();
    if (v) hosts.add(v);
  }
  return hosts;
}

/**
 * GatewayServer manages the HTTP control plane for the Kirie daemon.
 *
 * Features:
 *   - Loopback-only binding by default (localhost)
 *   - Optional bearer token auth when binding to all interfaces
 *   - Hono-based routing with clean JSON responses
 *   - Graceful start/stop lifecycle
 */
export class GatewayServer {
  private readonly app: Hono;
  private readonly config: GatewayConfig;
  private server: Server | null = null;
  /** The port actually bound (differs from config.port when that is 0). */
  private boundPort: number | null = null;

  constructor(options: GatewayServerOptions) {
    this.config = options.config;

    const routes = createRoutes(options.deps);

    // Build the top-level app with optional auth middleware
    this.app = new Hono();

    // Host allowlist (DNS rebinding) on the loopback control plane. Runs first.
    // No token is required, so local callers and the stdio MCP subprocess,
    // which use http://127.0.0.1:<port>, keep working.
    if (this.config.bind === "loopback") {
      this.app.use("*", async (c, next) => {
        const host = (c.req.header("host") ?? "").trim().toLowerCase();
        const allowed = gatewayAllowedHosts(this.boundPort ?? this.config.port, this.config.extraAllowedHosts ?? []);
        if (!host || !allowed.has(host)) {
          log.warn({ host: host.slice(0, 100), path: c.req.path }, "gateway request refused: Host not allowed");
          return c.json({ status: "error", message: "Host not allowed" }, 403);
        }
        await next();
      });
    }

    // Apply bearer auth when a token is configured
    if (this.config.bearerToken) {
      this.app.use("*", bearerAuth({ token: this.config.bearerToken }));
    }

    // CSRF protection: reject POST requests with a mismatched Origin header.
    // Missing Origin is allowed (CLI tools, curl), but if present it must match
    // the expected host.
    this.app.use("*", async (c, next) => {
      if (c.req.method === "POST") {
        const origin = c.req.header("origin");
        if (origin) {
          const host = c.req.header("host");
          try {
            const originHost = new URL(origin).host;
            if (host && originHost !== host) {
              return c.json({ status: "error", message: "Origin mismatch" }, 403);
            }
          } catch {
            return c.json({ status: "error", message: "Invalid Origin header" }, 403);
          }
        }
      }
      await next();
    });

    // Feature routes first, so /api/<name> resolves to the feature's app.
    if (options.internalApi) {
      for (const { name, app } of options.internalApi.apps()) {
        this.app.route(`/api/${name}`, app);
      }
      options.internalApi.seal();
    }

    // Mount all routes
    this.app.route("/", routes);

    // 404 handler
    this.app.notFound((c) => {
      return c.json({ status: "error", message: "Not found" }, 404);
    });

    // Global error handler
    this.app.onError((err, c) => {
      log.error({ err }, "unhandled gateway error");
      return c.json({ status: "error", message: "An internal error occurred" }, 500);
    });
  }

  /**
   * Start the HTTP server.
   * @returns The resolved port the server is listening on.
   */
  async start(): Promise<number> {
    const hostname = this.config.bind === "loopback" ? "127.0.0.1" : "0.0.0.0";

    return new Promise<number>((resolve, reject) => {
      try {
        const serverInstance = serve({
          fetch: this.app.fetch,
          port: this.config.port,
          hostname,
        });

        // The serve() function from @hono/node-server returns a Node.js Server
        this.server = serverInstance as unknown as Server;

        // Resolve once listening
        this.server.once("listening", () => {
          const addr = this.server?.address();
          const port = typeof addr === "object" && addr ? addr.port : this.config.port;
          this.boundPort = port;
          resolve(port);
        });

        this.server.once("error", (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Stop the HTTP server gracefully.
   * Closes all active connections and waits for in-flight requests to complete.
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.server = null;
        this.boundPort = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** Whether the server is currently running. */
  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** The underlying Hono app, exposed for testing. */
  get honoApp(): Hono {
    return this.app;
  }
}
