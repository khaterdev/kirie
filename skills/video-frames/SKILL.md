---
name: video-frames
description: Extract frames and thumbnails from video files
emoji: "\U0001F3AC"
version: "1.0.0"
requires:
  bins:
    - ffmpeg
invocation:
  userInvocable: true
---

# Video Frames

Extract frames, thumbnails, and clips from video files.

## Usage
- "Extract a frame at 1:30 from this video"
- "Generate a thumbnail grid for this video"
- "Get frames every 10 seconds"

## How it works
Uses `ffmpeg` to extract frames at specified timestamps or intervals.

## Setup
Install ffmpeg via `brew install ffmpeg` or your package manager.
