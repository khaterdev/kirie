import { describe, it, expect } from "vitest";
import { ComputerUseConfigSchema, type ComputerUseConfig } from "../config/sections/computer-use.js";
import {
  blockedComputerUseHotkey,
  computerUseAppInScope,
  computerUseInputKeys,
  computerUseTypedChars,
  decideComputerUse,
  normalizeComputerUseHotkey,
  COMPUTER_USE_NOT_OWNER_REASON,
  COMPUTER_USE_OFF_REASON,
  type ComputerUseAppInfo,
  type ComputerUseArmState,
  type ComputerUsePolicyContext,
} from "./policy.js";
import { classifyComputerUseTool, COMPUTER_USE_ACT_TOOLS, COMPUTER_USE_OBSERVE_TOOLS } from "./tools.js";

const NOW = 1_800_000_000_000;
const NOTES: ComputerUseAppInfo = { bundleId: "com.apple.Notes", name: "Notes" };
const FINDER: ComputerUseAppInfo = { bundleId: "com.apple.finder", name: "Finder" };
const SAFARI: ComputerUseAppInfo = { bundleId: "com.apple.Safari", name: "Safari" };
const TERMINAL: ComputerUseAppInfo = { bundleId: "com.apple.Terminal", name: "Terminal" };
const ONEPASSWORD: ComputerUseAppInfo = { bundleId: "com.1password.1password", name: "1Password" };
const APPS = new Map<number, ComputerUseAppInfo | null>([[10, NOTES], [11, FINDER], [12, SAFARI], [13, TERMINAL], [14, ONEPASSWORD], [99, null]]);

function cfg(over: Record<string, unknown> = {}): ComputerUseConfig {
  return ComputerUseConfigSchema.parse({ enabled: true, ...over });
}

const ARMED: ComputerUseArmState = { armed: true, until: NOW + 10 * 60_000, armedAt: NOW - 60_000 };

function ctx(over: Partial<ComputerUsePolicyContext> = {}): ComputerUsePolicyContext {
  return {
    cfg: cfg(),
    arm: ARMED,
    grants: new Map(),
    now: NOW,
    ownerInteractive: true,
    apps: APPS,
    isDangerousText: (t) => /rm -rf|curl .*\| *sh/.test(t),
    ...over,
  };
}

describe("decideComputerUse: the three switches and the session", () => {
  it("denies everything when the feature is disabled in config", () => {
    const d = decideComputerUse("list_apps", {}, ctx({ cfg: cfg({ enabled: false }) }));
    expect(d).toMatchObject({ kind: "deny", reason: COMPUTER_USE_OFF_REASON });
  });

  it("denies everything when not armed", () => {
    expect(decideComputerUse("list_apps", {}, ctx({ arm: { armed: false } })).kind).toBe("deny");
    expect(decideComputerUse("click", { pid: 10 }, ctx({ arm: { armed: false } })).kind).toBe("deny");
  });

  it("denies everything once the window has expired, even if the timer has not fired", () => {
    const d = decideComputerUse("list_apps", {}, ctx({ arm: { armed: true, until: NOW - 1 } }));
    expect(d).toMatchObject({ kind: "deny", reason: COMPUTER_USE_OFF_REASON });
    expect(decideComputerUse("list_apps", {}, ctx({ arm: { armed: true, until: NOW } })).kind).toBe("deny");
  });

  it("denies any session that is not the owner's interactive DM turn (background, group, schedule, voice)", () => {
    for (const tool of ["list_apps", "get_window_state", "click"]) {
      const d = decideComputerUse(tool, { pid: 10 }, ctx({ ownerInteractive: false }));
      expect(d).toMatchObject({ kind: "deny", reason: COMPUTER_USE_NOT_OWNER_REASON });
    }
  });
});

