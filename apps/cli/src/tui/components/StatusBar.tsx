import React from "react";
import { Box, Text } from "ink";
import type { ConnectionStatus, SessionInfo } from "../types.js";

interface StatusBarProps {
  connectionStatus: ConnectionStatus;
  session: SessionInfo;
  isStreaming: boolean;
}

function statusIndicator(status: ConnectionStatus): React.JSX.Element {
  switch (status) {
    case "connected":
      return <Text color="green">&#9679; connected</Text>;
    case "connecting":
      return <Text color="yellow">&#9679; connecting</Text>;
    case "disconnected":
      return <Text color="gray">&#9679; disconnected</Text>;
    case "error":
      return <Text color="red">&#9679; error</Text>;
  }
}

function formatUptime(startedAt: Date): string {
  const seconds = Math.floor((Date.now() - startedAt.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

export function StatusBar({ connectionStatus, session, isStreaming }: StatusBarProps): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingLeft={1}
      paddingRight={1}
      justifyContent="space-between"
    >
      <Box gap={2}>
        {statusIndicator(connectionStatus)}
        <Text color="gray">|</Text>
        <Text>
          <Text color="gray">ch:</Text>
          <Text color="cyan">{session.channel}</Text>
        </Text>
        <Text color="gray">|</Text>
        <Text>
          <Text color="gray">msgs:</Text>
          <Text>{session.messageCount}</Text>
        </Text>
      </Box>
      <Box gap={2}>
        {isStreaming ? <Text color="yellow">streaming...</Text> : null}
        <Text>
          <Text color="gray">session:</Text>
          <Text dimColor>{session.sessionId.slice(0, 12)}</Text>
        </Text>
        <Text color="gray">|</Text>
        <Text>
          <Text color="gray">up:</Text>
          <Text dimColor>{formatUptime(session.startedAt)}</Text>
        </Text>
      </Box>
    </Box>
  );
}
