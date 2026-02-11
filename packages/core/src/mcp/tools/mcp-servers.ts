/**
 * MCP tool handlers for managing external MCP servers.
 *
 * Provides list/add/remove operations for the mcpServers section
 * of config.yaml, allowing Kirie to self-manage its MCP server
 * connections without manual config editing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const CONFIG_PATH = join(homedir(), ".kirie", "config.yaml");

/**
 * Read the raw config.yaml and return the parsed object.
 */
function readConfig(): Record<string, unknown> {
  const content = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parseYaml(content);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.yaml is not a valid YAML mapping");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Write the config object back to config.yaml, preserving YAML formatting.
 */
function writeConfig(config: Record<string, unknown>): void {
  const yaml = stringifyYaml(config, { lineWidth: 120 });
  writeFileSync(CONFIG_PATH, yaml, "utf-8");
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

/**
 * Create MCP tool handlers for managing external MCP servers.
 */
export function createMcpServersToolHandlers() {
  return {
    mcp_servers_list: {
      description:
        "List all configured external MCP servers from config.yaml. " +
        "Shows each server's name, type (stdio/http), enabled status, and configuration details.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as const,
      },
      handler() {
        const config = readConfig();
        const mcpServers = (config.mcpServers ?? {}) as Record<string, McpServerEntry>;

        const servers = Object.entries(mcpServers).map(([name, entry]) => ({
          name,
          type: entry.url ? "http" : "stdio",
          enabled: entry.enabled !== false,
          ...(entry.command ? { command: entry.command } : {}),
          ...(entry.args?.length ? { args: entry.args } : {}),
          ...(entry.url ? { url: entry.url } : {}),
          ...(entry.env && Object.keys(entry.env).length > 0
            ? { env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, String(v).includes("$") ? "(contains variable reference)" : v])) }
            : {}),
          ...(entry.headers && Object.keys(entry.headers).length > 0
            ? { headers: Object.fromEntries(Object.entries(entry.headers).map(([k]) => [k, "(set)"])) }
            : {}),
        }));

        return {
          servers,
          count: servers.length,
          note: "The built-in 'kirie-tools' server is always present and managed automatically. It is not listed here.",
        };
      },
    },

    mcp_servers_add: {
      description:
        "Add a new external MCP server to config.yaml. Supports stdio servers (command + args + env) " +
        "and HTTP/SSE servers (url + headers). After adding, Kirie must be restarted to connect " +
        "to the new server. The 'kirie-tools' name is reserved and cannot be used.",
      parameters: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Unique name for the MCP server (e.g. 'linear', 'github', 'filesystem')",
          },
          command: {
            type: "string" as const,
            description: "Command to spawn the server (stdio mode). E.g. 'npx', 'node', 'python'",
          },
          args: {
            type: "array" as const,
            description: "Arguments for the command. E.g. ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp']",
          },
          env: {
            type: "object" as const,
            description: "Environment variables for the server process. Supports ${VAR_NAME} for referencing system env vars.",
          },
          url: {
            type: "string" as const,
            description: "URL for HTTP/SSE MCP servers (remote mode). Mutually exclusive with command.",
          },
          headers: {
            type: "object" as const,
            description: "HTTP headers for remote servers. Supports ${VAR_NAME} interpolation.",
          },
          enabled: {
            type: "boolean" as const,
            description: "Whether the server is enabled (default: true)",
          },
        },
        required: ["name"] as const,
      },
      handler(params: Record<string, unknown>) {
        const name = params.name as string;

        if (!name || typeof name !== "string") {
          return { error: "name is required and must be a string" };
        }

        if (name === "kirie-tools") {
          return { error: "'kirie-tools' is a reserved name and cannot be used for external MCP servers" };
        }

        const command = params.command as string | undefined;
        const args = params.args as string[] | undefined;
        const env = params.env as Record<string, string> | undefined;
        const url = params.url as string | undefined;
        const headers = params.headers as Record<string, string> | undefined;
        const enabled = params.enabled as boolean | undefined;

        if (!command && !url) {
          return { error: "Either 'command' (for stdio) or 'url' (for HTTP/SSE) must be provided" };
        }

        if (command && url) {
          return { error: "Cannot specify both 'command' and 'url'. Use one transport mode." };
        }

        const config = readConfig();
        if (!config.mcpServers || typeof config.mcpServers !== "object") {
          config.mcpServers = {};
        }
        const mcpServers = config.mcpServers as Record<string, McpServerEntry>;

        const entry: McpServerEntry = {};

        if (command) {
          entry.command = command;
          if (args && args.length > 0) entry.args = args;
          if (env && Object.keys(env).length > 0) entry.env = env;
        } else if (url) {
          entry.url = url;
          if (headers && Object.keys(headers).length > 0) entry.headers = headers;
        }

        if (enabled === false) {
          entry.enabled = false;
        }

        const existed = name in mcpServers;
        mcpServers[name] = entry;
        writeConfig(config);

        return {
          success: true,
          action: existed ? "updated" : "added",
          name,
          type: url ? "http" : "stdio",
          note: "Kirie must be restarted for this change to take effect. Use the gateway_restart tool to restart.",
        };
      },
    },

    mcp_servers_remove: {
      description:
        "Remove an external MCP server from config.yaml. After removing, Kirie must be restarted " +
        "for the change to take effect. The built-in 'kirie-tools' server cannot be removed.",
      parameters: {
        type: "object" as const,
        properties: {
          name: {
            type: "string" as const,
            description: "Name of the MCP server to remove",
          },
        },
        required: ["name"] as const,
      },
      handler(params: Record<string, unknown>) {
        const name = params.name as string;

        if (!name || typeof name !== "string") {
          return { error: "name is required and must be a string" };
        }

        if (name === "kirie-tools") {
          return { error: "'kirie-tools' is the built-in server and cannot be removed" };
        }

        const config = readConfig();
        const mcpServers = (config.mcpServers ?? {}) as Record<string, McpServerEntry>;

        if (!(name in mcpServers)) {
          return { error: `MCP server '${name}' not found in config` };
        }

        delete mcpServers[name];
        config.mcpServers = mcpServers;

        // Clean up empty mcpServers section
        if (Object.keys(mcpServers).length === 0) {
          delete config.mcpServers;
        }

        writeConfig(config);

        return {
          success: true,
          removed: name,
          note: "Kirie must be restarted for this change to take effect. Use the gateway_restart tool to restart.",
        };
      },
    },
  };
}
