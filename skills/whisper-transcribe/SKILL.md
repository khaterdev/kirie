---
name: whisper-transcribe
description: Transcribe audio files locally using OpenAI Whisper
emoji: "\U0001F399"
version: "1.0.0"
requires:
  anyBins:
    - whisper
    - whisper-cpp
invocation:
  userInvocable: true
---

# Whisper Transcribe

Transcribe audio and video files to text using a local Whisper installation.

## Usage
- "Transcribe this audio file"
- "Convert my meeting recording to text"

## How it works
1. Accepts an audio or video file path
2. Runs Whisper locally to generate a transcript
3. Returns the full text with timestamps

## Setup
Install Whisper via `pip install openai-whisper` or build `whisper-cpp`.
