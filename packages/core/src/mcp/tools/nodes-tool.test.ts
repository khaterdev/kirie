import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  resolveNodeId,
  saveBase64Media,
  createNodesToolHandlers,
  callGateway,
  NODES_ACTIONS,
  type NodeInfo,
} from "./nodes-tool.js";

// ── resolveNodeId ───────────────────────────────────────────────────────────

describe("resolveNodeId", () => {
  const nodes: NodeInfo[] = [
    {
      nodeId: "abc123def456",
      displayName: "My iPhone",
      connected: true,
      remoteIp: "192.168.1.10",
    },
    {
      nodeId: "xyz789ghi012",
      displayName: "Work Desktop",
      connected: false,
      remoteIp: "10.0.0.5",
    },
    {
      nodeId: "mno345pqr678",
      displayName: "Tablet",
      connected: true,
      remoteIp: "192.168.1.20",
    },
  ];

  describe("default selection (no query)", () => {
    it("returns the first connected node when no query is provided", () => {
      const result = resolveNodeId(nodes);
      expect(result).toBe("abc123def456");
    });

    it("returns the first node when none are connected", () => {
      const disconnected: NodeInfo[] = [
        { nodeId: "aaa111", connected: false },
        { nodeId: "bbb222", connected: false },
      ];
      const result = resolveNodeId(disconnected);
      expect(result).toBe("aaa111");
    });

    it("throws when node list is empty", () => {
      expect(() => resolveNodeId([])).toThrow("No nodes available");
    });

    it("throws when node list is empty and query is not provided", () => {
      expect(() => resolveNodeId([], undefined)).toThrow("No nodes available");
    });
  });

  describe("exact match by nodeId", () => {
    it("resolves an exact nodeId", () => {
      const result = resolveNodeId(nodes, "xyz789ghi012");
      expect(result).toBe("xyz789ghi012");
    });
  });

  describe("IP match", () => {
    it("resolves by IP address", () => {
      const result = resolveNodeId(nodes, "10.0.0.5");
      expect(result).toBe("xyz789ghi012");
    });

    it("resolves first matching IP address", () => {
      const result = resolveNodeId(nodes, "192.168.1.10");
      expect(result).toBe("abc123def456");
    });
  });

  describe("name match", () => {
    it("resolves by display name (case-insensitive)", () => {
      const result = resolveNodeId(nodes, "my iphone");
      expect(result).toBe("abc123def456");
    });

    it("resolves by display name with extra characters stripped", () => {
      const result = resolveNodeId(nodes, "Work Desktop");
      expect(result).toBe("xyz789ghi012");
    });

    it("resolves by normalized display name (spaces stripped)", () => {
      const result = resolveNodeId(nodes, "WorkDesktop");
      expect(result).toBe("xyz789ghi012");
    });
  });

  describe("prefix match", () => {
    it("resolves by nodeId prefix (6+ chars)", () => {
      const result = resolveNodeId(nodes, "abc123");
      expect(result).toBe("abc123def456");
    });

    it("does not resolve by nodeId prefix shorter than 6 chars", () => {
      expect(() => resolveNodeId(nodes, "abc12")).toThrow("Node not found: abc12");
    });
  });

  describe("not found", () => {
    it("throws when no match is found", () => {
      expect(() => resolveNodeId(nodes, "nonexistent-node")).toThrow(
        "Node not found: nonexistent-node",
      );
    });
  });
});

// ── saveBase64Media ─────────────────────────────────────────────────────────