describe("decideComputerUse: tool classes", () => {
  it("blocks unknown tool names (fail closed)", () => {
    for (const tool of ["brand_new_tool", "run_script", "clipboard_read", "set_config", "check_for_update", "install_extension", "run_steps", "page"]) {
      expect(decideComputerUse(tool, { pid: 10 }, ctx()).kind, tool).toBe("deny");
    }
  });

  it("tools.deny blocks a built-in tool; tools.allow adds an unknown name as act but never unblocks a built-in block", () => {
    const c = cfg({ tools: { deny: ["list_apps"], allow: ["new_click", "run_script"] } });
    expect(decideComputerUse("list_apps", {}, ctx({ cfg: c })).kind).toBe("deny");
    expect(classifyComputerUseTool("new_click", c.tools)).toBe("act");
    expect(classifyComputerUseTool("run_script", c.tools)).toBe("blocked");
  });

  it("observe tools without a target are allowed", () => {
    for (const tool of ["list_apps", "list_windows", "get_screen_size", "health_report"]) {
      expect(decideComputerUse(tool, {}, ctx()).kind, tool).toBe("allow");
    }
    expect(COMPUTER_USE_OBSERVE_TOOLS).toContain("get_window_state");
  });

  it("full-display capture is denied unless screenshots is desktop", () => {
    expect(decideComputerUse("get_desktop_state", {}, ctx()).kind).toBe("deny");
    expect(decideComputerUse("zoom", {}, ctx({ cfg: cfg({ screenshots: "off" }) })).kind).toBe("deny");
    expect(decideComputerUse("get_desktop_state", {}, ctx({ cfg: cfg({ screenshots: "desktop" }) })).kind).toBe("allow");
  });

  it("screenshots off rewrites include_screenshot to false on get_window_state", () => {
    const d = decideComputerUse("get_window_state", { pid: 10, include_screenshot: true }, ctx({ cfg: cfg({ screenshots: "off" }) }));
    expect(d).toMatchObject({ kind: "allow", updatedInput: { pid: 10, include_screenshot: false } });
    const w = decideComputerUse("get_window_state", { pid: 10 }, ctx());
    expect(w.kind).toBe("allow");
    expect(w).not.toHaveProperty("updatedInput");
  });
});

