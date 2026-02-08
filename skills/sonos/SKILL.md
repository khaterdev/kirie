---
name: sonos
description: Control Sonos speakers on the local network
emoji: "\U0001F3B6"
version: "1.0.0"
requires:
  env:
    - SONOS_HOST
invocation:
  userInvocable: true
---

# Sonos

Control Sonos speakers: play, pause, volume, and grouping.

## Usage
- "Play music on the living room Sonos"
- "Set volume to 40% in the kitchen"
- "Pause all Sonos speakers"

## How it works
Communicates with Sonos speakers via the local network UPnP/SOAP API.

## Setup
Set `SONOS_HOST` to the IP address of your primary Sonos speaker.
