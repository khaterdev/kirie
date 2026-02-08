---
name: email-imap
description: Read and search email via IMAP
emoji: "\U0001F4E7"
version: "1.0.0"
requires:
  env:
    - IMAP_HOST
    - IMAP_USER
    - IMAP_PASS
invocation:
  userInvocable: true
---

# Email IMAP

Read, search, and summarize emails from any IMAP mailbox.

## Usage
- "Check my latest emails"
- "Search for emails from John about the project"
- "Summarize unread messages"

## How it works
Connects to an IMAP server to fetch and search email messages. Supports full-text search and folder listing.

## Setup
Set `IMAP_HOST`, `IMAP_USER`, and `IMAP_PASS` environment variables.
