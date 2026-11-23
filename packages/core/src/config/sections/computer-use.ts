import { z } from "zod/v3";

/** `computerUse` (PLAN B.11, R5 item 13): desktop control through cua-driver. Arming is in memory only. */
export const ComputerUseConfigSchema = z.object({
  /** Master switch. Read at startup. */
  enabled: z.boolean().default(false),
  /** Absolute path to the cua-driver CLI. "~" is expanded. Never searched on PATH. */
  driverPath: z.string().default("~/.local/bin/cua-driver"),
  appPath: z.string().default("/Applications/CuaDriver.app"),
  /** Refuse to register the server unless codesign verifies and the identifier is com.trycua.driver. */
  requireSignedDriver: z.boolean().default(true),
  /** Default and maximum length of an arming window, in minutes. */
  armMinutes: z.number().int().min(1).default(15),
  maxArmMinutes: z.number().int().min(1).default(60),
  /** per-app: first acting call per app per window needs owner approval. */
  approval: z.enum(["per-app", "per-action", "armed-only"]).default("per-app"),
  approvalTimeoutSeconds: z.number().int().min(10).default(120),
  /** off: tree only. window: per-window captures. desktop: also full-display capture and zoom. */
  screenshots: z.enum(["off", "window", "desktop"]).default("window"),
  tools: z.object({
    /** Extra tool names to treat as "act". */
    allow: z.array(z.string()).default([]),
    /** Names to block even if built-in allowed. */
    deny: z.array(z.string()).default([]),
  }).default({}),
  /** Bundle ids. Empty allowedApps means "any app not denied". */
  allowedApps: z.array(z.string()).default([]),
  deniedApps: z.array(z.string()).default([
    "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords",
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  ]),
  observeOnlyApps: z.array(z.string()).default([
    "com.apple.Safari", "com.google.Chrome", "org.mozilla.firefox",
    "company.thebrowser.Browser", "com.brave.Browser", "com.microsoft.edgemac",
  ]),
  noTypingApps: z.array(z.string()).default([
    "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
    "com.mitchellh.ghostty", "com.microsoft.VSCode", "com.apple.dt.Xcode",
  ]),
  blockedHotkeys: z.array(z.string()).default([
    "cmd+shift+q", "cmd+opt+shift+q", "ctrl+cmd+q", "cmd+shift+delete",
    "cmd+opt+shift+delete", "cmd+opt+esc", "cmd+opt+delete",
  ]),
}).default({});

export type ComputerUseConfig = z.infer<typeof ComputerUseConfigSchema>;
