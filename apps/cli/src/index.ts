#!/usr/bin/env node
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { AgentEngine, SessionStore, ChatHistoryStore } from "@kirie/core";
import type { AgentEngineConfig } from "@kirie/core";

const program = new Command();

program
  .name("kirie")
  .description("Kirie - Personal AI Assistant")
  .version("0.1.0");

program
  .command("chat")
  .description("Start interactive chat session")
  .option("-m, --model <model>", "Model to use", "claude-opus-4-8[1m]")
  .option("--max-turns <turns>", "Maximum conversation turns", "10")
  .option("--no-engine", "Run without AgentEngine (UI demo mode)")
  .option("-s, --session-key <key>", "Sync with an existing session key (e.g., telegram:dm:12345)")
  .option("--list-sessions", "List existing sessions and exit")
  .action(async (opts: { model: string; maxTurns: string; engine: boolean; sessionKey?: string; listSessions?: boolean }) => {
    const sessionStore = new SessionStore();

    // --list-sessions: print all sessions and exit
    if (opts.listSessions) {
      const sessions = sessionStore.listAll();
      if (sessions.length === 0) {
        console.log("No sessions found.");
      } else {
        console.log(`Found ${sessions.length} session(s):\n`);
        for (const key of sessions) {
          console.log(`  ${key}`);
        }
        console.log("\nUse: kirie chat --session-key <key> to join a session.");
      }
      sessionStore.close();
      return;
    }

    // Interactive session picker when no --session-key is given
    let sessionKey = opts.sessionKey;
    if (!sessionKey) {
      const sessions = sessionStore.listAll();
      if (sessions.length > 0) {
        const { select, isCancel } = await import("@clack/prompts");
        const options = [
          { value: "__new__", label: "New session", hint: "Start a fresh conversation" },
          ...sessions.map((key) => {
            const [channel, chatType, ...rest] = key.split(":");
            const chatId = rest.join(":");
            return {
              value: key,
              label: key,
              hint: `${channel} ${chatType} — ${chatId}`,
            };
          }),
        ];

        const picked = await select({
          message: "Pick a session to continue, or start a new one",
          options,
        });

        if (isCancel(picked)) {
          sessionStore.close();
          return;
        }

        if (picked !== "__new__") {
          sessionKey = picked as string;
        }
      }
    }

    let engine: AgentEngine | undefined;
    const chatHistoryStore = new ChatHistoryStore();

    if (opts.engine) {
      const config: AgentEngineConfig = {
        prompt: {
          customInstructions: undefined,
          maxTurns: parseInt(opts.maxTurns, 10),
          model: opts.model,
        },
      };
      engine = new AgentEngine(config);
    }

    const { waitUntilExit } = render(
      React.createElement(App, {
        engine,
        sessionStore,
        sessionKey,
        chatHistoryStore,
      }),
      { exitOnCtrlC: false },
    );

    await waitUntilExit();

    // Clean up on exit
    sessionStore.close();
    chatHistoryStore.close();
  });

program
  .command("daemon")
  .description("Start the Kirie daemon")
  .action(async () => {
    const { startDaemon, stopDaemon } = await import("@kirie/daemon/lifecycle");

    const handleSignal = (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down...`);
      void stopDaemon().then(() => process.exit(0));
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));

    await startDaemon();
  });

program
  .command("setup")
  .description("Interactive setup wizard for Kirie")
  .option("-f, --force", "Force a full clean reinstall (backs up existing config first)")
  .action(async (opts: { force?: boolean }) => {
    const { runSetup } = await import("./setup.js");
    await runSetup({ force: opts.force });
  });

const embeddings = program
  .command("embeddings")
  .description("Manage embedding models");

embeddings
  .command("download")
  .description("Download the local embedding model (~33MB)")
  .action(async () => {
    const { ensureModelDownloaded, isModelDownloaded } = await import("@kirie/memory");
    if (await isModelDownloaded()) {
      console.log("Embedding model is already downloaded.");
      return;
    }
    console.log("Downloading snowflake-arctic-embed-s...");
    try {
      await ensureModelDownloaded();
      console.log("Embedding model downloaded successfully.");
    } catch (err) {
      console.error(`Failed to download embedding model: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

const creds = program
  .command("credentials")
  .description("Manage stored credentials");

creds
  .command("set <key> <value>")
  .description("Store a credential (e.g. telegram.bot_token)")
  .action(async (key: string, value: string) => {
    const { CredentialStore } = await import("@kirie/core");
    const store = new CredentialStore();
    await store.set(key, value);
    console.log(`Credential "${key}" saved.`);
  });

creds
  .command("get <key>")
  .description("Retrieve a stored credential")
  .action(async (key: string) => {
    const { CredentialStore } = await import("@kirie/core");
    const store = new CredentialStore();
    const value = await store.get(key);
    if (value === undefined) {
      console.error(`Credential "${key}" not found.`);
      process.exitCode = 1;
    } else {
      console.log(value);
    }
  });

creds
  .command("delete <key>")
  .description("Delete a stored credential")
  .action(async (key: string) => {
    const { CredentialStore } = await import("@kirie/core");
    const store = new CredentialStore();
    const deleted = await store.delete(key);
    if (deleted) {
      console.log(`Credential "${key}" deleted.`);
    } else {
      console.error(`Credential "${key}" not found.`);
      process.exitCode = 1;
    }
  });

creds
  .command("list")
  .description("List all stored credential keys")
  .action(async () => {
    const { CredentialStore } = await import("@kirie/core");
    const store = new CredentialStore();
    const keys = store.list();
    if (keys.length === 0) {
      console.log("No credentials stored.");
    } else {
      for (const key of keys) {
        console.log(`  ${key}`);
      }
    }
  });

program.parse();
