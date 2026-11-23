import { describe, it, expect } from "vitest";
import type { McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { ComputerUseConfigSchema } from "../config/sections/computer-use.js";
import {
  applyComputerUseSessionOptions,
  computerUseHiddenToolNames,
  computerUseOfferedToolNames,
  isComputerUseDriverServer,
  removeComputerUseServers,
} from "./mcp-config.js";

const HOME = "/Users/tester";
const cfg = ComputerUseConfigSchema.parse({ enabled: true });

function baseOptions(): Options {
  return {
    mcpServers: {
      "kirie-tools": { command: "node", args: ["stdio-server.js"] },
      "cua-driver": { command: "/x/cua-driver", args: ["mcp"] },
    },
    allowedTools: ["Read", "mcp__kirie-tools__memory_store", "mcp__cua-driver__*"],
    disallowedTools: ["WebSearch"],
  };
}

describe("applyComputerUseSessionOptions", () => {
  it("not offered: no cua server, no allowed cua entry, every known tool of both servers hidden by full name", () => {
    const options = baseOptions();
    const sharedServers = options.mcpServers!;
    const sharedAllowed = options.allowedTools!;
    applyComputerUseSessionOptions(options, false, cfg, HOME);
    expect(Object.keys(options.mcpServers!)).toEqual(["kirie-tools"]);
    expect(options.allowedTools).toEqual(["Read", "mcp__kirie-tools__memory_store"]);
    expect(options.disallowedTools).toContain("WebSearch");
    expect(options.disallowedTools).toContain("mcp__cua-driver__click");
    expect(options.disallowedTools).toContain("mcp__cua-driver__list_apps");
    expect(options.disallowedTools).toContain("mcp__cua-computer-use__click");
    // Full names only: E8 showed a server-level name hides nothing, so none is relied on.
    expect(options.disallowedTools).not.toContain("mcp__cua-driver");
    // The shared objects are untouched.
    expect(Object.keys(sharedServers)).toContain("cua-driver");
    expect(sharedAllowed).toContain("mcp__cua-driver__*");
  });

  it("offered: the stdio server with telemetry off, offered tools allowed, blocked tools hidden", () => {
    const options = baseOptions();
    applyComputerUseSessionOptions(options, true, cfg, HOME);
    expect(options.mcpServers!["cua-driver"]).toEqual({
      command: `${HOME}/.local/bin/cua-driver`, args: ["mcp"], env: { CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" },
    } satisfies McpServerConfig);
    expect(options.mcpServers!["kirie-tools"]).toBeDefined();
    expect(options.allowedTools).toContain("mcp__cua-driver__click");
    expect(options.allowedTools).toContain("mcp__cua-driver__get_window_state");
    expect(options.allowedTools).not.toContain("mcp__cua-driver__*");
    expect(options.allowedTools).not.toContain("mcp__cua-driver__run_script");
    expect(options.allowedTools).not.toContain("mcp__cua-driver__get_desktop_state");
    expect(options.disallowedTools).toContain("mcp__cua-driver__run_script");
    expect(options.disallowedTools).toContain("mcp__cua-driver__clipboard_read");
    expect(options.disallowedTools).toContain("mcp__cua-driver__get_desktop_state");
    expect(options.disallowedTools).not.toContain("mcp__cua-driver__click");
    expect(options.disallowedTools).toContain("mcp__cua-computer-use__click");
  });

  it("offered: a tool the call site already disallows stays disallowed and is not allowed", () => {
    const options = baseOptions();
    options.disallowedTools = ["mcp__cua-driver__type_text"];
    applyComputerUseSessionOptions(options, true, cfg, HOME);
    expect(options.disallowedTools).toContain("mcp__cua-driver__type_text");
    expect(options.allowedTools).not.toContain("mcp__cua-driver__type_text");
    expect(options.allowedTools).toContain("mcp__cua-driver__click");
  });

  it("offered with screenshots desktop also offers capture tools", () => {
    expect(computerUseOfferedToolNames(ComputerUseConfigSchema.parse({ screenshots: "desktop" }))).toContain("mcp__cua-driver__get_desktop_state");
    expect(computerUseOfferedToolNames(cfg)).not.toContain("mcp__cua-driver__zoom");
  });

  it("does not create mcpServers or allowedTools when the call site set none and nothing is offered", () => {
    const options: Options = {};
    applyComputerUseSessionOptions(options, false, cfg, HOME);
    expect(options.mcpServers).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.disallowedTools!.length).toBe(computerUseHiddenToolNames().length);
  });
});

describe("removeComputerUseServers and isComputerUseDriverServer", () => {
  it("removes the reserved names and any entry that runs the driver", () => {
    const servers: Record<string, McpServerConfig> = {
      "kirie-tools": { command: "node", args: ["x.js"] },
      "cua-driver": { command: "cua-driver", args: ["mcp"] },
      "cua-computer-use": { command: "npx", args: ["something"] },
      desktop: { command: "/Users/tester/.local/bin/cua-driver", args: ["mcp"] },
      wrapped: { command: "bash", args: ["-c", "exec cua-driver mcp"] },
      quoted: { command: "bash", args: ["-c", "$HOME/.local/bin/cua-dri''ver mcp"] },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    };
    expect(removeComputerUseServers(servers).sort()).toEqual(["cua-computer-use", "cua-driver", "desktop", "quoted", "wrapped"]);
    expect(Object.keys(servers).sort()).toEqual(["kirie-tools", "linear"]);
  });

  it("matches by basename and by any mention of the driver", () => {
    expect(isComputerUseDriverServer({ command: "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" })).toBe(true);
    expect(isComputerUseDriverServer({ command: "npx", args: ["-y", "@trycua/cua-driver"] })).toBe(true);
    expect(isComputerUseDriverServer({ command: "npx", args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"] })).toBe(false);
    expect(isComputerUseDriverServer(undefined)).toBe(false);
  });
});
