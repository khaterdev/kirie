import pino from "pino";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";

export interface LoggerConfig {
  level?: string;        // default "info"
  fileLevel?: string;    // default "debug"
  logDir?: string;       // default ~/.kirie/logs
  component?: string;    // component name for correlation
}

/**
 * Create a structured logger that writes to both console and file.
 * File output goes to ~/.kirie/logs/kirie-YYYY-MM-DD.log (rolling daily).
 */
export function createLogger(config?: LoggerConfig): pino.Logger {
  const logDir = config?.logDir ?? join(homedir(), ".kirie", "logs");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const date = new Date().toISOString().split("T")[0];
  const logFile = join(logDir, `kirie-${date}.log`);

  const targets: pino.TransportTargetOptions[] = [
    {
      target: "pino/file",
      options: { destination: 1 }, // stdout
      level: config?.level ?? "info",
    },
    {
      target: "pino/file",
      options: { destination: logFile },
      level: config?.fileLevel ?? "debug",
    },
  ];

  return pino({
    level: "debug", // set to lowest; targets filter
    transport: { targets },
    base: config?.component ? { component: config.component } : undefined,
  });
}

/**
 * Create a child logger with a component name.
 */
export function childLogger(parent: pino.Logger, component: string): pino.Logger {
  return parent.child({ component });
}
