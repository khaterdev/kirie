---
name: telegram-actions
description: Send messages and manage Telegram chats via Bot API
emoji: "\U0001F4E8"
version: "1.0.0"
requires:
  env:
    - TELEGRAM_BOT_TOKEN
invocation:
  userInvocable: true
---

# Telegram Actions

Send messages, photos, and files to Telegram chats.

## Usage
- "Send a message to my Telegram group"
- "Forward this file to chat ID 12345"
- "Get updates from my bot"

## How it works
Uses the Telegram Bot API to send and receive messages. Supports text, photos, documents, and inline keyboards.

## Setup
Set `TELEGRAM_BOT_TOKEN` from @BotFather on Telegram.
