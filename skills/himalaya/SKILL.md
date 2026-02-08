---
name: himalaya
description: Read and send email using the himalaya CLI client
emoji: "\U0001F4E8"
version: "1.0.0"
requires:
  bins:
    - himalaya
invocation:
  userInvocable: true
---

# Himalaya Email Client

Read, send, and manage email using the himalaya command-line email client. Unlike the `email-imap` skill which connects to IMAP directly, this skill delegates all mail operations to the `himalaya` CLI binary, which handles its own IMAP/SMTP configuration.

## Usage
- "Check my inbox for new emails"
- "Read the latest email from Sarah"
- "Send an email to bob@example.com about the meeting"
- "Search my mailbox for invoices from last month"
- "List all mail folders"
- "Reply to the last email"
- "Forward the email about the budget to alice@example.com"

## How it works
Runs the `himalaya` CLI to interact with configured email accounts. Himalaya manages its own account configuration (IMAP/SMTP credentials, folders, etc.) via its config file. The agent invokes subcommands like `himalaya list`, `himalaya read`, `himalaya send`, `himalaya search`, `himalaya reply`, `himalaya forward`, and `himalaya folder list` to perform mail operations.

### Key commands
- `himalaya list` -- list messages in the inbox (or a specified folder)
- `himalaya read <id>` -- read a specific message by ID
- `himalaya send` -- compose and send a new message (reads from stdin or a file)
- `himalaya reply <id>` -- reply to a message
- `himalaya forward <id>` -- forward a message
- `himalaya search <query>` -- search messages across the mailbox
- `himalaya folder list` -- list available mail folders
- `himalaya attachments <id>` -- download attachments from a message

## Setup
1. Install himalaya: `brew install himalaya` (macOS) or download from https://github.com/pimalaya/himalaya
2. Configure your email account by running `himalaya configure` or editing `~/.config/himalaya/config.toml` manually with your IMAP/SMTP credentials.
3. Optionally set `HIMALAYA_CONFIG` to point to a custom config file location.
