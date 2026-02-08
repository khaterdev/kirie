import React from "react";
import { Box, Text } from "ink";
import type { ToolCall } from "../types.js";
import { Spinner } from "./Spinner.js";

interface ToolExecutionProps {
  toolCalls: ToolCall[];
}

function statusIcon(status: ToolCall["status"]): React.JSX.Element {
  switch (status) {
    case "running":
      return <Spinner />;
    case "completed":
      return <Text color="green">&#10003;</Text>;
    case "failed":
      return <Text color="red">&#10007;</Text>;
  }
}

export function ToolExecution({ toolCalls }: ToolExecutionProps): React.JSX.Element | null {
  if (toolCalls.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {toolCalls.map((tool) => (
        <Box key={tool.id} gap={1}>
          {statusIcon(tool.status)}
          <Text color="yellow">{tool.name}</Text>
          {tool.input ? (
            <Text color="gray" dimColor>
              ({tool.input.length > 60 ? tool.input.slice(0, 60) + "..." : tool.input})
            </Text>
          ) : null}
          {tool.status === "completed" && tool.output ? (
            <Text color="gray">
              {" -> "}
              {tool.output.length > 60 ? tool.output.slice(0, 60) + "..." : tool.output}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
