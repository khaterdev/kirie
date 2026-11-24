# Kirie

A multi-channel personal AI assistant powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Kirie runs as a daemon that connects to your messaging platforms and acts as a persistent, memory-aware AI companion with proactive intelligence and 50+ extensible skills.

Built by [@khaterdev](https://x.com/khaterdev)

---

## Why Kirie

Kirie is built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), an official SDK published and maintained by Anthropic. The SDK runs Claude Code under the hood — when no API key is provided, it authenticates using your existing Claude Code login session automatically. Kirie does not implement, manage, or store any OAuth tokens itself. It simply invokes the SDK, which handles authentication through Claude Code natively.

This means you can use your Claude Max subscription with Kirie through the same legitimate auth path that Claude Code uses. Unlike tools that spoof the Claude Code client identity to access your subscription (which violates Anthropic's Terms of Service and risks account bans), Kirie goes through Anthropic's own SDK. If you prefer, you can also provide an Anthropic API key for standard pay-per-token usage instead.

---

## Features

### Multi-Channel Messaging

Connect Kirie to the platforms you already use. Each channel runs simultaneously with unified conversation management.

| Channel | SDK | Groups | Threads | Reactions | Voice | Media |
|---------|-----|--------|---------|-----------|-------|-------|
| **Telegram** | Grammy | Yes | Yes | Send + Receive | Yes | Photos, video, audio, stickers |
| **Discord** | discord.js | Yes | Yes | Send + Receive | Yes | File attachments |
| **Slack** | Bolt | Yes | Yes | Send + Receive | - | Files + unfurls |
| **WhatsApp** | Baileys | Yes | - | Receive | Yes | Image, video, audio, documents |
| **Signal** | signal-cli REST | - | - | - | Yes | Base64 attachments |

### Persistent Memory

Three-layer memory architecture that persists across conversations and channels:

- **MEMORY.md** - Quick-reference facts loaded into every prompt (owner name, preferences, key people)
- **Memory Database** - Searchable knowledge base with hybrid FTS5 + vector semantic search
- **Chat History** - Permanent archive of all conversations, keyword and semantic searchable

Embeddings run locally by default using ONNX (Snowflake Arctic Embed-S) with no API key required, or optionally via OpenAI.

### Proactive Intelligence

A three-tier system that monitors your environment and acts without being asked:

- **Tier 1 - Signal Detection**: Real-time checks every 10 seconds for stuck tasks, channel failures, delivery issues
- **Tier 2 - LLM Triage**: Periodic Claude evaluation of signals against your checklist (HEARTBEAT.md), deciding: notify now, queue for digest, stay silent, or escalate
- **Tier 3 - Escalation**: Spawns background tasks for deeper investigation when needed

Includes notification cooldowns, deduplication, daily digest scheduling, and full audit trail via heartbeat logs.

### Background Tasks

True async task execution in separate processes:

- Full agent context cloning (system prompt, memory, MCP tools, personality)
- Database-persisted task queue with SQLite
- Message passing to running tasks (send prompts, interrupt work)
- Cost tracking per task (tokens + USD)
- Session resumption on daemon restart
- Configurable max turns per task (default 200)

### Security

Defense-in-depth security stack:

- **Authentication** - Per-channel identity resolution with 4-tier role hierarchy (owner > admin > user > readonly)
- **Authorization** - Role-based access control with action-specific permissions
- **Rate Limiting** - Token bucket algorithm with per-user and per-group buckets
- **Input Guard** - Prompt injection defense with 20+ pattern detectors, size validation, XML boundary wrapping
- **Credential Store** - AES-256-GCM encrypted credentials with macOS Keychain integration (cross-platform)
- **SSRF Guard** - Blocks private IPs, metadata endpoints, internal hostnames
- **Code Scanner** - Detects dangerous patterns in plugins/skills (command injection, eval, exfiltration)
- **Security Audit** - Comprehensive audit tool checking file permissions, credential integrity, transport security

### 50+ Skills

YAML-driven extensible skills loaded at runtime:

**Communication** - Telegram, Discord, Slack, WhatsApp, Signal actions, Email (IMAP + Himalaya), Twitter/X, Voice calls (Twilio)

**Notes & Tasks** - Apple Notes, Apple Reminders, Bear Notes, Obsidian, Notion, Things 3, Trello

**Development** - GitHub (issues, PRs, actions), Coding agent (background sub-agents), Code analyzer, Skill creator

**Media** - Spotify player, Sonos, Bluesound, GIF search (Giphy/Tenor), Image generation (DALL-E, Gemini, optional Atlas provider), ElevenLabs TTS

**Audio** - Whisper transcription (local + API), Sherpa ONNX TTS (offline)

Atlas image generation requires `ATLASCLOUD_API_KEY` and `provider: "atlas"` on the image tool. OpenAI remains the default provider.

**Smart Home** - Philips Hue (OpenHue), System health checks

**Productivity** - Google Workspace, Google Places, PDF editing, Video frame extraction, Blog/RSS watching, tmux management

**System** - 1Password CLI, Screen/camera capture, UI automation (macOS), MCP bridge, Session logs, Model usage tracking

### Additional Capabilities

- **Multi-Agent System** - Register multiple agent personalities with per-agent skill/tool bindings and agent-to-agent communication
- **Browser Automation** - Playwright integration with auto-setup for headless Chrome control
- **Canvas UI** - Live-reload HTML canvas served over HTTP with SSE and WebSocket bridge
- **Docker Sandbox** - Isolated code execution with resource limits, capability dropping, and read-only root
- **Gateway API** - HTTP control plane (Hono, loopback only) for status, config reload, channel control and usage analytics. Webhooks and voice use a separate public listener (`ingress`)
- **Slash Commands** - A command registry answers `/help`, `/status`, `/stop` and the feature commands before the agent runs. Owner-only commands are checked centrally, and `/help` hides them from anyone else
- **Plugins** - Small JavaScript plugins that observe messages, replies, tool calls and errors, and may rewrite incoming text. They cannot add tools or channels or block tool calls. Off by default; each plugin is approved by its file hash (see [docs/plugins.md](docs/plugins.md))
- **Voice Calls** - Turn-based phone calls over Twilio or Plivo webhooks, using the provider's own speech-to-text and text-to-speech. Off by default; tested only against mocked provider APIs so far (see [docs/voice-setup.md](docs/voice-setup.md))
- **Broadcast Groups** - Named multi-target message delivery across channels
- **Hot Reload** - Config file watching with debounced, diff-based reloading

### Hermes-parity features

Everything below ships **off** unless the Default column says otherwise. Each feature has an owner-only command in your DM; most toggle at runtime with `on`/`off`, which overrides the config value until you `reset` it.

| Feature | Default | Config key | Owner command |
|---|---|---|---|
| Slash commands and generated `/help` | on | `commands.*` | `/help`, `/pending`, `/approve`, `/deny`, `/answer` |
| Secret scrubbing (channels, logs, stores) | on | `security.scrubbing.*` (read once at start) | `/secrets status`, `/secrets scan` |
| Hardline blocklist for catastrophic commands | on | `approvals.hardline` | `/approvals hardline off` |
| Approval prompts before risky commands | off (`yolo`) | `approvals.mode`, `approvals.askScope` | `/approvals mode ask` |
| Account rotation on usage limits | off | `accounts.rotation.enabled` | `/accounts`, `/rotation on` |
| Model fallback | off | `agent.fallback.enabled`, `agent.fallback.models` | `/fallback` |
| Self-learning proposals | off | `learning.enabled`, `learning.memoryPolicy` | `/learn on`, `/proposals` |
| Skill curator | off | `curator.enabled` | `/curator` |
| User model (local profile of you) | off | `userModel.enabled` | `/profile on` |
| Goals (work until a judge says done) | off | `goals.enabled` | `/goal on` |
| Loops (re-run a prompt, quiet unless changed) | off | `loops.enabled` | `/loop on` |
| Heartbeat control | follows `proactive.enabled` | `proactive.*` | `/heartbeat` (alias `/hb`) |
| Webhook triggers | off | `webhooks.enabled`, `ingress.publicBaseUrl` | `/webhook on` |
| Undo file edits | off | `undo.enabled` | `/undo on` (see [docs/undo.md](docs/undo.md)) |
| Sandboxed shell commands | off | `sandbox.mode` | `/sandbox` (see [docs/sandbox.md](docs/sandbox.md)) |
| Plugins | off | `plugins.enabled` | `/plugins on`, `/plugins enable <name>` |
| Computer use (desktop control) | off | `computerUse.enabled` (config, restart) | `/computer on` (see [docs/computer-use-setup.md](docs/computer-use-setup.md)) |
| Voice calls (Twilio or Plivo) | off | `voice.enabled`, `voice.provider` (config, restart) | `/voice`, `/call`, which exist only once `voice.enabled: true` (see note) |
| Strict MCP config | off | `agent.strictMcpConfig` (config) | none |

Voice differs from the rest: `/voice` and `/call` are registered only when `voice.enabled: true` is in the config (restart), so before that `/voice` is not a command and goes to the agent as text. Once it is enabled and the active provider has its credentials, numbers and public URL, voice is active from boot with no `/voice on`; `/voice off` is the runtime switch. See [docs/voice-setup.md](docs/voice-setup.md).

When bound to loopback (the default), the control plane on port 18789 also refuses requests whose `Host` header is not a loopback name (a DNS-rebinding guard); add names to `gateway.extraAllowedHosts` if you need them. Every key, with its default, is in [`config.example.yaml`](config.example.yaml). Feature docs: [approvals](docs/approvals.md), [computer use](docs/computer-use-setup.md), [plugins](docs/plugins.md), [sandbox](docs/sandbox.md), [secret scrubbing](docs/secret-scrubbing.md), [undo](docs/undo.md), [voice](docs/voice-setup.md), [webhooks](docs/webhooks.md).

---

## Quick Start

### Prerequisites

- **Node.js** 22+ (24+ supported)
- **pnpm** 9+
- **Platforms**: macOS, Linux, Windows

### Authentication

Kirie supports two authentication methods:

**Option A: Claude Code session (recommended)**

The Claude Agent SDK authenticates through Claude Code by default. Kirie doesn't handle login or store tokens — it delegates entirely to the SDK, which uses your Claude Code session.

1. Install Claude Code: https://docs.anthropic.com/en/docs/claude-code/overview
2. Run `claude` and complete the login/OAuth flow
3. That's it — Kirie picks up the session automatically via the SDK, no API key needed

This uses your existing Claude Max subscription instead of paying per-token.

**Option B: Anthropic API key**

If you don't have Claude Code installed or prefer pay-per-token pricing:

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)
2. Set `ANTHROPIC_API_KEY` in your environment, or provide it during the setup wizard

