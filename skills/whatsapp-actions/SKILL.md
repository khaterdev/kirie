---
name: whatsapp-actions
description: Send and read WhatsApp messages via the Business API
emoji: "\U0001F4F1"
version: "1.0.0"
requires:
  env:
    - WHATSAPP_TOKEN
    - WHATSAPP_PHONE_ID
invocation:
  userInvocable: true
---

# WhatsApp Actions

Send and read WhatsApp messages via the Business API.

## Usage
- "Send a WhatsApp message to +1234567890"
- "Check my latest WhatsApp messages"

## How it works
Uses the WhatsApp Business Cloud API to send and receive messages.

## Setup
Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_ID` from the Meta Developer Portal.
