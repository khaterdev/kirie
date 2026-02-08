---
name: discord
description: Send messages and manage Discord channels via bot API
emoji: "\U0001F4AC"
version: "1.0.0"
requires:
  env:
    - DISCORD_BOT_TOKEN
invocation:
  userInvocable: true
---

# Discord

Send messages, read channels, and manage a Discord server.

## Usage
- "Send a message to the #general channel"
- "List active channels in my server"
- "Check recent messages in #dev"

## How it works
Uses the Discord Bot API to interact with servers. Requires a bot token with appropriate permissions.

## Setup
Set `DISCORD_BOT_TOKEN` from the Discord Developer Portal.
