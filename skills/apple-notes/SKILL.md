---
name: apple-notes
description: Create and search Apple Notes via AppleScript
emoji: "\U0001F4DD"
version: "1.0.0"
os:
  - darwin
requires:
  bins:
    - osascript
invocation:
  userInvocable: true
---

# Apple Notes

Create, search, and read notes in the macOS Notes app.

## Usage
- "Create a note with my meeting summary"
- "Search my notes for recipes"
- "Read my latest note"

## How it works
Uses `osascript` to interact with the Notes app via AppleScript. Supports creating notes in specific folders, searching note content, and reading existing notes.
