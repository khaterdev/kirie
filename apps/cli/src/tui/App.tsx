import React, { useState, useCallback } from "react";
import { Box, useApp, useInput, useStdout } from "ink";
import type { AgentEngine, SessionStore, ChatHistoryStore } from "@kirie/core";
import { ChatLog } from "./components/ChatLog.js";
import { StatusBar } from "./components/StatusBar.js";
import { InputBox } from "./components/InputBox.js";
import { useAgent } from "./hooks/useAgent.js";
import { useSession } from "./hooks/useSession.js";

interface AppProps {
  engine?: AgentEngine;
  /** SessionStore for cross-channel session sync */
  sessionStore?: SessionStore;
  /** Session key to sync with (e.g., "telegram:dm:12345") */
  sessionKey?: string;
  /** ChatHistoryStore for persistent message history */
  chatHistoryStore?: ChatHistoryStore;
}

export function App({ engine, sessionStore, sessionKey, chatHistoryStore }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 24;

  const { session, incrementMessageCount } = useSession();
  const { messages, streaming, connectionStatus, sendMessage, clearMessages } = useAgent({
    engine,
    sessionId: session.sessionId,
    sessionStore,
    sessionKey,
    chatHistoryStore,
  });

  const [inputFocused, setInputFocused] = useState(true);

  const handleSubmit = useCallback(
    async (content: string) => {
      if (content === "/quit" || content === "/exit") {
        exit();
        return;
      }

      if (content === "/clear") {
        clearMessages();
        return;
      }

      incrementMessageCount();
      await sendMessage(content);
      incrementMessageCount();
    },
    [exit, clearMessages, incrementMessageCount, sendMessage],
  );

  // Global keybindings
  useInput((_input, key) => {
    // Ctrl+C to exit
    if (key.ctrl && _input === "c") {
      exit();
      return;
    }

    // Escape toggles between scroll mode and input mode
    if (key.escape) {
      setInputFocused((prev) => !prev);
    }
  });

  // Reserve space: StatusBar ~3 lines, InputBox ~3 lines, padding ~1
  const chatLogHeight = Math.max(3, terminalHeight - 7);

  return (
    <Box flexDirection="column" height={terminalHeight}>
      <StatusBar
        connectionStatus={connectionStatus}
        session={session}
        isStreaming={streaming.isStreaming}
      />

      <ChatLog
        messages={messages}
        streaming={streaming}
        height={chatLogHeight}
        inputFocused={inputFocused}
      />

      <InputBox
        onSubmit={handleSubmit}
        isDisabled={streaming.isStreaming}
        isFocused={inputFocused}
      />
    </Box>
  );
}
