import { join } from "node:path";
import type { FeatureToolFactory } from "../feature-tools.js";
import { PluginApprovalStore, pluginApprovalsPath } from "../../plugins/approvals.js";
import { inspectPluginTree, listPluginDirectories } from "../../plugins/integrity.js";
import { peekPluginManifest } from "../../plugins/manifest.js";
import { isValidPluginName, KIRIE_PLUGINS_DIR_ENV } from "../../plugins/types.js";

interface PluginListRow {
  name: string;
  version?: string;
  approved: boolean;
  enabled: boolean;
  approvedAt?: string;
  events?: string[];
  capabilities?: string[];
  /** true: files differ from the approved hash; false: they match; null: could not be checked */
  changed?: boolean | null;
  problem?: string;
}

function manifestVersion(pluginsDir: string, name: string): { version?: string; problem?: string } {
  try {
    return { version: peekPluginManifest(pluginsDir, name).version };
  } catch (err) {
    return { problem: err instanceof Error ? err.message.slice(0, 160) : "unreadable manifest" };
  }
}

/**
 * Plugin tools (PLAN B.13, W3-PLUG). One read-only tool: `plugins_list`.
 * Reads the plugins directory and the approvals file; never imports a plugin,
 * never writes. There is deliberately no tool to approve, enable, disable or
 * reload a plugin: those are owner commands only.
 */
export const createPluginsTools: FeatureToolFactory = (ctx) => ({
  plugins_list: {
    description:
      "List Kirie plugins (read-only): name, version, whether the owner approved and enabled each one, its events, " +
      "and whether its files changed since approval. The master switch, live state and failure counts are in the " +
      "owner's /plugins command. Approving, enabling, disabling and reloading plugins are owner-only commands; no tool can do them.",
    parameters: { type: "object", properties: {} },
    handler: () => {
      const pluginsDir = ctx.env[KIRIE_PLUGINS_DIR_ENV] || join(ctx.dbDir, "plugins");
      const approvals = new PluginApprovalStore(pluginApprovalsPath(ctx.dbDir)).list();
      const byName = new Map(approvals.map((a) => [a.name, a]));
      const names = new Set<string>([...listPluginDirectories(pluginsDir).filter(isValidPluginName), ...byName.keys()]);
      const plugins: PluginListRow[] = [...names].sort().map((name) => {
        const a = byName.get(name);
        const row: PluginListRow = { name, approved: a !== undefined, enabled: a?.enabled ?? false };
        if (a) {
          row.version = a.version;
          row.approvedAt = a.approvedAt;
          row.events = a.events;
          row.capabilities = a.capabilities;
          try {
            row.changed = inspectPluginTree(pluginsDir, name).sha256 !== a.sha256;
          } catch (err) {
            row.changed = null;
            row.problem = err instanceof Error ? err.message.slice(0, 160) : "cannot check";
          }
        } else {
          Object.assign(row, manifestVersion(pluginsDir, name));
        }
        return row;
      });
      return {
        pluginsDir,
        plugins,
        note: "Read-only. Plugin approval and the on/off switch are owner commands (/plugins).",
      };
    },
  },
});
