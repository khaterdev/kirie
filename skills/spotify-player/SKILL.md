---
name: spotify-player
description: Control Spotify playback and search for music
emoji: "\U0001F3B5"
version: "1.0.0"
requires:
  env:
    - SPOTIFY_CLIENT_ID
    - SPOTIFY_CLIENT_SECRET
invocation:
  userInvocable: true
---

# Spotify Player

Control Spotify playback, search tracks, and manage playlists.

## Usage
- "Play some jazz music"
- "What's currently playing?"
- "Add this song to my favorites playlist"

## How it works
Uses the Spotify Web API to control playback and search the catalog. Requires Spotify API credentials.

## Setup
Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` from the Spotify Developer Dashboard.
