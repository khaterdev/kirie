---
name: slack
description: Send messages and interact with Slack workspaces
emoji: "\U0001F4E2"
version: "1.0.0"
requires:
  env:
    - SLACK_BOT_TOKEN
invocation:
  userInvocable: true
---

# Slack

Send messages, search conversations, and manage Slack channels.

## Usage
- "Send a message to #engineering"
- "Search Slack for messages about the release"
- "List my Slack channels"

## How it works
Uses the Slack Web API to send messages, search message history, and list channels.

## Setup
Set `SLACK_BOT_TOKEN` with your Slack app's bot token.