### Install

```bash
git clone https://github.com/khaterdev/kirie.git
cd kirie
pnpm install
pnpm build
```

### Setup

Run the interactive setup wizard:

```bash
pnpm cli
```

The wizard walks through:

1. Authentication (API key or Claude Code session)
2. Channel selection and token configuration
3. Gateway settings
4. Agent model and personality
5. Memory and embedding provider
6. Proactive intelligence settings
7. Browser automation (optional Playwright + Chromium)

Configuration is saved to `~/.kirie/config.yaml`. Credentials are encrypted and stored in `~/.kirie/credentials/`.

### Run

```bash
pnpm daemon
```

### Docker

```bash
docker compose up -d
```

The compose file mounts `~/.kirie` for config persistence and exposes the gateway on port 18789.

---

## Configuration

Kirie uses a YAML config file at `~/.kirie/config.yaml`. See [`config.example.yaml`](config.example.yaml) for the full template.

```yaml
agent:
  model: "claude-opus-5-5[1m]"
  maxTurns: 100                    # 0 = unlimited
  backgroundTaskMaxTurns: 200      # Max turns for background task agents
  # customInstructions: "..."      # Appended to system prompt
  # workspace: "/path/to/projects" # Working directory for agent

security:
  owner:
    identities:
      telegram: []                 # Your Telegram user ID(s)
      discord: []                  # Your Discord user ID(s)
  dmPolicy: "owner-only"          # "owner-only", "allowlist", "open"
  groupPolicy: "mention-only"     # "mention-only", "all", "disabled"

channels:
  telegram:
    enabled: true
    token: "$credential:telegram.bot_token"
  discord:
    enabled: true
    token: "$credential:discord.bot_token"
  slack:
    enabled: true
    botToken: "$credential:slack.bot_token"
    appToken: "$credential:slack.app_token"

memory:
  enabled: true
  embeddings:
    provider: "local"              # "local" (ONNX, no API key), "openai", "noop"

gateway:
  port: 18789
  bind: "loopback"                # "loopback" or "all"
```

