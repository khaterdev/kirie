---
name: twitter-x
description: Post tweets and read timelines on X (Twitter)
emoji: "\U0001F426"
version: "1.0.0"
requires:
  env:
    - TWITTER_API_KEY
    - TWITTER_API_SECRET
invocation:
  userInvocable: true
---

# Twitter/X

Post tweets, read timelines, and search on X (formerly Twitter).

## Usage
- "Post a tweet about my new project"
- "Show my latest mentions"
- "Search X for trending AI topics"

## How it works
Uses the X API v2 to post content, read timelines, and search tweets.

## Setup
Set `TWITTER_API_KEY` and `TWITTER_API_SECRET` from the X Developer Portal.
