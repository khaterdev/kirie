---
name: tmux
description: Manage tmux sessions, windows, and panes
emoji: "\U0001F5A5"
version: "1.0.0"
os:
  - darwin
  - linux
requires:
  bins:
    - tmux
invocation:
  userInvocable: true
---

# Tmux

Manage tmux sessions, windows, and panes for terminal multiplexing.

## Usage
- "List my tmux sessions"
- "Create a new tmux session called dev"
- "Send a command to the build pane"

## How it works
Uses the `tmux` CLI to create, list, attach, and manage terminal sessions and panes.

## Setup
Install tmux via `brew install tmux` or your package manager.
