# Computer use (desktop control)

Kirie can control apps on this Mac through the open-source [cua-driver](https://github.com/trycua/cua) from trycua. The driver reads a window's accessibility tree and sends clicks and keystrokes to one app at a time, in the background: it does not move your cursor or steal focus.

The feature ships **off**. It is built and unit-tested, but it has **not been accepted live**: that needs the driver installed and macOS permissions granted by you, then the manual check at the end of this page.

## How it is switched on

Three independent switches. All three must be on for any desktop action to run.

1. **macOS permissions** on `CuaDriver.app` (Accessibility and Screen Recording). You give these in System Settings. Kirie never asks for them and never grants them.
2. **`computerUse.enabled: true`** in `~/.kirie/config.yaml`. Read when Kirie starts.
3. **An arming window** that you open in your Telegram DM with `/computer on [minutes] [app ...]`. It is held in memory only: a restart always comes up disarmed. It closes by itself when the time is up, or at once with `/computer off`.

Only you can arm it. No MCP tool and no HTTP route can arm it, approve an action or change these settings.

## Commands (owner only, in your DM)

| Command | What it does |
|---|---|
| `/computer status` | Runs the read-only driver check and shows: config flag, driver version, app signature, daemon running, Accessibility, Screen Recording, attribution, armed or not, minutes left, app scope, approval mode, screenshot mode, the last five computer-use events |
| `/computer on [minutes] [app ...]` | Asks you to confirm (the card shows the limits below), then arms for `minutes` (default `computerUse.armMinutes`, 15; capped at `maxArmMinutes`, 60). Optional app names or bundle ids limit the window to those apps: `/computer on 10 Notes` |
| `/computer off` | Closes the window, clears every app approval and runs `cua-driver stop`. Works even when `computerUse.enabled` is false: it is the kill switch |

## Who can use it

Only the main conversation in your own DM, for messages you sent. Never a group chat, a scheduled message, a `/loop` or `/goal` turn, a background task, a webhook, a subagent, or a voice call. The `cua-driver` MCP server is added only to the spawn of your DM session while armed; every other session never sees it, and its tools are listed by full name in `disallowedTools`. The `reserved-mcp` and `computer-use` tool gates deny every call that should not run, whatever was registered elsewhere.

## The policy (checked on every call, in this order)

1. Feature off, not armed, or the window has ended: denied.
2. Not your own DM turn: denied.
3. Tool not on the allowlist: denied. Unknown tool names are denied, so a driver update cannot widen access. Always denied: `run_steps`, `run_script`, `kill_app`, `clipboard_read`, `clipboard_write` (a clipboard the agent sets could be pasted into a terminal through a menu), `set_config`, `install_extension`, `check_for_update`, recording and replay tools, the driver's own browser tools.
4. Full-screen capture (`get_desktop_state`, `zoom`): only with `computerUse.screenshots: "desktop"`.
5. With `screenshots: "off"`, `get_window_state` is forced to `include_screenshot: false`, and an acting call that asks for a screenshot is denied.
6. Every action, and every tool that reads one window (`get_window_state`, `verify_state`), must name the target window's `pid` (or `launch_app` its bundle id), so the app tiers always apply. Kirie looks up the app with `lsappinfo` (read-only). `list_apps` and `list_windows` need no pid and show the names and titles of every window, denied apps included.
7. App tiers, by bundle id:
   - `deniedApps` (System Settings, Keychain Access, Passwords, 1Password, Bitwarden): nothing, not even reading.
   - `observeOnlyApps` (browsers): read only. Use Kirie's own `browser` tool for the web.
   - `noTypingApps` (Terminal, iTerm, Warp, Ghostty, VS Code, Xcode): click, double-click and scroll allowed; typing, keys, menus (`invoke_menu`), context menus (`right_click`) and drag denied, because typing or pasting into a terminal is a shell outside the approval gate.
   - If the window was armed for named apps, every other app is denied.
8. Hard blocks in every approval mode: the `blockedHotkeys` combinations (log out, lock screen, empty trash, force quit, force delete; modifier order, case and symbols do not matter), and typed text that the approvals classifier (`isDangerousText`) reads as a dangerous shell command.
9. Reading tools are allowed.
10. Acting tools follow `computerUse.approval`:
    - `per-app` (default): the first action in each app asks you (Approve / Deny in your DM; no answer within `approvalTimeoutSeconds` means deny). Approve covers that app until the window closes.
    - `per-action`: every action asks.
    - `armed-only`: arming is the approval.
    This is independent of the global `/approvals` mode.

Every decision is written to the audit trail (`~/.kirie/logs/audit.jsonl`, feature `computer-use`). Typed text is recorded as a character count only.

## Limits: read these before turning it on

- **Screenshots cannot be scrubbed.** Kirie's secret scrubber works on text; it cannot see pixels. A screenshot goes to the model provider as an image and is stored in the session transcript under `~/.claude*/projects/`. Anything visible in the captured window (a token in a terminal, a message, a bank balance) goes with it. Mitigations: captures are window-only by default (`screenshots: "window"`), denied apps are never captured, and the agent is told to read the accessibility tree first and to ask for a screenshot only when the tree is not enough. Set `screenshots: "off"` for tree-only control. Accessibility-tree text is text: it is scrubbed where it is shown in a chat, but it still reaches the model.
- **In yolo mode, `/computer off` is a kill switch and a tripwire, not a sandbox.** The agent has unrestricted Bash. Once `CuaDriver.app` has its macOS grants, any process running as you can drive it, including a shell command the agent runs. While `computerUse.enabled` is true, Kirie's `computer-use` gate looks at what a shell command (Bash, Monitor, PowerShell) actually runs: running `cua-driver` (directly, through `npx` and similar, or under a computed name) or opening `CuaDriver.app` is denied while disarmed; while armed only read-only `cua-driver` subcommands may run; `permissions grant`, `connect`, `update`, `serve`, `install`, `config set` and `telemetry enable` and the app bundle's own executables are always denied. A command that only mentions the driver (`grep cua-driver`, a commit message, `ls /Applications/CuaDriver.app`) passes. With `computerUse.enabled: false` (the default) the tripwire denies nothing. That stops the obvious forms, not a determined script (`osascript`, `cliclick`, a helper written to disk). In `ask` approval mode, the approvals rule `sys.desktop` also asks before `cua-driver`, `cliclick` and `screencapture` run from Bash. The hard off switches are: `cua-driver stop`, revoking the two grants, or uninstalling the driver.
- **Inherited MCP servers.** The upstream installer registers `cua-driver` in `~/.claude.json` by default, and Kirie's sessions inherit user-scope MCP servers unless `agent.strictMcpConfig` is on (it is off by default). When the feature is off or not armed, Kirie lists every known tool of an inherited `cua-driver` or `cua-computer-use` server by full name in `disallowedTools` (a server-level name there hides nothing), and its gates deny every call to those prefixes. Still: **turn on `agent.strictMcpConfig: true`** and keep the driver out of `~/.claude.json` (step 5 below). That flag also stops your other user-scope servers and the claude.ai connectors from loading into Kirie; move the ones you want into Kirie's own `mcpServers` config.
- **The gates match the server names `cua-driver` and `cua-computer-use`.** Kirie removes every server from its own config that runs the driver, and `mcp_servers_add` refuses one, but it cannot see a copy registered under another name in `~/.claude.json`. With `agent.strictMcpConfig` off, such a copy would be ungated. Another reason to turn that flag on.
- **The driver binary is checked when probed, not on every spawn.** With `requireSignedDriver` (default), `/computer on` verifies the app bundle and the `cua-driver` CLI (same signing team) before running either; the agent could still swap the file afterwards from Bash in yolo mode. `/computer off` re-verifies the CLI before running `cua-driver stop`.
- `/undo` does not cover anything done on the desktop.
- On-screen text is untrusted. A web page, an email or a chat message can contain instructions aimed at the agent. The policy above does not depend on the model behaving; the prompt also tells the agent never to type passwords, 2FA codes or card numbers and never to click macOS security dialogs.
- The driver relies on private macOS APIs and moves fast upstream; an OS or driver update can break it or reset its grants (`/computer status` then shows the permissions as missing).

## Setup (you, at the keyboard)

Kirie never installs, updates, grants permissions to, connects or reconfigures the driver. Until you do the steps below, `/computer status` and `/computer on` report "not installed" with these steps.

1. Download the installer, read it, then install without its side effects (by default it registers itself with Claude Code, Codex and Cursor, installs skills, edits your shell rc and runs a TextEdit typing test):
   ```
   curl -fsSL https://cua.ai/driver/install.sh -o /tmp/cua-install.sh
   less /tmp/cua-install.sh
   bash /tmp/cua-install.sh --no-connect --no-test --no-modify-path
   ```
   Optional: pin a version with `CUA_DRIVER_RS_VERSION=<x.y.z>`, and add `--require-signature` if `cosign` is installed. Result: `/Applications/CuaDriver.app` and `~/.local/bin/cua-driver`. (Flag spellings come from the installer's header and are not verified end to end.)
2. `cua-driver telemetry disable`. Kirie also sets `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` on the server it starts (variable name from Hermes' docs, not from cua's).
3. From Terminal, not from Kirie: `cua-driver permissions grant`, then enable **CuaDriver** under System Settings > Privacy & Security > **Accessibility** and > **Screen & System Audio Recording**. Never grant these to `node` or `bash`: that would give them to everything Kirie runs.
4. Check: `cua-driver permissions status --json` shows both granted with attribution `driver-daemon`, and `cua-driver doctor` is clean.
5. Keep the driver out of your interactive Claude config unless you want it there: `claude mcp list` should not show `cua-driver` (remove it with `claude mcp remove cua-driver --scope user`). Then set `agent.strictMcpConfig: true` in `~/.kirie/config.yaml`.
6. In `~/.kirie/config.yaml`:
   ```yaml
   computerUse:
     enabled: true
     # optional: approval: per-app | per-action | armed-only
     # optional: screenshots: window | off | desktop
   ```
   Restart Kirie.
7. Acceptance check, in your Telegram DM: `/computer status` (everything green), then `/computer on 10 Notes`, then ask for something harmless ("open my shopping note and add milk"). Approve the Notes card. Then `/computer off`, and check that the next desktop action is denied. Until this pass is done, computer use counts as "built, not accepted live".

Config keys (all optional): `driverPath` (absolute, `~` expanded, never searched on PATH), `appPath`, `requireSignedDriver` (default true: `codesign --verify` must pass and the identifier must be `com.trycua.driver`), `armMinutes`, `maxArmMinutes`, `approval`, `approvalTimeoutSeconds`, `screenshots`, `tools.allow` (extra tool names to treat as acting tools; cannot unblock a built-in blocked tool), `tools.deny`, `allowedApps`, `deniedApps`, `observeOnlyApps`, `noTypingApps`, `blockedHotkeys`.

## Removing it

`/computer off`; then `tccutil reset Accessibility com.trycua.driver` and `tccutil reset ScreenCapture com.trycua.driver`; then the upstream uninstaller (`https://cua.ai/driver/uninstall.sh`, read it first); then `computerUse.enabled: false`.

## Not verified (open checks for the acceptance pass)

These come from upstream documentation, not from an installed binary:

- The driver's tool names and input fields (`pid`, `include_screenshot`, the hotkey fields). Diff Kirie's list in `packages/core/src/computer-use/tools.ts` against `cua-driver list-tools`; anything Kirie does not know is denied.
- The JSON field names of `cua-driver permissions status --json` and the attribution value. Kirie's reader is tolerant and `/computer status` says what it could not read.
- That `cua-driver mcp` starts the CuaDriver daemon by itself when Kirie (a launchd process) spawns it, and that attribution then reads `driver-daemon`.
- The output of `lsappinfo info -only name <pid>` (the bundle id form is verified on this Mac).
- That `~/.local/bin/cua-driver` is code-signed by the same team as `CuaDriver.app`. If it is not (for example a plain copy rather than a link into the bundle), `/computer status` reports it and arming is refused; `requireSignedDriver: false` turns off both signature checks, at your own risk.
- Behaviour with the screen locked or asleep.

## The browser tool (separate, already on when `browser.enabled`)

Kirie's headless `browser` tool is unrelated to desktop control. `snapshot` returns the page's ARIA tree as text, and `screenshot` saves a PNG under `~/.kirie/media/screenshots/` (folder 0700, file 0600, deleted after 24 hours) and returns its path: the agent views it with `Read` and sends it with a `MEDIA:` line. The page's URL is checked against the SSRF guard again after `navigate`, `click` and `evaluate` (also when they throw) and before `snapshot` and `screenshot`. The guard cannot see requests the page's own JavaScript makes (`fetch` inside `evaluate`). The Playwright version Kirie installs is pinned (`PLAYWRIGHT_VERSION` in `browser-tool.ts`).