describe("saveBase64Media", () => {
  // Use a temp directory to avoid polluting the real ~/.kirie directory
  const origHomedir = process.env.HOME;
  const TEST_HOME = `/tmp/kirie-nodes-test-${process.pid}`;

  beforeEach(() => {
    mkdirSync(TEST_HOME, { recursive: true });
    // Mock homedir by overriding HOME env var
    process.env.HOME = TEST_HOME;
  });

  afterEach(() => {
    process.env.HOME = origHomedir;
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it("saves base64 data to a file and returns the path", async () => {
    const content = "Hello, World!";
    const base64 = Buffer.from(content).toString("base64");

    // We need to mock homedir since it's imported at module level
    // Instead, let's just call saveBase64Media and check the result
    const { saveBase64Media: save } = await import("./nodes-tool.js");

    const filePath = await save(base64, "txt", "test");

    expect(filePath).toContain("test-");
    expect(filePath).toContain(".txt");
    expect(existsSync(filePath)).toBe(true);

    const written = readFileSync(filePath);
    expect(written.toString()).toBe(content);
  });

  it("creates the directory if it does not exist", async () => {
    const base64 = Buffer.from("data").toString("base64");
    const { saveBase64Media: save } = await import("./nodes-tool.js");

    const filePath = await save(base64, "bin", "media");

    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain("media-");
    expect(filePath).toContain(".bin");
  });

  it("generates unique filenames for each call", async () => {
    const base64 = Buffer.from("data").toString("base64");
    const { saveBase64Media: save } = await import("./nodes-tool.js");

    const path1 = await save(base64, "jpg", "snap");
    const path2 = await save(base64, "jpg", "snap");

    expect(path1).not.toBe(path2);
  });
});

// ── callGateway ─────────────────────────────────────────────────────────────

describe("callGateway", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST request with correct headers and body", async () => {
    const mockResponse = { result: { status: "ok" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(mockResponse), { status: 200 }),
    );

    const result = await callGateway("test.method", { key: "value" }, {
      url: "http://localhost:18789",
      token: "test-token",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:18789/rpc",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        }),
      }),
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(callBody.method).toBe("test.method");
    expect(callBody.params).toEqual({ key: "value" });
    expect(result).toEqual({ status: "ok" });
  });

  it("omits Authorization header when no token is provided", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: "ok" }), { status: 200 }),
    );

    await callGateway("test.method", {}, { url: "http://localhost:18789" });

    const callHeaders = (
      vi.mocked(fetch).mock.calls[0]![1] as RequestInit
    ).headers as Record<string, string>;
    expect(callHeaders.Authorization).toBeUndefined();
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await expect(
      callGateway("test.method", {}, { url: "http://localhost:18789" }),
    ).rejects.toThrow("Gateway RPC failed: 500");
  });

  it("throws on RPC error in response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Node offline" }), { status: 200 }),
    );

    await expect(
      callGateway("test.method", {}, { url: "http://localhost:18789" }),
    ).rejects.toThrow("Node offline");
  });
});

// ── Action dispatch (via createNodesToolHandlers) ───────────────────────────

