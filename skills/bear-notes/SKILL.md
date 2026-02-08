---
name: bear-notes
description: Create and search notes in Bear on macOS
emoji: "\U0001F43B"
version: "1.0.0"
os:
  - darwin
requires:
  bins:
    - osascript
invocation:
  userInvocable: true
---

# Bear Notes

Create, search, and read notes in Bear on macOS.

## Usage
- "Create a Bear note with my meeting minutes"
- "Search Bear for notes tagged #project"
- "Open my latest Bear note"

## How it works
Uses Bear's x-callback-url scheme and AppleScript to interact with the Bear app.
