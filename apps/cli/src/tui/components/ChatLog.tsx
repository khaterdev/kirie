import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatMessage, StreamingState } from "../types.js";
import { MessageBubble } from "./MessageBubble.js";
import { ToolExecution } from "./ToolExecution.js";
import { Spinner } from "./Spinner.js";

interface ChatLogProps {
  messages: ChatMessage[];
  streaming: StreamingState;
  height: number;
  inputFocused: boolean;
}

export function ChatLog({ messages, streaming, height, inputFocused }: ChatLogProps): React.JSX.Element {
  // Track scroll offset: 0 = bottom (most recent), positive = scrolled up
  const [scrollOffset, setScrollOffset] = useState(0);

  // Reset scroll to bottom when new messages arrive
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  // Handle scroll keys when input is not focused
  useInput(
    (_input, key) => {
      if (key.upArrow || key.pageUp) {
        const step = key.pageUp ? Math.max(1, height - 2) : 1;
        setScrollOffset((prev) => Math.min(prev + step, Math.max(0, messages.length - 1)));
      }
      if (key.downArrow || key.pageDown) {
        const step = key.pageDown ? Math.max(1, height - 2) : 1;
        setScrollOffset((prev) => Math.max(0, prev - step));
      }
    },
    { isActive: !inputFocused },
  );

  // Calculate which messages to display
  const visibleCount = Math.max(1, height - (streaming.isStreaming ? 3 : 1));
  const endIndex = messages.length - scrollOffset;
  const startIndex = Math.max(0, endIndex - visibleCount);
  const visibleMessages = messages.slice(startIndex, Math.max(0, endIndex));

  const isScrolledUp = scrollOffset > 0;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.length === 0 && !streaming.isStreaming ? (
        <Box justifyContent="center" flexGrow={1}>
          <Text color="gray">
            Welcome to Kirie. Type a message to begin.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1}>
          {visibleMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {streaming.isStreaming ? (
            <Box flexDirection="column" marginBottom={0}>
              {streaming.activeToolCalls.length > 0 ? (
                <ToolExecution toolCalls={streaming.activeToolCalls} />
              ) : null}
              {streaming.partialContent ? (
                <Box>
                  <Text color="gray" dimColor>
                    {"      "}
                  </Text>
                  <Text color="magenta" bold>
                    kirie
                  </Text>
                  <Text color="gray">: </Text>
                  <Text wrap="wrap" dimColor>
                    {streaming.partialContent}
                  </Text>
                  <Text color="cyan">_</Text>
                </Box>
              ) : (
                <Box>
                  <Text color="gray" dimColor>
                    {"      "}
                  </Text>
                  <Spinner label="thinking..." />
                </Box>
              )}
            </Box>
          ) : null}
        </Box>
      )}

      {isScrolledUp ? (
        <Box justifyContent="center">
          <Text color="yellow" dimColor>
            -- scrolled up {scrollOffset} {scrollOffset === 1 ? "message" : "messages"} --
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
