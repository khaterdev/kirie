---
name: notion
description: Read and manage Notion pages and databases
emoji: "\U0001F4D1"
version: "1.0.0"
requires:
  env:
    - NOTION_API_KEY
invocation:
  userInvocable: true
---

# Notion

Interact with Notion workspaces, pages, and databases.

## Usage
- "List my Notion databases"
- "Add a row to my task tracker"
- "Read the project roadmap page"

## How it works
Uses the Notion API to query databases, read pages, and create or update content.

## Setup
Set `NOTION_API_KEY` with your Notion integration token from https://www.notion.so/my-integrations.