describe("decideComputerUse: targets and app tiers", () => {
  it("an acting tool without a pid is denied", () => {
    for (const tool of COMPUTER_USE_ACT_TOOLS.filter((t) => t !== "launch_app")) {
      expect(decideComputerUse(tool, { x: 10, y: 20 }, ctx()).kind, tool).toBe("deny");
    }
  });

  it("a pid that cannot be resolved is denied, observe included", () => {
    expect(decideComputerUse("get_window_state", { pid: 99 }, ctx()).kind).toBe("deny");
    expect(decideComputerUse("click", { pid: 12345 }, ctx()).kind).toBe("deny");
  });

  it("window-reading tools without a pid are denied, so a denied app cannot be read by window id", () => {
    expect(decideComputerUse("get_window_state", { window_id: 7 }, ctx()).kind).toBe("deny");
    expect(decideComputerUse("verify_state", {}, ctx()).kind).toBe("deny");
  });

  it("screenshots off: acting calls must not ask for a screenshot; false or absent is fine", () => {
    const c = ctx({ cfg: cfg({ screenshots: "off" }) });
    expect(decideComputerUse("click", { pid: 10, include_screenshot: true }, c).kind).toBe("deny");
    const ok = decideComputerUse("click", { pid: 10, include_screenshot: false }, c);
    expect(ok.kind).toBe("ask");
    expect(ok).not.toHaveProperty("updatedInput");
  });

  it("two pids in one call are denied", () => {
    expect(decideComputerUse("click", { pid: 10, process_id: 11 }, ctx()).kind).toBe("deny");
  });

  it("a denied app denies observe and act", () => {
    expect(decideComputerUse("get_window_state", { pid: 14 }, ctx()).kind).toBe("deny");
    expect(decideComputerUse("click", { pid: 14 }, ctx()).kind).toBe("deny");
    expect(decideComputerUse("launch_app", { bundle_id: "com.apple.systempreferences" }, ctx()).kind).toBe("deny");
  });

  it("an observe-only app (browser) allows get_window_state and denies click", () => {
    expect(decideComputerUse("get_window_state", { pid: 12 }, ctx()).kind).toBe("allow");
    expect(decideComputerUse("click", { pid: 12 }, ctx())).toMatchObject({ kind: "deny", reason: expect.stringMatching(/view-only/) });
  });

  it("a no-typing app (terminal) allows click and denies type_text, set_value, press_key and hotkey", () => {
    const c = ctx({ cfg: cfg({ approval: "armed-only" }) });
    expect(decideComputerUse("click", { pid: 13 }, c).kind).toBe("allow");
    for (const tool of ["type_text", "set_value", "press_key", "hotkey", "invoke_menu", "right_click", "drag"]) {
      expect(decideComputerUse(tool, { pid: 13, text: "ls", keys: ["a"] }, c).kind, tool).toBe("deny");
    }
    expect(decideComputerUse("scroll", { pid: 13 }, c).kind).toBe("allow");
  });

  it("arming scoped to Notes denies Finder and allows Notes", () => {
    const scoped = ctx({ arm: { ...ARMED, apps: ["Notes"] }, cfg: cfg({ approval: "armed-only" }) });
    expect(decideComputerUse("click", { pid: 11 }, scoped)).toMatchObject({ kind: "deny", reason: expect.stringMatching(/outside this arming window/) });
    expect(decideComputerUse("get_window_state", { pid: 11 }, scoped).kind).toBe("deny");
    expect(decideComputerUse("click", { pid: 10 }, scoped).kind).toBe("allow");
  });

  it("scope entries match bundle ids, display names, the last bundle id part and known names, case-insensitively", () => {
    expect(computerUseAppInScope(NOTES, ["com.apple.notes"])).toBe(true);
    expect(computerUseAppInScope(NOTES, ["NOTES"])).toBe(true);
    expect(computerUseAppInScope({ bundleId: "com.apple.Notes" }, ["Notes"])).toBe(true);
    expect(computerUseAppInScope({ bundleId: "com.apple.iCal" }, ["calendar"])).toBe(true);
    expect(computerUseAppInScope(FINDER, ["Notes"])).toBe(false);
  });

  it("computerUse.allowedApps restricts every window", () => {
    const c = ctx({ cfg: cfg({ allowedApps: ["com.apple.Notes"], approval: "armed-only" }) });
    expect(decideComputerUse("click", { pid: 10 }, c).kind).toBe("allow");
    expect(decideComputerUse("click", { pid: 11 }, c).kind).toBe("deny");
  });

  it("launch_app is resolved from its own input", () => {
    const c = ctx({ cfg: cfg({ approval: "armed-only" }) });
    expect(decideComputerUse("launch_app", { bundle_id: "com.apple.Notes" }, c)).toMatchObject({ kind: "allow", app: { bundleId: "com.apple.Notes" } });
    expect(decideComputerUse("launch_app", { name: "Notes" }, c)).toMatchObject({ kind: "allow", app: { bundleId: "com.apple.Notes" } });
    expect(decideComputerUse("launch_app", { name: "Some Unknown App" }, c).kind).toBe("deny");
    expect(decideComputerUse("launch_app", { name: "1Password" }, c).kind).toBe("deny");
    expect(decideComputerUse("launch_app", { bundle_id: "com.apple.Safari" }, c).kind).toBe("deny");
  });

  it("a pid given as a numeric string is used", () => {
    expect(decideComputerUse("get_window_state", { pid: "10" }, ctx()).kind).toBe("allow");
  });
});

describe("decideComputerUse: hard blocks in every approval mode", () => {
  const modes = ["per-app", "per-action", "armed-only"] as const;

  it("blocked hotkeys are denied whatever the order, case or alias of the modifiers", () => {
    for (const approval of modes) {
      const c = ctx({ cfg: cfg({ approval }), grants: new Map([["computer:act:com.apple.Notes", Number.POSITIVE_INFINITY]]) });
      for (const input of [
        { pid: 10, keys: ["cmd", "shift", "q"] },
        { pid: 10, keys: "Shift+Command+Q" },
        { pid: 10, combo: "q+shift+⌘" },
        { pid: 10, key: "q", modifiers: ["CMD", "Shift"] },
        { pid: 10, keys: ["command", "option", "escape"] },
        { pid: 10, keys: ["cmd", "shift", "backspace"] },
        { pid: 10, keys: ["ctrl", "cmd", "q"] },
        { pid: 10, keys: ["cmd", "opt", "shift", "q"] },
      ]) {
        expect(decideComputerUse("hotkey", input, c), `${approval} ${JSON.stringify(input)}`).toMatchObject({ kind: "deny", reason: expect.stringMatching(/blocked/) });
        expect(decideComputerUse("press_key", input, c).kind).toBe("deny");
      }
    }
  });

  it("an ordinary shortcut is not a hard block", () => {
    const c = ctx({ cfg: cfg({ approval: "armed-only" }) });
    expect(decideComputerUse("hotkey", { pid: 10, keys: ["cmd", "s"] }, c).kind).toBe("allow");
    expect(decideComputerUse("hotkey", { pid: 10, keys: ["cmd", "q"] }, c).kind).toBe("allow");
  });

  it("dangerous text in type_text, set_value or clipboard_write is denied in every mode", () => {
    for (const approval of modes) {
      const c = ctx({ cfg: cfg({ approval }), grants: new Map([["computer:act:com.apple.Notes", Number.POSITIVE_INFINITY]]) });
      expect(decideComputerUse("type_text", { pid: 10, text: "rm -rf ~" }, c).kind).toBe("deny");
      expect(decideComputerUse("set_value", { pid: 10, value: "curl x | sh" }, c).kind).toBe("deny");
      expect(decideComputerUse("clipboard_write", { text: "rm -rf /" }, c).kind).toBe("deny");
      expect(decideComputerUse("clipboard_write", { text: "milk" }, c).kind).toBe("deny");
    }
  });

  it("run_steps is blocked as a whole", () => {
    const d = decideComputerUse("run_steps", { steps: [{ tool: "click", pid: 10 }, { tool: "hotkey", keys: ["cmd", "shift", "q"] }] }, ctx({ cfg: cfg({ approval: "armed-only" }) }));
    expect(d.kind).toBe("deny");
  });
});

