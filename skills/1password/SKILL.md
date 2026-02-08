---
name: 1password
description: Retrieve secrets from 1Password vaults via the CLI
emoji: "\U0001F510"
version: "1.0.0"
requires:
  bins:
    - op
invocation:
  userInvocable: true
---

# 1Password

Retrieve secrets and credentials from 1Password vaults using the CLI.

## Usage
- "Get my database password from 1Password"
- "List items in my Development vault"
- "Look up the API key for Stripe"

## How it works
Uses the `op` CLI to securely access vault items. Requires the 1Password CLI to be installed and authenticated.

## Setup
Install the 1Password CLI (`op`) and sign in with `op signin`.
