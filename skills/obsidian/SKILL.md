---
name: obsidian
description: Read, create, and search notes in an Obsidian vault
emoji: "\U0001F4D3"
version: "1.0.0"
requires:
  env:
    - OBSIDIAN_VAULT_PATH
invocation:
  userInvocable: true
---

# Obsidian

Interact with an Obsidian vault by reading, creating, and searching markdown notes.

## Usage
- "Search my Obsidian vault for notes about project planning"
- "Create a new note in my vault"
- "List recent notes in my daily folder"

## How it works
Reads and writes markdown files directly in the configured Obsidian vault directory. Supports wikilinks, tags, and frontmatter.

## Setup
Set `OBSIDIAN_VAULT_PATH` to the absolute path of your Obsidian vault.
