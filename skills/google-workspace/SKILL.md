---
name: google-workspace
description: Interact with Google Drive, Docs, Sheets, and Calendar
emoji: "\U0001F4C1"
version: "1.0.0"
requires:
  env:
    - GOOGLE_CLIENT_ID
    - GOOGLE_CLIENT_SECRET
invocation:
  userInvocable: true
---

# Google Workspace

Access Google Drive, Docs, Sheets, and Calendar.

## Usage
- "List my recent Google Drive files"
- "Create a new spreadsheet for expense tracking"
- "What's on my calendar today?"

## How it works
Uses Google Workspace APIs with OAuth2 authentication to manage files and calendar events.

## Setup
Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the Google Cloud Console.
