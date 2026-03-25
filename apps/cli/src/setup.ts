import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as p from "@clack/prompts";
import { stringify as stringifyYaml } from "yaml";
import { CredentialStore, KIRIE_DIR } from "@kirie/core";

function isCancelled(value: unknown): value is symbol {
  return p.isCancel(value);
}

export async function runSetup(): Promise<void> {
  p.intro("Kirie Setup");

  // ── Step 1: Anthropic API Key ──────────────────────────────────────────

  const apiKey = await p.text({
    message: "Anthropic API key",
    placeholder: "sk-ant-...",
    validate: (v) => {
      if (!v) return "API key is required";
      if (!v.startsWith("sk-ant-")) return "Must start with sk-ant-";
      return undefined;
    },
  });
  if (isCancelled(apiKey)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // ── Step 2: Channel Selection ──────────────────────────────────────────

  const channels = await p.multiselect({
    message: "Which channels do you want to enable?",
    options: [
      { value: "telegram", label: "Telegram" },
      { value: "discord", label: "Discord" },
      { value: "slack", label: "Slack" },
      { value: "whatsapp", label: "WhatsApp" },
      { value: "signal", label: "Signal" },
    ],
    required: false,
  });
  if (isCancelled(channels)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // ── Step 3: Per-Channel Configuration ──────────────────────────────────

  const credentialStore = new CredentialStore();

  const channelsConfig: Record<string, Record<string, unknown>> = {};
  const ownerIdentities: Record<string, (string | number)[]> = {};

  for (const channel of channels) {
    switch (channel) {
      case "telegram": {
        const token = await p.text({
          message: "Telegram bot token",
          placeholder: "123456:ABC-DEF...",
          validate: (v) => (v ? undefined : "Bot token is required"),
        });
        if (isCancelled(token)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        await credentialStore.set("telegram.bot_token", token);

        const ownerId = await p.text({
          message: "Your Telegram user ID (numeric)",
          placeholder: "123456789",
          validate: (v) => {
            if (!v) return undefined;
            if (!/^\d+$/.test(v)) return "Must be a numeric ID";
            return undefined;
          },
        });
        if (isCancelled(ownerId)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        // Channel security
        const tgAllowedIds = await p.text({
          message: "Allowed Telegram user IDs (comma-separated, leave empty for global policy)",
          placeholder: "123456789,987654321",
        });
        if (isCancelled(tgAllowedIds)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const tgAllowGroups = await p.confirm({
          message: "Allow Telegram groups?",
          initialValue: false,
        });
        if (isCancelled(tgAllowGroups)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const tgAllowAddToGroups = await p.confirm({
          message: "Allow adding bot to new Telegram groups?",
          initialValue: false,
        });
        if (isCancelled(tgAllowAddToGroups)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const tgAllowedUserIds = tgAllowedIds
          ? tgAllowedIds.split(",").map((id) => id.trim()).filter(Boolean).map(Number)
          : [];
        // If owner ID was provided and not already in the list, add it
        if (ownerId && !tgAllowedUserIds.includes(Number(ownerId))) {
          tgAllowedUserIds.unshift(Number(ownerId));
        }

        channelsConfig.telegram = {
          enabled: true,
          token: "$credential:telegram.bot_token",
          ...(tgAllowedUserIds.length > 0 ? { allowedUserIds: tgAllowedUserIds } : {}),
          allowGroups: tgAllowGroups,
          allowAddToGroups: tgAllowAddToGroups,
        };
        if (ownerId) {
          ownerIdentities.telegram = [Number(ownerId)];
        }
        break;
      }

      case "discord": {
        const token = await p.text({
          message: "Discord bot token",
          validate: (v) => (v ? undefined : "Bot token is required"),
        });
        if (isCancelled(token)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        await credentialStore.set("discord.bot_token", token);

        const ownerId = await p.text({
          message: "Your Discord user ID",
          placeholder: "123456789012345678",
          validate: (v) => {
            if (!v) return undefined;
            if (!/^\d+$/.test(v)) return "Must be a numeric Discord user ID";
            return undefined;
          },
        });
        if (isCancelled(ownerId)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        // Channel security
        const dcAllowedIds = await p.text({
          message: "Allowed Discord user IDs (comma-separated, leave empty for global policy)",
          placeholder: "123456789012345678,987654321012345678",
        });
        if (isCancelled(dcAllowedIds)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const dcAllowGroups = await p.confirm({
          message: "Allow Discord server channels (groups)?",
          initialValue: true,
        });
        if (isCancelled(dcAllowGroups)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const dcAllowedUserIds = dcAllowedIds
          ? dcAllowedIds.split(",").map((id) => id.trim()).filter(Boolean)
          : [];
        if (ownerId && !dcAllowedUserIds.includes(ownerId)) {
          dcAllowedUserIds.unshift(ownerId);
        }

        channelsConfig.discord = {
          enabled: true,
          token: "$credential:discord.bot_token",
          ...(dcAllowedUserIds.length > 0 ? { allowedUserIds: dcAllowedUserIds } : {}),
          allowGroups: dcAllowGroups,
        };
        if (ownerId) {
          ownerIdentities.discord = [ownerId];
        }
        break;
      }

      case "slack": {
        const botToken = await p.text({
          message: "Slack bot token (xoxb-...)",
          placeholder: "xoxb-...",
          validate: (v) => (v ? undefined : "Bot token is required"),
        });
        if (isCancelled(botToken)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        await credentialStore.set("slack.bot_token", botToken);

        const appToken = await p.text({
          message: "Slack app token (xapp-...)",
          placeholder: "xapp-...",
          validate: (v) => (v ? undefined : "App token is required"),
        });
        if (isCancelled(appToken)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }
        await credentialStore.set("slack.app_token", appToken);

        const slackAllowedIds = await p.text({
          message: "Allowed Slack user IDs (comma-separated, leave empty for global policy)",
          placeholder: "U01ABC,U02DEF",
        });
        if (isCancelled(slackAllowedIds)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const slackAllowedUserIds = slackAllowedIds
          ? slackAllowedIds.split(",").map((id) => id.trim()).filter(Boolean)
          : [];

        channelsConfig.slack = {
          enabled: true,
          botToken: "$credential:slack.bot_token",
          appToken: "$credential:slack.app_token",
          ...(slackAllowedUserIds.length > 0 ? { allowedUserIds: slackAllowedUserIds } : {}),
        };
        break;
      }

      case "whatsapp": {
        channelsConfig.whatsapp = { enabled: true };
        p.note("WhatsApp uses session-based auth. No token needed.");
        break;
      }

      case "signal": {
        const apiUrl = await p.text({
          message: "Signal API URL",
          initialValue: "http://localhost:8080",
        });
        if (isCancelled(apiUrl)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        const phoneNumber = await p.text({
          message: "Signal phone number (e.g. +1234567890)",
          placeholder: "+1234567890",
        });
        if (isCancelled(phoneNumber)) {
          p.cancel("Setup cancelled.");
          process.exit(0);
        }

        channelsConfig.signal = {
          enabled: true,
          apiUrl: apiUrl || "http://localhost:8080",
          ...(phoneNumber ? { phoneNumber } : {}),
        };
        if (phoneNumber) {
          ownerIdentities.signal = [phoneNumber];
        }
        break;
      }
    }
  }

  // ── Step 4: Gateway Configuration ──────────────────────────────────────

  const gatewayPort = await p.text({
    message: "Gateway port",
    initialValue: "18789",
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return "Invalid port (1-65535)";
      return undefined;
    },
  });
  if (isCancelled(gatewayPort)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const gatewayBind = await p.select({
    message: "Gateway bind address",
    options: [
      { value: "loopback", label: "Loopback (localhost only)", hint: "Recommended" },
      { value: "all", label: "All interfaces", hint: "For remote access" },
    ],
  });
  if (isCancelled(gatewayBind)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let bearerTokenValue: string | undefined;
  if (gatewayBind === "all") {
    const bearerToken = await p.text({
      message: "Gateway bearer token (leave empty to auto-generate)",
    });
    if (isCancelled(bearerToken)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    bearerTokenValue = bearerToken || randomBytes(32).toString("hex");
    await credentialStore.set("gateway.bearer_token", bearerTokenValue);
  }

  // ── Step 5: Agent Configuration ────────────────────────────────────────

  const model = await p.select({
    message: "Default model",
    options: [
      { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "Most capable (Recommended)" },
      { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", hint: "Fast and capable" },
      { value: "claude-haiku-3-5-20241022", label: "Claude Haiku 3.5", hint: "Fastest, most affordable" },
    ],
  });
  if (isCancelled(model)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const maxTurnsInput = await p.text({
    message: "Max agent turns per request (0 = unlimited)",
    initialValue: "100",
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return "Must be 0 (unlimited) or a positive integer";
      return undefined;
    },
  });
  if (isCancelled(maxTurnsInput)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  const maxTurns = Number(maxTurnsInput);

  const customInstructions = await p.text({
    message: "Custom instructions (added to default prompt, leave empty to skip)",
    placeholder: "e.g. Always respond in Spanish. My name is Alex.",
  });
  if (isCancelled(customInstructions)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const workspace = await p.text({
    message: "Workspace directory (agent's default working directory)",
    placeholder: "/path/to/your/projects",
    validate: (v) => {
      if (!v) return "Directory path is required";
      if (!v.startsWith("/")) return "Must be an absolute path";
      return undefined;
    },
  });
  if (isCancelled(workspace)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (!existsSync(workspace)) {
    mkdirSync(workspace, { recursive: true });
    p.log.info(`Created workspace directory: ${workspace}`);
  }

  // ── Step 6: Agent Soul ───────────────────────────────────────────────

  const agentName = await p.text({
    message: "Agent name",
    initialValue: "Kirie",
  });
  if (isCancelled(agentName)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const agentTagline = await p.text({
    message: "Agent tagline (short description, leave empty to skip)",
    placeholder: "Your personal AI companion",
  });
  if (isCancelled(agentTagline)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const agentLanguage = await p.text({
    message: "Default language",
    initialValue: "English",
  });
  if (isCancelled(agentLanguage)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const agentTone = await p.select({
    message: "Personality tone",
    options: [
      { value: "casual", label: "Casual but competent", hint: "Recommended" },
      { value: "professional", label: "Professional", hint: "Formal and polished" },
      { value: "playful", label: "Playful", hint: "Fun and lighthearted" },
      { value: "minimal", label: "Minimal", hint: "Brief and to the point" },
    ],
  });
  if (isCancelled(agentTone)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const toneDescriptions: Record<string, string> = {
    casual: "Casual but competent",
    professional: "Professional and polished",
    playful: "Playful and lighthearted",
    minimal: "Minimal — brief and to the point",
  };

  // ── Step 7: Embedding Configuration ─────────────────────────────────
  let embeddingProvider = await p.select({
    message: "Embedding provider for semantic search",
    options: [
      { value: "local", label: "Local (recommended)", hint: "Offline, downloads ~33MB model" },
      { value: "openai", label: "OpenAI API", hint: "Requires API key" },
      { value: "noop", label: "Disabled", hint: "No semantic search" },
    ],
  });
  if (p.isCancel(embeddingProvider)) { p.cancel("Setup cancelled."); process.exit(0); }

  let embeddingApiKey: string | undefined;
  if (embeddingProvider === "openai") {
    const key = await p.text({
      message: "OpenAI API key for embeddings",
      placeholder: "sk-...",
      validate: (v) => v ? undefined : "Required",
    });
    if (p.isCancel(key)) { p.cancel("Setup cancelled."); process.exit(0); }
    embeddingApiKey = key as string;
  }

  if (embeddingProvider === "local") {
    const dl = await p.confirm({
      message: "Download embedding model now (~33MB)?",
      initialValue: true,
    });
    if (!p.isCancel(dl) && dl) {
      const s = p.spinner();
      s.start("Downloading snowflake-arctic-embed-s...");
      try {
        const { ensureModelDownloaded } = await import("@kirie/memory");
        await ensureModelDownloaded();
        s.stop("Embedding model downloaded");
      } catch (err) {
        s.stop("Failed to download embedding model");
        p.log.warn(`Embedding model download failed: ${(err as Error).message}`);
        p.log.info("You can retry later with: kirie embeddings download");

        const fallback = await p.select({
          message: "How would you like to handle embeddings?",
          options: [
            { value: "openai", label: "Use OpenAI API instead", hint: "Requires API key" },
            { value: "noop", label: "Disable for now", hint: "No semantic search" },
            { value: "local", label: "Keep local (will retry on first use)" },
          ],
        });
        if (!p.isCancel(fallback) && fallback !== "local") {
          embeddingProvider = fallback as string;
          if (fallback === "openai") {
            const key = await p.text({ message: "OpenAI API key for embeddings", placeholder: "sk-..." });
            if (!p.isCancel(key)) embeddingApiKey = key as string;
          }
        }
      }
    }
  }

  // ── Step 8: Proactive Intelligence ──────────────────────────────────────

  const enableProactive = await p.confirm({
    message: "Enable proactive intelligence? (Kirie monitors health, sends alerts, daily digests)",
    initialValue: true,
  });
  if (isCancelled(enableProactive)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let proactiveConfig: Record<string, unknown> | undefined;
  if (enableProactive) {
    const triageInterval = await p.text({
      message: "Triage interval in minutes (how often Kirie checks on things)",
      initialValue: "15",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return "Must be a positive integer";
        return undefined;
      },
    });
    if (isCancelled(triageInterval)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const proactiveTimezone = await p.text({
      message: "Your timezone (IANA format)",
      initialValue: "Africa/Cairo",
      validate: (v) => (v ? undefined : "Timezone is required"),
    });
    if (isCancelled(proactiveTimezone)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const digestTime = await p.text({
      message: "Daily digest time (HH:MM, 24h format)",
      initialValue: "09:00",
      validate: (v) => {
        if (!v || !/^\d{2}:\d{2}$/.test(v)) return "Must be HH:MM format";
        return undefined;
      },
    });
    if (isCancelled(digestTime)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const memoryThreshold = await p.text({
      message: "Memory threshold in MB (alert when RSS exceeds this)",
      initialValue: "1024",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 128) return "Must be at least 128";
        return undefined;
      },
    });
    if (isCancelled(memoryThreshold)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    proactiveConfig = {
      enabled: true,
      tier2IntervalMinutes: Number(triageInterval),
      tier2Model: "claude-haiku-4-5-20241022",
      tier3Model: "claude-opus-4-6",
      memoryThresholdMB: Number(memoryThreshold),
      activeHours: {
        start: "00:00",
        end: "23:59",
        timezone: proactiveTimezone,
      },
      dailyDigestTime: digestTime,
    };
  }

  // ── Step 8b: Browser Capability ─────────────────────────────────────────

  const enableBrowser = await p.confirm({
    message: "Enable browser capability? (Kirie can browse web pages, take screenshots, interact with sites)",
    initialValue: false,
  });
  if (isCancelled(enableBrowser)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (enableBrowser) {
    const installNow = await p.confirm({
      message: "Install Playwright and download Chromium now (~150MB)?",
      initialValue: true,
    });
    if (!p.isCancel(installNow) && installNow) {
      const s = p.spinner();
      s.start("Installing playwright-core and downloading Chromium...");
      const { ensurePlaywrightInstalled } = await import("@kirie/core");
      await ensurePlaywrightInstalled();
      s.stop("Playwright and Chromium installed");
    }
  }

  // ── Step 9: Write Config ───────────────────────────────────────────────

  const kirieDir = KIRIE_DIR;
  if (!existsSync(kirieDir)) {
    mkdirSync(kirieDir, { recursive: true });
  }

  const config: Record<string, unknown> = {
    agent: {
      maxTurns,
      model,
      ...(customInstructions ? { customInstructions } : {}),
      ...(workspace ? { workspace } : {}),
    },
    security: {
      owner: {
        identities: {
          telegram: ownerIdentities.telegram ?? [],
          discord: ownerIdentities.discord ?? [],
          whatsapp: ownerIdentities.whatsapp ?? [],
          signal: ownerIdentities.signal ?? [],
          slack: ownerIdentities.slack ?? [],
        },
      },
      dmPolicy: "owner-only",
      groupPolicy: "mention-only",
      rateLimit: {
        perUser: { maxRequests: 30, windowMs: 60000 },
        perGroup: { maxRequests: 60, windowMs: 60000 },
      },
    },
    channels: {
      telegram: channelsConfig.telegram ?? { enabled: false },
      discord: channelsConfig.discord ?? { enabled: false },
      slack: channelsConfig.slack ?? { enabled: false },
      whatsapp: channelsConfig.whatsapp ?? { enabled: false },
      signal: channelsConfig.signal ?? { enabled: false },
    },
    memory: {
      enabled: true,
      backend: "sqlite",
      embeddings: {
        provider: embeddingProvider,
        ...(embeddingApiKey ? { apiKey: embeddingApiKey } : {}),
      },
    },
    gateway: {
      port: Number(gatewayPort),
      bind: gatewayBind,
      ...(bearerTokenValue ? { bearerToken: "$credential:gateway.bearer_token" } : {}),
    },
    ...(enableBrowser ? { browser: { enabled: true } } : {}),
    ...(proactiveConfig ? { proactive: proactiveConfig } : {}),
  };

  const configPath = join(kirieDir, "config.yaml");
  writeFileSync(configPath, stringifyYaml(config), "utf-8");

  // ── Step 10: Write SOUL.md ────────────────────────────────────────────

  const soulPath = join(kirieDir, "SOUL.md");
  writeFileSync(
    soulPath,
    `# Soul

## Name
${agentName}

## Tagline
${agentTagline || "(A short one-liner about who you are)"}

## Identity
- You are ${agentName}, a personal AI assistant.
- You communicate through messaging platforms (Telegram, Discord, Slack, WhatsApp, Signal).
- You are loyal to your owner and act in their best interest.

## Mission
- Help your owner with tasks, questions, and daily life.
- Be proactive — anticipate needs, remember context, and follow through.
- Learn and adapt to your owner's preferences over time.

## Personality
- Friendly, direct, and concise.
- Avoids filler and unnecessary formality.
- Matches the owner's communication style over time.

## Boundaries
- Never share the owner's private information with others.
- Be honest — say "I don't know" rather than guessing.
- Ask for clarification when instructions are ambiguous.

## Communication Style
- Default language: ${agentLanguage}
- Tone: ${toneDescriptions[agentTone as string] ?? "Casual but competent"}
- Use short messages in chat. Save long responses for when detail is needed.
`,
    "utf-8",
  );

  // ── Step 11: Write .env ─────────────────────────────────────────────────

  const envPath = join(kirieDir, ".env");
  writeFileSync(envPath, `ANTHROPIC_API_KEY=${apiKey}\n`, "utf-8");

  p.note(
    `Config written to ${configPath}\nAPI key saved to ${envPath}\n\nSource the .env file in your shell:\n  export $(cat ${envPath} | xargs)`,
    "Files created",
  );

  p.outro("Setup complete! Run 'kirie daemon' to start, or 'kirie chat' to chat.");
}
