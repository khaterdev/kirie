---
name: google-places
description: Search for places, restaurants, and businesses using Google Places API
emoji: "\U0001F4CD"
version: "1.0.0"
requires:
  env:
    - GOOGLE_PLACES_API_KEY
invocation:
  userInvocable: true
---

# Google Places

Search for restaurants, businesses, and points of interest.

## Usage
- "Find Italian restaurants near me"
- "What's the best-rated coffee shop in downtown?"
- "Show me pharmacies open now"

## How it works
Uses the Google Places API to search for nearby places, get details, and read reviews.

## Setup
Set `GOOGLE_PLACES_API_KEY` from the Google Cloud Console.
