import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../types.js";

interface MessageBubbleProps {
  message: ChatMessage;
}

function formatTime(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function MessageBubble({ message }: MessageBubbleProps): React.JSX.Element {
  const isUser = message.role === "user";
  const prefix = isUser ? "you" : "kirie";
  const prefixColor = isUser ? "green" : "magenta";

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color="gray" dimColor>
          {formatTime(message.timestamp)}{" "}
        </Text>
        <Text color={prefixColor} bold>
          {prefix}
        </Text>
        <Text color="gray">: </Text>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
      {message.toolCalls && message.toolCalls.length > 0 ? (
        <Box flexDirection="column" marginLeft={6}>
          {message.toolCalls.map((tool) => (
            <Box key={tool.id}>
              <Text color="gray">  </Text>
              <Text color={tool.status === "failed" ? "red" : "yellow"} dimColor>
                [{tool.name}]
              </Text>
              {tool.output ? (
                <Text color="gray" dimColor>
                  {" "}
                  {tool.output.length > 80 ? tool.output.slice(0, 80) + "..." : tool.output}
                </Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
