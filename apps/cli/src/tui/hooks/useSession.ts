import { useState, useCallback } from "react";
import type { SessionInfo } from "../types.js";

function generateSessionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "ses_";
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

interface UseSessionReturn {
  session: SessionInfo;
  incrementMessageCount: () => void;
  resetSession: () => void;
}

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<SessionInfo>(() => ({
    sessionId: generateSessionId(),
    channel: "cli",
    startedAt: new Date(),
    messageCount: 0,
  }));

  const incrementMessageCount = useCallback(() => {
    setSession((prev) => ({
      ...prev,
      messageCount: prev.messageCount + 1,
    }));
  }, []);

  const resetSession = useCallback(() => {
    setSession({
      sessionId: generateSessionId(),
      channel: "cli",
      startedAt: new Date(),
      messageCount: 0,
    });
  }, []);

  return { session, incrementMessageCount, resetSession };
}