describe("createNodesToolHandlers", () => {
  const opts = {
    gatewayUrl: "http://localhost:18789",
    gatewayToken: "test-token",
    defaultTimeout: 30_000,
  };

  it("creates a single 'nodes' tool handler", () => {
    const handlers = createNodesToolHandlers(opts);
    expect(handlers).toHaveProperty("nodes");
    expect(handlers.nodes.description).toContain("companion device nodes");
    expect(handlers.nodes.parameters.type).toBe("object");
    expect(handlers.nodes.parameters.required).toContain("action");
  });

  it("rejects invalid actions", async () => {
    const handlers = createNodesToolHandlers(opts);
    await expect(
      handlers.nodes.handler({ action: "invalid_action" }),
    ).rejects.toThrow('Invalid action "invalid_action"');
  });

  describe("action routing", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function mockRpcResponse(result: unknown) {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ result }), { status: 200 }),
      );
    }

    it("routes 'status' to nodes.status RPC", async () => {
      mockRpcResponse({ nodes: [] });
      const handlers = createNodesToolHandlers(opts);

      await handlers.nodes.handler({ action: "status" });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.status");
    });

    it("routes 'pending' to nodes.pending RPC", async () => {
      mockRpcResponse({ pending: [] });
      const handlers = createNodesToolHandlers(opts);

      await handlers.nodes.handler({ action: "pending" });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.pending");
    });

    it("routes 'approve' to nodes.approve RPC", async () => {
      mockRpcResponse({ approved: true });
      const handlers = createNodesToolHandlers(opts);

      await handlers.nodes.handler({ action: "approve", nodeId: "node-123" });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.approve");
      expect(body.params.nodeId).toBe("node-123");
    });

    it("throws when 'approve' is called without nodeId", async () => {
      const handlers = createNodesToolHandlers(opts);
      await expect(
        handlers.nodes.handler({ action: "approve" }),
      ).rejects.toThrow("nodeId is required for approve");
    });

    it("routes 'reject' to nodes.reject RPC", async () => {
      mockRpcResponse({ rejected: true });
      const handlers = createNodesToolHandlers(opts);

      await handlers.nodes.handler({ action: "reject", nodeId: "node-456" });

      const body = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.reject");
      expect(body.params.nodeId).toBe("node-456");
    });

    it("routes 'describe' to nodes.describe with resolved node", async () => {
      // First call returns nodes list (for resolveNodeId), second call is the actual describe
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: {
                nodes: [{ nodeId: "abc123def456", connected: true }],
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ result: { nodeId: "abc123def456", caps: ["camera"] } }),
            { status: 200 },
          ),
        );

      const handlers = createNodesToolHandlers(opts);
      await handlers.nodes.handler({ action: "describe", node: "abc123def456" });

      const secondBody = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(secondBody.method).toBe("nodes.describe");
      expect(secondBody.params.nodeId).toBe("abc123def456");
    });

    it("routes 'notify' with correct parameters", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { nodes: [{ nodeId: "node-1", connected: true }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { sent: true } }), { status: 200 }),
        );

      const handlers = createNodesToolHandlers(opts);
      await handlers.nodes.handler({
        action: "notify",
        title: "Alert",
        body: "Something happened",
        priority: "high",
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.notify");
      expect(body.params.title).toBe("Alert");
      expect(body.params.body).toBe("Something happened");
      expect(body.params.priority).toBe("high");
      expect(body.params.delivery).toBe("push"); // default
    });

    it("routes 'camera_list' to nodes.camera.list", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { nodes: [{ nodeId: "phone-1", connected: true }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ result: { cameras: ["front", "back"] } }),
            { status: 200 },
          ),
        );

      const handlers = createNodesToolHandlers(opts);
      const result = await handlers.nodes.handler({ action: "camera_list" });

      const body = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.camera.list");
      expect(result).toEqual({ cameras: ["front", "back"] });
    });

    it("routes 'location_get' with accuracy parameter", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { nodes: [{ nodeId: "phone-1", connected: true }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ result: { lat: 37.7749, lng: -122.4194 } }),
            { status: 200 },
          ),
        );

      const handlers = createNodesToolHandlers(opts);
      const result = await handlers.nodes.handler({
        action: "location_get",
        accuracy: "precise",
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.location.get");
      expect(body.params.accuracy).toBe("precise");
      expect(result).toEqual({ lat: 37.7749, lng: -122.4194 });
    });

    it("routes 'run' with command parameters", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { nodes: [{ nodeId: "desktop-1", connected: true }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ result: { exitCode: 0, stdout: "hello\n" } }),
            { status: 200 },
          ),
        );

      const handlers = createNodesToolHandlers(opts);
      const result = await handlers.nodes.handler({
        action: "run",
        command: "echo",
        args: ["hello"],
        cwd: "/tmp",
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.run");
      expect(body.params.command).toBe("echo");
      expect(body.params.args).toEqual(["hello"]);
      expect(body.params.cwd).toBe("/tmp");
      expect(result).toEqual({ exitCode: 0, stdout: "hello\n" });
    });

    it("routes 'invoke' with method and params", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              result: { nodes: [{ nodeId: "phone-1", connected: true }] },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ result: { ok: true } }),
            { status: 200 },
          ),
        );

      const handlers = createNodesToolHandlers(opts);
      const result = await handlers.nodes.handler({
        action: "invoke",
        method: "custom.action",
        params: { key: "value" },
      });

      const body = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(body.method).toBe("nodes.invoke");
      expect(body.params.method).toBe("custom.action");
      expect(body.params.params).toEqual({ key: "value" });
      expect(result).toEqual({ ok: true });
    });
  });
});

// ── NODES_ACTIONS constant ──────────────────────────────────────────────────

describe("NODES_ACTIONS", () => {
  it("contains all 13 expected actions", () => {
    expect(NODES_ACTIONS).toHaveLength(13);
    expect(NODES_ACTIONS).toContain("status");
    expect(NODES_ACTIONS).toContain("describe");
    expect(NODES_ACTIONS).toContain("pending");
    expect(NODES_ACTIONS).toContain("approve");
    expect(NODES_ACTIONS).toContain("reject");
    expect(NODES_ACTIONS).toContain("notify");
    expect(NODES_ACTIONS).toContain("camera_snap");
    expect(NODES_ACTIONS).toContain("camera_list");
    expect(NODES_ACTIONS).toContain("camera_clip");
    expect(NODES_ACTIONS).toContain("screen_record");
    expect(NODES_ACTIONS).toContain("location_get");
    expect(NODES_ACTIONS).toContain("run");
    expect(NODES_ACTIONS).toContain("invoke");
  });
});
