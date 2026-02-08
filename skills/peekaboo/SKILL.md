---
name: peekaboo
description: macOS UI automation via AppleScript and Accessibility APIs
emoji: "\U0001F440"
version: "1.0.0"
os:
  - darwin
requires:
  bins:
    - osascript
invocation:
  userInvocable: true
---

# Peekaboo (macOS UI Automation)

Automate macOS desktop interactions using AppleScript, System Events, and built-in system utilities. Inspect windows, click UI elements, type text, and take targeted screenshots.

## Usage
- "List all open windows"
- "Activate the Safari app"
- "Click the Submit button in the frontmost window"
- "Type 'hello world' into the focused text field"
- "Take a screenshot of the Notes window"
- "Read the title of every open Finder window"
- "Get the position and size of the Chrome window"

## How it works
Uses `osascript` to run AppleScript and JavaScript for Automation (JXA) scripts that interact with macOS System Events and application processes. Capabilities include:

### Window and app management
- List running applications and their windows via `System Events`
- Activate, minimize, or close application windows
- Get window positions, sizes, and titles
- Move or resize windows

### UI interaction
- Click at specific screen coordinates using `cliclick` (if available) or AppleScript click events
- Click named UI elements (buttons, menus, checkboxes) via Accessibility API
- Type text into the focused application using `keystroke` events
- Press keyboard shortcuts using `key code` events

### Screen capture
- Take a screenshot of a specific window using `screencapture -l <windowID>`
- Take a screenshot of a screen region using `screencapture -R x,y,w,h`
- Capture the full screen using `screencapture`

### Accessibility inspection
- Read UI element attributes (titles, values, roles) from application processes
- List buttons, text fields, and other controls in a window
- Check element state (enabled, focused, selected)

## Setup
Ensure that the app running this agent has Accessibility permissions enabled in System Settings > Privacy & Security > Accessibility. No additional binaries are required; `osascript` and `screencapture` are built into macOS.