### Credential References

Sensitive values use `$credential:section.key` syntax. The setup wizard stores these encrypted via the credential store. For CI/CD, use environment variables: `KIRIE_CREDENTIAL_TELEGRAM_BOT_TOKEN`.

### Config Includes

Split config across files with `$include`:

```yaml
$include: "./channels.yaml"
```

### Environment Variables

Use `${VAR_NAME}` for environment variable interpolation in config values.

### Personality (SOUL.md)

Kirie's personality is defined in `~/.kirie/SOUL.md` - a markdown file loaded into every prompt. The setup wizard generates this based on your preferences (name, tagline, language, tone).

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Daemon Process                     │
│                                                       │
│  ┌───────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ Telegram   │  │ Discord  │  │ Slack / WA / Sig  │ │
│  └─────┬─────┘  └────┬─────┘  └────────┬──────────┘ │
│        └──────────────┼─────────────────┘             │
│                       ▼                               │
│              ┌────────────────┐                       │
│              │ Security Gate  │  Auth → AuthZ →       │
│              │                │  Rate Limit → Guard   │
│              └───────┬────────┘                       │
│                      ▼                                │
│              ┌────────────────┐  ┌────────────────┐  │
│              │  Agent Engine  │──│  MCP Tools (33+)│  │
│              │  (Claude SDK)  │  │  via stdio srv  │  │
│              └───────┬────────┘  └────────────────┘  │
│                      │                                │
│        ┌─────────────┼─────────────┐                  │
│        ▼             ▼             ▼                  │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐            │
│  │ Sessions │ │  Memory   │ │ Heartbeat│            │
│  │ (SQLite) │ │ (FTS5 +   │ │ Service  │            │
│  │          │ │  Vectors) │ │ (10s tick)│            │
│  └──────────┘ └───────────┘ └────┬─────┘            │
│                                   ▼                   │
│                          ┌────────────────┐           │
│                          │   Proactive    │           │
│                          │  Intelligence  │           │
│                          │  (3-tier)      │           │
│                          └────────────────┘           │
│                                                       │
│  ┌────────────────┐  ┌──────────────────────┐        │
│  │ Gateway API    │  │ Background Tasks     │        │
│  │ (Hono :18789)  │  │ (async processes)    │        │
│  └────────────────┘  └──────────────────────┘        │
└─────────────────────────────────────────────────────┘
```

### Monorepo Layout

```
packages/
  core/          Core engine, security, routing, config, MCP tools, gateway
  memory/        Vector store, embeddings (local ONNX / OpenAI), semantic search
  media/         Media file handling
  voice/         Voice call providers (Twilio, Plivo) and call store
  canvas/        Canvas UI file serving with live reload
  plugin-sdk/    Stable types for third-party plugin developers
  skills/        Skill loader, scanner, workspace manager

