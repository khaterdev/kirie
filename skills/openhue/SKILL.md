---
name: openhue
description: Control Philips Hue smart lights
emoji: "\U0001F4A1"
version: "1.0.0"
requires:
  env:
    - HUE_BRIDGE_IP
    - HUE_API_KEY
invocation:
  userInvocable: true
---

# OpenHue

Control Philips Hue smart lights: toggle, change color, set brightness.

## Usage
- "Turn off the living room lights"
- "Set bedroom lights to warm white at 50%"
- "Make the office lights blue"

## How it works
Communicates with the Hue Bridge REST API to control lights, groups, and scenes.

## Setup
Set `HUE_BRIDGE_IP` and `HUE_API_KEY` for your Philips Hue Bridge.
