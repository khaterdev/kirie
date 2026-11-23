/**
 * Computer use: every cua-driver tool name Kirie knows, in one place (PLAN C.13).
 *
 * Names come from cua.ai's MCP tool reference (R5 item 13), not from an
 * installed binary: diff them against `cua-driver list-tools` during the
 * owner's acceptance pass. Whatever is not listed here as observe, capture or
 * act is blocked, so a driver update that adds tools never widens access.
 */

export type ComputerUseToolClass = "observe" | "capture" | "act" | "blocked";

/** The server name Kirie registers, and the one the upstream installer writes to ~/.claude.json. */
export const COMPUTER_USE_SERVER_NAME = "cua-driver";
/** The other name the upstream uninstaller removes from ~/.claude.json. */
export const COMPUTER_USE_ALT_SERVER_NAME = "cua-computer-use";
export const COMPUTER_USE_SERVER_NAMES: readonly string[] = [COMPUTER_USE_SERVER_NAME, COMPUTER_USE_ALT_SERVER_NAME];
/** Reserved prefixes (same values as RESERVED_MCP_PREFIXES in engine/sdk-options.ts). */
export const COMPUTER_USE_MCP_PREFIX = `mcp__${COMPUTER_USE_SERVER_NAME}`;
export const COMPUTER_USE_ALT_MCP_PREFIX = `mcp__${COMPUTER_USE_ALT_SERVER_NAME}`;

/** Read-only tools. Pid-scoped ones still go through the app tiers. */
export const COMPUTER_USE_OBSERVE_TOOLS: readonly string[] = [
  "list_apps", "list_windows", "get_window_state", "verify_state", "get_screen_size", "get_cursor_position",
  "check_permissions", "health_report", "get_guide", "get_config",
  "start_session", "get_session", "list_sessions", "end_session",
];

/** Full-display capture: allowed only with `computerUse.screenshots: "desktop"`. */
export const COMPUTER_USE_CAPTURE_TOOLS: readonly string[] = ["get_desktop_state", "zoom"];

/** Tools that change something on screen. Each needs a resolvable target app. */
export const COMPUTER_USE_ACT_TOOLS: readonly string[] = [
  "click", "double_click", "right_click", "drag", "scroll", "move_cursor",
  "type_text", "press_key", "hotkey", "set_value",
  "launch_app", "bring_to_front", "invoke_menu", "set_window_frame",
];

/**
 * Known names that are always blocked. Listed so their full names can go into
 * `disallowedTools` (E8: a server-level name there hides nothing). Unknown
 * names are blocked too; this list only makes them invisible to the model.
 * `run_steps` is blocked rather than expanded (C.13 MVP: its step shape is undocumented).
 * `clipboard_write` is blocked: a clipboard the agent controls can be pasted
 * into a terminal through a menu, around the no-typing tier.
 */
export const COMPUTER_USE_BLOCKED_TOOLS: readonly string[] = [
  "run_steps", "run_script", "kill_app", "clipboard_read", "clipboard_write", "set_config", "install_extension", "check_for_update",
  "install_ffmpeg", "start_recording", "stop_recording", "get_recording_state", "replay_trajectory", "agent_display",
  "parse_visual_regions", "history_status", "history_query", "get_accessibility_tree", "page",
  "browser_navigate", "browser_click", "browser_type", "browser_eval", "browser_screenshot", "browser_download",
  "browser_upload", "set_agent_cursor_style", "set_agent_cursor_visible",
];

/** Acting tools that type or press keys: denied in `noTypingApps`. */
export const COMPUTER_USE_TYPING_TOOLS: readonly string[] = ["type_text", "press_key", "hotkey", "set_value"];
/** Also denied in `noTypingApps`: menus and context menus can paste, drag can drop text. */
export const COMPUTER_USE_NO_TYPING_EXTRA_TOOLS: readonly string[] = ["invoke_menu", "right_click", "drag"];
/** Observe tools that read one window: they must name its pid, so the app tiers apply. */
export const COMPUTER_USE_WINDOW_OBSERVE_TOOLS: readonly string[] = ["get_window_state", "verify_state"];
/** Acting tools whose key combination is checked against `blockedHotkeys`. */
export const COMPUTER_USE_KEY_TOOLS: readonly string[] = ["press_key", "hotkey"];
/** Acting tools whose text is checked with the approvals dangerous-text classifier and audited as a length only. */
export const COMPUTER_USE_TEXT_TOOLS: readonly string[] = ["type_text", "set_value", "press_key", "hotkey"];

/** Every known tool name, bare (no prefix). */
export function computerUseKnownToolNames(): string[] {
  return [
    ...COMPUTER_USE_OBSERVE_TOOLS,
    ...COMPUTER_USE_CAPTURE_TOOLS,
    ...COMPUTER_USE_ACT_TOOLS,
    ...COMPUTER_USE_BLOCKED_TOOLS,
  ];
}

/** "mcp__cua-driver__click" -> "click"; null for anything that is not a computer-use server tool. */
export function computerUseBareToolName(tool: string): { server: string; name: string } | null {
  for (const server of COMPUTER_USE_SERVER_NAMES) {
    const prefix = `mcp__${server}__`;
    if (tool.startsWith(prefix) && tool.length > prefix.length) return { server, name: tool.slice(prefix.length) };
  }
  return null;
}

/** True for any tool name or allow/deny entry that targets a computer-use server ("mcp__cua-driver__*", "mcp__cua-driver"). */
export function isComputerUseToolName(name: string): boolean {
  return COMPUTER_USE_SERVER_NAMES.some((server) => {
    const prefix = `mcp__${server}`;
    return name === prefix || name.startsWith(`${prefix}__`) || name === `${prefix}*`;
  });
}

/**
 * Tool class, fail closed. `tools.deny` blocks a name; `tools.allow` adds an
 * unknown name as "act". Neither can unblock a built-in blocked tool.
 */
export function classifyComputerUseTool(name: string, overrides: { allow: readonly string[]; deny: readonly string[] }): ComputerUseToolClass {
  if (overrides.deny.includes(name)) return "blocked";
  if (COMPUTER_USE_BLOCKED_TOOLS.includes(name)) return "blocked";
  if (COMPUTER_USE_OBSERVE_TOOLS.includes(name)) return "observe";
  if (COMPUTER_USE_CAPTURE_TOOLS.includes(name)) return "capture";
  if (COMPUTER_USE_ACT_TOOLS.includes(name)) return "act";
  if (overrides.allow.includes(name)) return "act";
  return "blocked";
}
