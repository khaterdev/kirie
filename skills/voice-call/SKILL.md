---
name: voice-call
description: Make voice calls using Twilio API
emoji: "\U0001F4DE"
version: "1.0.0"
requires:
  env:
    - TWILIO_ACCOUNT_SID
    - TWILIO_AUTH_TOKEN
    - TWILIO_PHONE_NUMBER
invocation:
  userInvocable: true
---

# Voice Call

Make and manage voice calls using the Twilio API.

## Usage
- "Call +1234567890 with a reminder message"
- "Check my recent call logs"

## How it works
Uses the Twilio API to initiate voice calls with text-to-speech messages.

## Setup
Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` from the Twilio Console.
