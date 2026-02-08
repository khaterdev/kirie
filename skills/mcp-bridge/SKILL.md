---
name: mcp-bridge
description: Connect to external MCP servers and use their tools
emoji: "\U0001F310"
version: "1.0.0"
invocation:
  userInvocable: true
---

# MCP Bridge

Connect to external Model Context Protocol servers and make their tools available.

## Usage
- "Connect to my local MCP server at localhost:3000"
- "List available tools from the MCP bridge"

## How it works
Establishes a connection to an external MCP server via stdio or SSE transport and exposes its tools within the current Kirie session.