apps/
  daemon/        Main daemon process (lifecycle orchestration)
  cli/           Interactive CLI with TUI setup wizard (Ink/React)

channels/
  telegram/      Grammy SDK adapter
  discord/       discord.js adapter
  slack/         Bolt framework adapter
  whatsapp/      Baileys adapter
  signal/        signal-cli REST adapter

skills/          50+ YAML-driven skill definitions
```

---

## Development

```bash
pnpm install       # Install dependencies
pnpm build         # Build all packages
pnpm dev           # Watch mode (all packages)
pnpm test          # Run tests
pnpm test:watch    # Watch mode for tests
pnpm lint          # Type-check (tsc --noEmit)
```

### Run a single test

```bash
pnpm vitest run packages/core/src/config/schema.test.ts
```

### Run tests matching a name

```bash
pnpm vitest run -t "applies all defaults"
```

### Build a single package

```bash
pnpm --filter @kirie/core run build
```

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (24+ supported), ESM |
| Package Manager | pnpm 9+ with workspaces |
| Build | tsdown (esbuild-based) |
| TypeScript | ES2022, strict mode |
| Testing | Vitest, v8 coverage |
| LLM | Claude Agent SDK |
| MCP | @modelcontextprotocol/sdk |
| Database | better-sqlite3 (WAL mode) |
| HTTP | Hono framework |
| Config | YAML + Zod validation |
| Logging | Pino |

---

## Gateway API

The HTTP gateway runs on port 18789 (default, loopback only). Optional bearer token auth.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Channel health, uptime, session count |
| `/sessions` | GET | List active sessions |
| `/config/reload` | POST | Hot-reload config from disk |
| `/channels/:id/start` | POST | Start a channel adapter |
| `/channels/:id/stop` | POST | Stop a channel adapter |
| `/api/usage/summary` | GET | Token and cost analytics |
| `/api/usage/export` | GET | CSV export of usage data |
| `/api/proactive/status` | GET | Proactive engine status |
| `/api/proactive/trigger` | POST | Force triage cycle |
| `/shutdown` | POST | Graceful shutdown |
| `/restart` | POST | Graceful restart |

---

## Databases

All persistence uses SQLite with WAL mode:

| Database | Contents |
|----------|----------|
| `memory.db` | Memory store (FTS5), schedules |
| `vectors.db` | Vector embeddings |
| `chat-history.db` | Conversation archive (FTS5 + embeddings) |
| `background-tasks.db` | Task queue and commands |
| `sessions.db` | Session metadata |
| `heartbeat-logs.db` | Proactive system logs (FTS5 + embeddings) |
| `usage.db` | API cost tracking |

---

## Adding a Skill

Create a directory under `skills/` with a `SKILL.md` file:

```markdown
---
name: my-skill
emoji: "🔧"
description: Short description of what this skill does
version: 1.0.0
requires:
  bins: [curl]           # Required binaries (all must exist)
  # anyBins: [foo, bar]  # At least one must exist
  # env: [MY_API_KEY]    # Required environment variables
os: [darwin, linux]      # Supported platforms (omit for all)
---

Instructions for the AI on how to use this skill.

## Tools

Describe the tools and workflows available.
```

Skills are automatically discovered and loaded at daemon startup.

---

## Docker

### Production

```bash
docker compose up -d
```

### Sandbox Containers

Kirie supports Docker-based sandboxing for isolated code execution:

- **Dockerfile.sandbox** - Minimal Debian with common dev tools
- **Dockerfile.sandbox-browser** - Playwright Chromium + VNC for browser automation

Configure in `config.yaml` (or switch at runtime with `/sandbox docker`):

```yaml
sandbox:
  mode: "docker"       # "off" (default), "native" or "docker"
  scope: "shared"      # only "shared" is implemented
```

Build the image with `scripts/sandbox-setup.sh`. Details, limits and the native (Seatbelt) mode: [docs/sandbox.md](docs/sandbox.md).

---

## Disclaimer

There is no $KIRIE token. Any cryptocurrency or token claiming to be associated with this project is not affiliated with Kirie or its developers.

---

## License

[MIT](LICENSE)
