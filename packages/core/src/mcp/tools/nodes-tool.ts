/**
 * MCP tool handlers for interacting with companion device nodes (phones, desktops)
 * via the gateway RPC protocol. Provides discovery, notifications, camera, screen,
 * location, and system command capabilities.
 */

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────────────

export interface NodeInfo {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  caps?: string[];
  commands?: string[];
  connected?: boolean;
  paired?: boolean;
  remoteIp?: string;
  deviceFamily?: string;
}

export interface NodesToolOptions {
  gatewayUrl: string;
  gatewayToken?: string;
  defaultTimeout?: number;
}

export const NODES_ACTIONS = [
  "status", "describe", "pending", "approve", "reject",
  "notify", "camera_snap", "camera_list", "camera_clip",
  "screen_record", "location_get", "run", "invoke",
] as const;

export type NodesAction = (typeof NODES_ACTIONS)[number];

// ── Gateway RPC client ──────────────────────────────────────────────────────

export async function callGateway(
  method: string,
  params: Record<string, unknown>,
  opts: { url: string; token?: string; timeoutMs?: number },
): Promise<unknown> {
  const res = await fetch(`${opts.url}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`Gateway RPC failed: ${res.status}`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ── Node resolution ─────────────────────────────────────────────────────────

export function resolveNodeId(nodes: NodeInfo[], query?: string): string {
  if (!query) {
    const connected = nodes.filter((n) => n.connected);
    const target = connected[0] ?? nodes[0];
    if (!target) throw new Error("No nodes available");
    return target.nodeId;
  }

  // Exact match by nodeId
  const exact = nodes.find((n) => n.nodeId === query);
  if (exact) return exact.nodeId;

  // Match by IP
  const byIp = nodes.find((n) => n.remoteIp === query);
  if (byIp) return byIp.nodeId;

  // Match by display name (normalized)
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const byName = nodes.find(
    (n) => n.displayName && normalize(n.displayName) === normalize(query),
  );
  if (byName) return byName.nodeId;

  // Match by nodeId prefix (minimum 6 characters)
  if (query.length >= 6) {
    const byPrefix = nodes.find((n) => n.nodeId.startsWith(query));
    if (byPrefix) return byPrefix.nodeId;
  }

  throw new Error(`Node not found: ${query}`);
}

// ── Media save helper ───────────────────────────────────────────────────────

export async function saveBase64Media(
  base64: string,
  ext: string,
  kind: string,
): Promise<string> {
  const dir = join(homedir(), ".kirie", "media", "nodes");
  await mkdir(dir, { recursive: true });
  const filename = `${kind}-${randomUUID()}.${ext}`;
  const filePath = join(dir, filename);
  await writeFile(filePath, Buffer.from(base64, "base64"));
  return filePath;
}

// ── Action dispatch ─────────────────────────────────────────────────────────

async function dispatchAction(
  action: NodesAction,
  params: Record<string, unknown>,
  opts: NodesToolOptions,
): Promise<unknown> {
  const rpc = (method: string, rpcParams: Record<string, unknown>) =>
    callGateway(method, rpcParams, {
      url: opts.gatewayUrl,
      token: opts.gatewayToken,
      timeoutMs: opts.defaultTimeout,
    });

  const fetchNodes = async (): Promise<NodeInfo[]> => {
    const result = (await rpc("nodes.status", {})) as { nodes: NodeInfo[] };
    return result.nodes ?? [];
  };

  switch (action) {
    // ── Discovery & Management ────────────────────────────────────────────

    case "status": {
      return rpc("nodes.status", {});
    }

    case "describe": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      return rpc("nodes.describe", { nodeId });
    }

    case "pending": {
      return rpc("nodes.pending", {});
    }

    case "approve": {
      const nodeId = params.nodeId as string;
      if (!nodeId) throw new Error("nodeId is required for approve");
      return rpc("nodes.approve", { nodeId });
    }

    case "reject": {
      const nodeId = params.nodeId as string;
      if (!nodeId) throw new Error("nodeId is required for reject");
      return rpc("nodes.reject", { nodeId });
    }

    // ── Notifications ─────────────────────────────────────────────────────

    case "notify": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      return rpc("nodes.notify", {
        nodeId,
        title: params.title as string,
        body: params.body as string,
        priority: params.priority ?? "normal",
        delivery: params.delivery ?? "push",
      });
    }

    // ── Camera ────────────────────────────────────────────────────────────

    case "camera_snap": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      const result = (await rpc("nodes.camera.snap", {
        nodeId,
        facing: params.facing ?? "back",
        maxWidth: params.maxWidth ?? 1920,
        quality: params.quality ?? 85,
      })) as { base64: string; mimeType?: string };

      const ext = (result.mimeType ?? "image/jpeg").split("/")[1] ?? "jpg";
      const filePath = await saveBase64Media(result.base64, ext, "snap");
      return { filePath, mimeType: result.mimeType ?? "image/jpeg" };
    }

    case "camera_list": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      return rpc("nodes.camera.list", { nodeId });
    }

    case "camera_clip": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      const result = (await rpc("nodes.camera.clip", {
        nodeId,
        facing: params.facing ?? "back",
        durationMs: params.durationMs ?? 5000,
      })) as { base64: string; mimeType?: string };

      const ext = (result.mimeType ?? "video/mp4").split("/")[1] ?? "mp4";
      const filePath = await saveBase64Media(result.base64, ext, "clip");
      return { filePath, mimeType: result.mimeType ?? "video/mp4" };
    }

    // ── Screen ────────────────────────────────────────────────────────────

    case "screen_record": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      const timeoutMs = ((params.durationMs as number | undefined) ?? 10_000) + 15_000;
      const result = (await callGateway(
        "nodes.screen.record",
        {
          nodeId,
          durationMs: params.durationMs ?? 10_000,
          fps: params.fps ?? 15,
          screenIndex: params.screenIndex ?? 0,
        },
        {
          url: opts.gatewayUrl,
          token: opts.gatewayToken,
          timeoutMs,
        },
      )) as { base64: string; mimeType?: string };

      const ext = (result.mimeType ?? "video/mp4").split("/")[1] ?? "mp4";
      const filePath = await saveBase64Media(result.base64, ext, "screen");
      return { filePath, mimeType: result.mimeType ?? "video/mp4" };
    }

    // ── Location ──────────────────────────────────────────────────────────

    case "location_get": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      return rpc("nodes.location.get", {
        nodeId,
        accuracy: params.accuracy ?? "balanced",
      });
    }

    // ── System ────────────────────────────────────────────────────────────

    case "run": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      const runTimeout = (params.timeoutMs as number | undefined) ?? 30_000;
      return callGateway(
        "nodes.run",
        {
          nodeId,
          command: params.command as string,
          args: params.args ?? [],
          env: params.env ?? {},
          cwd: params.cwd,
          timeoutMs: runTimeout,
        },
        {
          url: opts.gatewayUrl,
          token: opts.gatewayToken,
          timeoutMs: runTimeout + 10_000,
        },
      );
    }

    case "invoke": {
      const nodes = await fetchNodes();
      const nodeId = resolveNodeId(nodes, params.node as string | undefined);
      return rpc("nodes.invoke", {
        nodeId,
        method: params.method as string,
        params: params.params ?? {},
      });
    }

    default: {
      throw new Error(`Unknown nodes action: ${action as string}`);
    }
  }
}

// ── Tool handler factory ────────────────────────────────────────────────────

export function createNodesToolHandlers(opts: NodesToolOptions) {
  return {
    nodes: {
      description:
        "Interact with companion device nodes (phones, desktops) via the gateway. " +
        "Supports discovery (status, describe, pending, approve, reject), " +
        "notifications (notify), camera (camera_snap, camera_list, camera_clip), " +
        "screen (screen_record), location (location_get), and system commands (run, invoke). " +
        "Use 'status' first to discover available nodes, then target actions at a specific node.",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            description:
              "The action to perform. One of: " + NODES_ACTIONS.join(", "),
          },
          node: {
            type: "string",
            description:
              "Target node identifier. Can be a nodeId, IP address, display name, or nodeId prefix (min 6 chars). " +
              "If omitted, the first connected node is used.",
          },
          nodeId: {
            type: "string",
            description: "Node ID for approve/reject actions.",
          },
          title: {
            type: "string",
            description: "Notification title (for notify action).",
          },
          body: {
            type: "string",
            description: "Notification body (for notify action).",
          },
          priority: {
            type: "string",
            description:
              "Notification priority: low, normal, high (for notify action). Default: normal.",
          },
          delivery: {
            type: "string",
            description:
              "Notification delivery method: push, sms (for notify action). Default: push.",
          },
          facing: {
            type: "string",
            description:
              "Camera facing: front, back (for camera_snap, camera_clip). Default: back.",
          },
          maxWidth: {
            type: "number",
            description:
              "Maximum image width in pixels (for camera_snap). Default: 1920.",
          },
          quality: {
            type: "number",
            description:
              "JPEG quality 1-100 (for camera_snap). Default: 85.",
          },
          durationMs: {
            type: "number",
            description:
              "Duration in milliseconds (for camera_clip, screen_record). Default: 5000 for clip, 10000 for screen.",
          },
          fps: {
            type: "number",
            description:
              "Frames per second (for screen_record). Default: 15.",
          },
          screenIndex: {
            type: "number",
            description:
              "Screen index to record (for screen_record). Default: 0.",
          },
          accuracy: {
            type: "string",
            description:
              "Location accuracy: coarse, balanced, precise (for location_get). Default: balanced.",
          },
          command: {
            type: "string",
            description: "Shell command to execute (for run action).",
          },
          args: {
            type: "array",
            description: "Command arguments (for run action).",
          },
          env: {
            type: "object",
            description: "Environment variables (for run action).",
          },
          cwd: {
            type: "string",
            description: "Working directory (for run action).",
          },
          timeoutMs: {
            type: "number",
            description:
              "Timeout in milliseconds (for run action). Default: 30000.",
          },
          method: {
            type: "string",
            description: "RPC method name (for invoke action).",
          },
          params: {
            type: "object",
            description: "RPC method parameters (for invoke action).",
          },
        },
        required: ["action"] as const,
      },
      async handler(params: Record<string, unknown>) {
        const action = params.action as string;
        if (!NODES_ACTIONS.includes(action as NodesAction)) {
          throw new Error(
            `Invalid action "${action}". Must be one of: ${NODES_ACTIONS.join(", ")}`,
          );
        }
        return dispatchAction(action as NodesAction, params, opts);
      },
    },
  };
}
