---
name: trello
description: Manage Trello boards, lists, and cards
emoji: "\U0001F4CB"
version: "1.0.0"
requires:
  env:
    - TRELLO_API_KEY
    - TRELLO_TOKEN
invocation:
  userInvocable: true
---

# Trello

Manage Trello boards, lists, and cards.

## Usage
- "Show my Trello boards"
- "Add a card to the To Do list"
- "Move the design card to Done"

## How it works
Uses the Trello REST API to manage boards, lists, and cards.

## Setup
Set `TRELLO_API_KEY` and `TRELLO_TOKEN` from https://trello.com/power-ups/admin.
