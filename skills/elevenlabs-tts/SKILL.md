---
name: elevenlabs-tts
description: Convert text to speech using ElevenLabs API
emoji: "\U0001F50A"
version: "1.0.0"
requires:
  env:
    - ELEVENLABS_API_KEY
invocation:
  userInvocable: true
---

# ElevenLabs TTS

Convert text to natural-sounding speech using ElevenLabs.

## Usage
- "Read this paragraph aloud"
- "Generate speech for my presentation notes"
- "Convert this text to audio with the Rachel voice"

## How it works
Sends text to the ElevenLabs API, selects a voice, and returns an audio file.

## Setup
Set `ELEVENLABS_API_KEY` from https://elevenlabs.io.
