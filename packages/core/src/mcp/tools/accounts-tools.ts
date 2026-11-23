import type { FeatureToolFactory } from "../feature-tools.js";
import type { McpToolDefinition } from "../server.js";

/**
 * Claude account tools (PLAN B.13, W2-ACC).
 * Tools: accounts_list, accounts_discover, accounts_set_enabled, accounts_use, accounts_set_rotation, accounts_reset, accounts_import.
 *
 * Every tool proxies to the daemon's /api/accounts routes, which enforce
 * `accounts.agentTools` again and audit each change. The accounts feature
 * sets KIRIE_ACCOUNTS_AGENT_TOOLS ("read" or "manage") in the kirie-tools env;
 * without it there are no tools. No tool removes an account, takes an
 * arbitrary path or changes the fallback chain; accounts_import asks the
 * owner first. The factory is pure: nothing is opened until a handler runs.
 */

export const ACCOUNTS_AGENT_TOOLS_ENV = "KIRIE_ACCOUNTS_AGENT_TOOLS";

const REQUEST_TIMEOUT_MS = 15_000;
/** accounts_import waits for the owner's tap (the daemon caps the wait below this). */
const IMPORT_TIMEOUT_MS = 270_000;

const SESSION_KEY_PARAM = {
  type: "string" as const,
  description: "Your session_key from <session_context>, recorded in the audit trail",
};

async function call(baseUrl: string, method: "GET" | "POST", path: string, payload?: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  try {
    const res = await fetch(`${baseUrl}/api/accounts${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json();
  } catch (err) {
    return { error: `the daemon did not answer: ${err instanceof Error ? err.name : "error"}` };
  }
}

function sessionKeyOf(params: Record<string, unknown>): Record<string, unknown> {
  return typeof params.session_key === "string" ? { session_key: params.session_key } : {};
}

export const createAccountsTools: FeatureToolFactory = (ctx) => {
  const mode = ctx.env[ACCOUNTS_AGENT_TOOLS_ENV];
  const baseUrl = ctx.gatewayUrl;
  if (!baseUrl || (mode !== "read" && mode !== "manage")) return {};

  const tools: Record<string, McpToolDefinition> = {
    accounts_list: {
      description:
        "List Kirie's Claude accounts: which is active, each one's status (ok, limited until, needs login, disabled), whether rotation is on, the earliest reset, and the model fallback chain with benched models.",
      parameters: { type: "object", properties: {}, required: [] },
      // "" not "/": the gateway mounts the sub-app at /api/accounts and matches paths strictly.
      handler: () => call(baseUrl, "GET", ""),
    },
    accounts_discover: {
      description: "List the ~/.claude* config dirs on this machine, whether each looks logged in, and whether it is imported. Spawns nothing and uses no quota.",
      parameters: { type: "object", properties: {}, required: [] },
      handler: () => call(baseUrl, "GET", "/discover"),
    },
  };
  if (mode !== "manage") return tools;

  tools.accounts_import = {
    description:
      "Ask the owner to import a config dir that accounts_discover listed. The owner gets Approve/Deny buttons; nothing is imported without Approve. Returns the new account or why it was not imported.",
    parameters: {
      type: "object",
      properties: {
        config_dir: { type: "string", description: "A config_dir exactly as accounts_discover returned it" },
        session_key: SESSION_KEY_PARAM,
      },
      required: ["config_dir"],
    },
    handler: (params) =>
      call(baseUrl, "POST", "/import", { config_dir: String(params.config_dir ?? ""), ...sessionKeyOf(params) }, IMPORT_TIMEOUT_MS),
  };
  tools.accounts_set_enabled = {
    description: "Enable or disable an imported Claude account. Applies from the next turn. The owner is told.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Account id from accounts_list" },
        enabled: { type: "boolean", description: "true to enable, false to disable" },
        session_key: SESSION_KEY_PARAM,
      },
      required: ["id", "enabled"],
    },
    handler: (params) =>
      call(baseUrl, "POST", `/${encodeURIComponent(String(params.id ?? ""))}/enabled`, { enabled: params.enabled === true, ...sessionKeyOf(params) }),
  };
  tools.accounts_use = {
    description: "Make an imported Claude account the active one from the next turn. The owner is told.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Account id from accounts_list" }, session_key: SESSION_KEY_PARAM },
      required: ["id"],
    },
    handler: (params) => call(baseUrl, "POST", `/${encodeURIComponent(String(params.id ?? ""))}/use`, sessionKeyOf(params)),
  };
  tools.accounts_set_rotation = {
    description: "Turn automatic account rotation on or off. The owner is told.",
    parameters: {
      type: "object",
      properties: { enabled: { type: "boolean", description: "true for on" }, session_key: SESSION_KEY_PARAM },
      required: ["enabled"],
    },
    handler: (params) => call(baseUrl, "POST", "/rotation", { enabled: params.enabled === true, ...sessionKeyOf(params) }),
  };
  tools.accounts_reset = {
    description: "Clear the limit or login error recorded for an account (for example after the owner logged in again). The owner is told.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Account id from accounts_list" }, session_key: SESSION_KEY_PARAM },
      required: ["id"],
    },
    handler: (params) => call(baseUrl, "POST", `/${encodeURIComponent(String(params.id ?? ""))}/reset`, sessionKeyOf(params)),
  };
  return tools;
};
