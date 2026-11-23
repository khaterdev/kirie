import { describe, it, expect, vi, beforeEach } from "vitest";

// The tool reads and writes ~/.kirie/config.yaml. Every fs access is faked so no
// test can ever touch the real file.
const fsState = vi.hoisted(() => ({ content: "mcpServers: {}\n", writes: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => fsState.content),
    writeFileSync: vi.fn((_path: string, data: string) => { fsState.writes.push(data); fsState.content = data; }),
  };
});

const { createMcpServersToolHandlers } = await import("./mcp-servers.js");

describe("mcp_servers_add: computer use cannot be added by the agent", () => {
  beforeEach(() => {
    fsState.content = "mcpServers: {}\n";
    fsState.writes = [];
  });

  const add = (params: Record<string, unknown>) => createMcpServersToolHandlers().mcp_servers_add.handler(params) as Record<string, unknown>;

  it("rejects the reserved names", () => {
    for (const name of ["cua-driver", "cua-computer-use", "CUA-DRIVER"]) {
      expect(add({ name, command: "npx", args: ["x"] }).error, name).toMatch(/reserved for computer use/);
    }
    expect(fsState.writes).toEqual([]);
  });

  it("rejects any server whose command runs cua-driver, under any name", () => {
    for (const params of [
      { name: "desktop", command: "cua-driver", args: ["mcp"] },
      { name: "desktop", command: "/Users/tester/.local/bin/cua-driver", args: ["mcp"] },
      { name: "desktop", command: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" },
      { name: "desktop", command: "bash", args: ["-c", "cua-driver mcp"] },
    ]) {
      expect(add(params).error, JSON.stringify(params)).toMatch(/cannot be added/);
    }
    expect(fsState.writes).toEqual([]);
  });

  it("still adds an ordinary server", () => {
    const res = add({ name: "linear", command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"] });
    expect(res.success).toBe(true);
    expect(fsState.writes).toHaveLength(1);
    expect(fsState.writes[0]).toContain("linear");
  });
});
