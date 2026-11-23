/**
 * Loopback routes behind the accounts MCP tools (PLAN B.9, B.13), mounted at
 * /api/accounts. Any local process can reach them, so they are bounded:
 * read, enable, disable, use, reset, toggle rotation, and import of a
 * discovered dir only after the owner taps Approve. Never remove, never an
 * arbitrary path, never a fallback-chain change. Every change is audited with
 * an `agent:` actor and the owner is told.
 *
 * `accounts.agentTools` is enforced here too: "off" refuses everything,
 * "read" only the two GET routes.
 */

import { Hono, type Context } from "hono";
import type { FallbackConfig } from "../config/sections/fallback.js";
import type { RuntimeSettings } from "../config/runtime-settings.js";
import type { OwnerPrompts } from "../interaction/owner-prompts.js";
import { resolveFallbackChain } from "../engine/model-chain.js";
import { AccountImportError, type AccountManager } from "./account-manager.js";
import { ACCOUNT_ID_RE } from "./account-store.js";
import { ACCOUNTS_ROTATION_SETTING } from "./commands.js";
import type { FallbackControl } from "./fallback-control.js";
import { ACCOUNTS_MCP_NOTE, displayPath } from "./notices.js";

export type AccountsAgentToolsMode = "off" | "read" | "manage";

export interface AccountsInternalApiDeps {
  manager: AccountManager;
  fallback: FallbackControl;
  settings: Pick<RuntimeSettings, "set">;
  agentTools: () => AccountsAgentToolsMode;
  rotationEnabled: () => boolean;
  fallbackConfig: () => FallbackConfig;
  primaryModel: () => string;
  requestApproval: OwnerPrompts["requestApproval"];
  approvalTimeoutMs: number;
  notifyOwner: (text: string, opts?: { key?: string }) => Promise<void>;
  home?: string;
}

