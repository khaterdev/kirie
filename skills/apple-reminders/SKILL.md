---
name: apple-reminders
description: Create and manage Apple Reminders via AppleScript
emoji: "\U0001F514"
version: "1.0.0"
os:
  - darwin
requires:
  bins:
    - osascript
invocation:
  userInvocable: true
---

# Apple Reminders

Create, list, and manage reminders in the macOS Reminders app.

## Usage
- "Remind me to call the dentist tomorrow at 3pm"
- "Show my reminders for today"
- "Mark the grocery shopping reminder as done"

## How it works
Uses `osascript` to interact with the Reminders app via AppleScript. Supports creating reminders with due dates, listing reminders by list, and marking them complete.
