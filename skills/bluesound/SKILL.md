---
name: bluesound
description: Control Bluesound speakers on the local network
emoji: "\U0001F509"
version: "1.0.0"
requires:
  env:
    - BLUESOUND_HOST
invocation:
  userInvocable: true
---

# Bluesound

Control Bluesound/BluOS speakers: play, pause, volume, and presets.

## Usage
- "Play preset 1 on the Bluesound"
- "Set Bluesound volume to 30%"
- "What's currently playing on Bluesound?"

## How it works
Communicates with BluOS speakers via their local HTTP API.

## Setup
Set `BLUESOUND_HOST` to the IP address of your Bluesound player.
