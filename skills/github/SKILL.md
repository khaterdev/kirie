---
name: github
description: Interact with GitHub repositories, issues, PRs, and actions
emoji: "\U0001F4E6"
version: "1.0.0"
requires:
  bins:
    - gh
  env:
    - GITHUB_TOKEN
invocation:
  userInvocable: true
---

# GitHub

Manage GitHub repos, issues, pull requests, and CI workflows.

## Usage
- "Create an issue for the login bug"
- "List open PRs on my project"
- "Check CI status for the latest commit"

## How it works
Uses the `gh` CLI and GitHub API to interact with repositories. Requires the `gh` CLI to be installed and authenticated, plus a `GITHUB_TOKEN` environment variable.
