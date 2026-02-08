---
name: openai-image-gen
description: Generate images using OpenAI's DALL-E API
emoji: "\U0001F3A8"
version: "1.0.0"
requires:
  env:
    - OPENAI_API_KEY
invocation:
  userInvocable: true
---

# OpenAI Image Generation

Generate images from text descriptions using DALL-E.

## Usage
- "Generate an image of a sunset over mountains"
- "Create a logo for my coffee shop"

## How it works
1. Takes the user's description and crafts a DALL-E prompt
2. Calls the OpenAI images API with the prompt
3. Downloads and delivers the generated image

## Setup
Set `OPENAI_API_KEY` in your environment.
