# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Kirie

Kirie is a multi-channel personal AI assistant powered by the Claude Agent SDK. It runs as a daemon process that connects to messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal) and provides an AI assistant with persistent memory, scheduled tasks, proactive intelligence, and 50+ extensible skills.

## Build & Development Commands

```bash
pnpm build              # Build all packages (tsdown)
pnpm dev                # Watch mode for all packages
pnpm test               # Run all tests (vitest)
pnpm test:watch         # Watch mode for tests
pnpm lint               # Type-check with tsc --noEmit
pnpm daemon             # Start the daemon
pnpm cli                # Run the CLI (setup wizard)
pnpm clean              # Clean all dist/ directories
```

**Run a single test file:**
```bash
pnpm vitest run packages/core/src/config/schema.test.ts
```

**Run tests matching a pattern:**
```bash
pnpm vitest run -t "applies all defaults"
```

**Build a single package:**
```bash
pnpm --filter @kirie/core run build
```

## Monorepo Structure

```
packages/core      # Engine, security, routing, config, MCP tools, gateway (Hono)
packages/memory    # Vector store, embeddings (local ONNX or OpenAI), semantic search
packages/media     # Media file handling and processing
packages/canvas    # Canvas file watching and serving
packages/voice     # Voice call support (Twilio)
packages/plugin-sdk# Plugin/skill SDK types
packages/skills    # Skill loader and utilities
apps/cli           # CLI with TUI setup wizard (Ink/React)
apps/daemon        # Main daemon process - lifecycle, startup orchestration
channels/          # Platform adapters: telegram (grammy), discord (discord.js),
                   # slack (@slack/bolt), whatsapp (baileys), signal
skills/            # 50+ YAML-driven skill definitions (each has SKILL.md)
```

Workspace packages: `packages/*`, `apps/*`, `channels/*` (defined in `pnpm-workspace.yaml`). Skills are not workspace packages — they are loaded at runtime by `@kirie/skills`.

## Architecture

### Message Flow

1. **Channel adapter** receives platform message → normalizes to `UnifiedMessage`
2. **MessagePipeline** routes through `SecurityGate` (auth → authz → rate limit → input guard)
3. **AgentEngine** builds prompt via `buildPrompt()`, calls Claude Agent SDK `query()` with MCP tools
4. **SessionStore** (SQLite) tracks multi-turn conversation state by session key (`channel:chatId:threadId`)
5. Response sent back through the channel adapter

### Key Subsystems

- **ConfigWatcher** — Loads YAML config with hot-reload (chokidar), Zod schema validation, `$credential:key` resolution
- **GatewayServer** — HTTP control plane on port 18789 (Hono), exposes status/config/channel APIs
- **MCP Tool Registry** (`packages/core/src/mcp/server.ts`) — Factory that creates tool handlers (memory, schedule, chat history, daily notes, background tasks, channel actions, messaging, broadcast, agents, nodes, proactive, heartbeat logs, browser)
- **MCP stdio server** (`packages/core/src/mcp/stdio-server.ts`) — Exposes tools via MCP stdio protocol for external Claude instances
- **ChannelRegistry** — Manages adapter lifecycle (connect/disconnect/health)
- **AgentRegistry** — Multi-agent support with per-agent skill/tool bindings
- **HeartbeatService** — 10-second tick driving the proactive intelligence layer

### Proactive Intelligence Layer

Three-tier system running on heartbeat ticks:

- **Tier 1 — Signal Detectors** (`signals.ts`): Synchronous checks each tick (stuck tasks, channel health, failed deliveries). Each detector returns `Signal[]` with a `deduplicationKey` for stable hashing.
- **Tier 2 — Triage LLM** (`triage.ts`): Periodic Claude evaluation via Agent SDK. Reads `HEARTBEAT.md` checklist + signals, decides: `notify-now`, `queue-digest`, `silent`, `escalate`.
- **Tier 3 — Background Tasks**: On-demand escalation for deeper investigation.
- **ProactiveEngine** (`proactive.ts`): Orchestrates tiers with signal dedup cache and notification cooldowns (1-hour default via `notificationCooldownMinutes` config).

### Config Schema

Defined with Zod in `packages/core/src/config/schema.ts`. Key sections: `agent`, `security` (owner identities, DM/group policies, rate limits), `channels` (per-channel tokens and settings), `memory`, `gateway`, `multiAgent`, `proactive`, `voice`, `canvas`.

Credentials use `$credential:section.key` refs resolved at runtime from the credential store.

## Key Patterns

**Channel adapters** implement the `ChannelAdapter` interface — convert platform-specific messages to/from `UnifiedMessage`, handle connection lifecycle.

**MCP tool handlers** follow the pattern in `packages/core/src/mcp/tools/`: export a `create*ToolHandlers()` factory returning `Record<string, McpToolDefinition>`. Tools are registered in `createMcpToolRegistry()`.

**Dynamic imports** are used for optional dependencies (e.g., playwright-core in browser-tool.ts) to allow graceful degradation.

**Skills** are YAML-defined in `/skills/<name>/SKILL.md` with metadata headers, loaded at runtime by the skills package.

## Tech Stack

- **Runtime**: Node.js 22+, ESM throughout
- **Package manager**: pnpm 9.15+ with workspaces
- **Build**: tsdown (esbuild-based)
- **TypeScript**: ES2022 target, strict mode, bundler module resolution
- **Testing**: Vitest with globals, v8 coverage, 10s timeout
- **LLM**: Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **MCP**: `@modelcontextprotocol/sdk`
- **Database**: better-sqlite3 (sessions, memory, schedules, heartbeat logs)
- **HTTP**: Hono framework
- **Config**: YAML with Zod validation
- **Logging**: Pino