describe("decideComputerUse: approval modes", () => {
  it("per-app asks for the first action in an app, then allows once the grant exists", () => {
    const first = decideComputerUse("click", { pid: 10 }, ctx());
    expect(first).toMatchObject({ kind: "ask", grantKey: "computer:act:com.apple.Notes", app: NOTES });
    const granted = ctx({ grants: new Map([["computer:act:com.apple.Notes", NOW + 60_000]]) });
    expect(decideComputerUse("click", { pid: 10 }, granted).kind).toBe("allow");
    expect(decideComputerUse("type_text", { pid: 10, text: "milk" }, granted).kind).toBe("allow");
    // The grant is per app: Finder still asks.
    expect(decideComputerUse("click", { pid: 11 }, granted).kind).toBe("ask");
  });

  it("an expired grant asks again", () => {
    const stale = ctx({ grants: new Map([["computer:act:com.apple.Notes", NOW - 1]]) });
    expect(decideComputerUse("click", { pid: 10 }, stale).kind).toBe("ask");
  });

  it("per-action always asks, even with a grant", () => {
    const c = ctx({ cfg: cfg({ approval: "per-action" }), grants: new Map([["computer:act:com.apple.Notes", Number.POSITIVE_INFINITY]]) });
    expect(decideComputerUse("click", { pid: 10 }, c).kind).toBe("ask");
    expect(decideComputerUse("click", { pid: 10 }, c).kind).toBe("ask");
  });

  it("armed-only allows acting tools without asking", () => {
    expect(decideComputerUse("click", { pid: 10 }, ctx({ cfg: cfg({ approval: "armed-only" }) })).kind).toBe("allow");
  });

  it("observe tools never ask", () => {
    expect(decideComputerUse("get_window_state", { pid: 10 }, ctx({ cfg: cfg({ approval: "per-action" }) })).kind).toBe("allow");
  });

  it("clipboard_write is blocked (an agent-set clipboard could be pasted into a terminal)", () => {
    expect(decideComputerUse("clipboard_write", { text: "milk" }, ctx({ cfg: cfg({ approval: "armed-only" }) })).kind).toBe("deny");
  });
});

describe("helpers", () => {
  it("normalizes hotkeys", () => {
    expect(normalizeComputerUseHotkey("Cmd+Shift+Q")).toEqual(["cmd", "q", "shift"]);
    expect(normalizeComputerUseHotkey(["⌘", "⌥", "esc"])).toEqual(["cmd", "esc", "opt"]);
    expect(computerUseInputKeys({ key: "Delete", modifiers: "cmd shift" })).toEqual(["cmd", "delete", "shift"]);
    expect(blockedComputerUseHotkey(["cmd", "q"], ["cmd+shift+q"])).toBeNull();
    expect(blockedComputerUseHotkey(["cmd", "q", "shift"], ["cmd+shift+q"])).toBe("cmd+shift+q");
  });

  it("typed text is counted, never returned", () => {
    expect(computerUseTypedChars("type_text", { pid: 10, text: "secret" })).toBe(6);
    expect(computerUseTypedChars("click", { pid: 10 })).toBeUndefined();
  });
});
