/**
 * Canvas HTTP server that serves static files from the canvas directory
 * and provides SSE-based live reload for development.
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { watch } from "chokidar";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface CanvasHostConfig {
  port?: number;
  canvasDir?: string;
  enableLiveReload?: boolean;
}

export class CanvasHost {
  private server: Server | null = null;
  private watcher: ReturnType<typeof watch> | null = null;
  private clients: Set<ServerResponse> = new Set();
  private config: Required<CanvasHostConfig>;

  constructor(config?: CanvasHostConfig) {
    this.config = {
      port: config?.port ?? 18793,
      canvasDir:
        config?.canvasDir ?? join(homedir(), ".kirie", "canvas"),
      enableLiveReload: config?.enableLiveReload ?? true,
    };
  }

  async start(): Promise<number> {
    const { port, canvasDir, enableLiveReload } = this.config;

    this.server = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url ?? "/";

        // SSE endpoint for live reload
        if (url === "/__live-reload") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          res.write("data: connected\n\n");
          this.clients.add(res);
          req.on("close", () => {
            this.clients.delete(res);
          });
          return;
        }

        // Serve static files
        const filePath = join(
          canvasDir,
          url === "/" ? "index.html" : url,
        );

        if (!existsSync(filePath)) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        try {
          const content = readFileSync(filePath);
          const ext = extname(filePath);
          const contentType =
            MIME_TYPES[ext] ?? "application/octet-stream";

          res.writeHead(200, { "Content-Type": contentType });

          // Inject live-reload script into HTML responses
          if (
            enableLiveReload &&
            ext === ".html"
          ) {
            const html = content.toString("utf-8");
            const script = `<script>
(function() {
  var es = new EventSource('/__live-reload');
  es.addEventListener('reload', function() { location.reload(); });
  es.onerror = function() { setTimeout(function() { location.reload(); }, 2000); };
})();
</script>`;
            res.end(html.replace("</body>", script + "</body>"));
          } else {
            res.end(content);
          }
        } catch {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      },
    );

    // Start file watcher for live reload
    if (enableLiveReload) {
      this.watcher = watch(canvasDir, {
        ignoreInitial: true,
        ignored: /(^|[/\\])\../,
      });
      this.watcher.on("all", () => {
        for (const client of this.clients) {
          client.write("event: reload\ndata: changed\n\n");
        }
      });
    }

    return new Promise<number>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(port, "127.0.0.1", () => {
        resolve(port);
      });
    });
  }

  stop(): void {
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.clients.clear();
  }
}
