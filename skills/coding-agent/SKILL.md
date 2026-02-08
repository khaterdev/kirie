---
name: coding-agent
description: Spawn a sub-agent to handle complex coding tasks in the background
emoji: "\U0001F4BB"
version: "1.0.0"
requires:
  bins:
    - git
invocation:
  userInvocable: true
---

# Coding Agent

Delegates complex coding tasks to a background sub-agent with full tool access.

## Usage
- "Write a REST API for user management"
- "Refactor the auth module to use JWT"
- "Fix the failing tests in the payment service"

## How it works
1. Analyzes the coding request and determines scope
2. Spawns a background task with appropriate instructions
3. The sub-agent reads relevant files, makes changes, and runs tests
4. Reports results when complete
