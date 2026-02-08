---
name: weather
description: Get weather forecasts and current conditions for any location
emoji: "\U0001F324"
version: "1.0.0"
requires:
  env:
    - OPENWEATHER_API_KEY
invocation:
  userInvocable: true
---

# Weather

Get current weather conditions and forecasts.

## Usage
- "What's the weather in Tokyo?"
- "Will it rain tomorrow in London?"
- "Show me the 5-day forecast for New York"

## How it works
1. Parses the location from the user's query
2. Uses the OpenWeatherMap API to fetch current conditions
3. Formats and presents the results

## Setup
Set `OPENWEATHER_API_KEY` with your OpenWeatherMap API key. Get one at: https://openweathermap.org/api