const SESSION_KEY_RE = /^[A-Za-z0-9_.@:-]{1,128}$/;

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const parsed = (await c.req.json()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function agentActor(b: Record<string, unknown>): string {
  const key = typeof b.session_key === "string" && SESSION_KEY_RE.test(b.session_key) ? b.session_key : "unknown";
  return `agent:${key}`;
}

export function createAccountsInternalApi(deps: AccountsInternalApiDeps): Hono {
  const app = new Hono();
  const m = deps.manager;

  const allowed = (c: Context, need: "read" | "manage"): Response | null => {
    const mode = deps.agentTools();
    if (mode === "manage" || (mode === "read" && need === "read")) return null;
    return c.json({ error: `accounts.agentTools is "${mode}"` }, 403);
  };

  const tell = (text: string, key: string): void => {
    void deps.notifyOwner(text, { key }).catch(() => undefined);
  };

  app.get("/", (c) => {
    const denied = allowed(c, "read");
    if (denied) return denied;
    const cfg = deps.fallbackConfig();
    return c.json({
      accounts: m.list().map((a) => ({
        id: a.id,
        kind: a.kind,
        dir: a.configDir ? displayPath(a.configDir, deps.home) : "~/.claude (default login)",
        label: a.label,
        subscription: a.subscription,
        enabled: a.enabled,
        status: a.status,
        limitedUntil: a.limitedUntil ? new Date(a.limitedUntil).toISOString() : null,
        limitType: a.limitType,
        active: a.active,
      })),
      activeId: m.activeAccountId(),
      rotation: { enabled: deps.rotationEnabled() },
      earliestReset: (() => {
        const e = m.earliestReset();
        return e ? { accountId: e.accountId, at: new Date(e.atMs).toISOString() } : null;
      })(),
      fallback: {
        enabled: cfg.enabled,
        models: resolveFallbackChain(deps.primaryModel(), cfg.models),
        benched: deps.fallback.benched().map((b) => ({
          accountId: b.accountId,
          model: b.model,
          until: new Date(b.limitedUntil).toISOString(),
          reason: b.reason,
        })),
      },
      note: ACCOUNTS_MCP_NOTE,
    });
  });

  app.get("/discover", (c) => {
    const denied = allowed(c, "read");
    if (denied) return denied;
    return c.json({
      dirs: m.discover().map((d) => ({
        config_dir: displayPath(d.path, deps.home),
        kind: d.kind,
        suggestedId: d.suggestedId,
        label: d.identity.ok ? d.identity.identity.label : null,
        loggedIn: d.login,
        importedAs: d.importedAs,
      })),
    });
  });

  app.post("/import", async (c) => {
    const denied = allowed(c, "manage");
    if (denied) return denied;
    const b = await body(c);
    const actor = agentActor(b);
    const raw = typeof b.config_dir === "string" ? b.config_dir : "";
    const target = m.discover().find((d) => d.path === raw || displayPath(d.path, deps.home) === raw);
    if (!target) return c.json({ imported: false, reason: "not a directory listed by accounts_discover" }, 400);
    if (target.importedAs) return c.json({ imported: false, reason: `already imported as ${target.importedAs}` }, 400);

    const label = target.identity.ok ? target.identity.identity.label : "no identity";
    const where = displayPath(target.path, deps.home);
    const answer = await deps.requestApproval({
      kind: "accounts",
      title: `Import Claude account ${where}?`,
      body: `The agent asks to import ${where} (${label}) as a Claude account Kirie may use. Importing trusts that directory's settings.json and hooks. Requested by ${actor}.`,
      timeoutMs: deps.approvalTimeoutMs,
    });
    if (answer.outcome !== "approved") {
      return c.json({ imported: false, reason: `the owner did not approve (${answer.outcome})` });
    }
    try {
      const out = await m.importDir(target.path, { actor, onlyDiscovered: true });
      return c.json({
        imported: true,
        account: { id: out.account.id, enabled: out.account.enabled, status: out.account.status, label: out.account.label },
        verified: out.verify ? out.verify.ok : null,
      });
    } catch (err) {
      return c.json({ imported: false, reason: err instanceof AccountImportError ? err.message : "import failed" }, 400);
    }
  });

  const idParam = (c: Context): string | null => {
    const id = c.req.param("id") ?? "";
    return ACCOUNT_ID_RE.test(id) ? id : null;
  };

  app.post("/:id/enabled", async (c) => {
    const denied = allowed(c, "manage");
    if (denied) return denied;
    const id = idParam(c);
    const b = await body(c);
    if (!id || typeof b.enabled !== "boolean") return c.json({ error: "id and a boolean enabled are required" }, 400);
    try {
      const acc = m.setEnabled(id, b.enabled, agentActor(b));
      tell(`The agent ${b.enabled ? "enabled" : "disabled"} Claude account ${id}. Undo with /accounts ${b.enabled ? "disable" : "enable"} ${id}.`, `accounts:agent:enabled:${id}`);
      return c.json({ id: acc.id, enabled: acc.enabled });
    } catch (err) {
      return c.json({ error: err instanceof AccountImportError ? err.message : "failed" }, 400);
    }
  });

  app.post("/:id/use", async (c) => {
    const denied = allowed(c, "manage");
    if (denied) return denied;
    const id = idParam(c);
    const b = await body(c);
    if (!id) return c.json({ error: "invalid id" }, 400);
    try {
      const out = m.use(id, agentActor(b));
      tell(`The agent switched the active Claude account to ${id}. ${ACCOUNTS_MCP_NOTE}`, `accounts:agent:use:${id}`);
      return c.json({ activeId: out.account.id, clearedLimit: out.clearedLimit, appliesFrom: "next turn" });
    } catch (err) {
      return c.json({ error: err instanceof AccountImportError ? err.message : "failed" }, 400);
    }
  });

  app.post("/:id/reset", async (c) => {
    const denied = allowed(c, "manage");
    if (denied) return denied;
    const id = idParam(c);
    const b = await body(c);
    // One named account only: the agent cannot reset every account at once.
    if (!id || id === "all" || !m.get(id)) return c.json({ error: "invalid id" }, 400);
    try {
      m.reset(id, agentActor(b));
      tell(`The agent cleared the limit or login error of Claude account ${id}.`, `accounts:agent:reset:${id}`);
      return c.json({ id, reset: true });
    } catch (err) {
      return c.json({ error: err instanceof AccountImportError ? err.message : "failed" }, 400);
    }
  });

  app.post("/rotation", async (c) => {
    const denied = allowed(c, "manage");
    if (denied) return denied;
    const b = await body(c);
    if (typeof b.enabled !== "boolean") return c.json({ error: "a boolean enabled is required" }, 400);
    deps.settings.set(ACCOUNTS_ROTATION_SETTING, b.enabled, agentActor(b));
    tell(`The agent turned account rotation ${b.enabled ? "on" : "off"}. Undo with /rotation ${b.enabled ? "off" : "on"}.`, "accounts:agent:rotation");
    return c.json({ rotation: { enabled: deps.rotationEnabled() } });
  });

  return app;
}
