import pino from "pino";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import { getScrubber, SCRUB_WITHHELD } from "../security/secret-scrubber.js";

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

// ---------------------------------------------------------------------------
// Module loggers with secret scrubbing (PLAN B.8 "Logs")
// ---------------------------------------------------------------------------

/** Anything pino can write a serialized line to. */
export interface LogLineDestination {
  write(line: string): unknown;
}

export interface ModuleLoggerOptions {
  /** Minimum level. Default "info", the same as a bare `pino({ name })`. */
  level?: string;
  /** Where lines go. Default: one shared synchronous stdout destination. */
  destination?: LogLineDestination;
}

let sharedStdout: LogLineDestination | null = null;

function stdoutDestination(): LogLineDestination {
  // Tests that mock "pino" often provide only the logger factory; fall back to
  // a plain stdout writer so importing a module never throws.
  sharedStdout ??= typeof pino.destination === "function"
    ? pino.destination({ dest: 1, sync: true })
    : { write: (line: string) => process.stdout.write(line) };
  return sharedStdout;
}

/** The line written instead of a log line the scrubber could not process. */
export function withheldLogLine(): string {
  return `${JSON.stringify({ level: 50, time: Date.now(), msg: "«log line withheld: scrubber error»" })}\n`;
}

/**
 * Wrap a destination so every serialized line passes through the secret scrubber (sink "log")
 * before it is written. Scrubbing the whole JSON line covers `msg`, nested fields, `err.message`
 * and stack traces alike. If scrubbing fails, a fixed placeholder line is written instead.
 */
export function createScrubbingDestination(inner: LogLineDestination): LogLineDestination {
  return {
    write(line: string): unknown {
      let out: string;
      try {
        out = getScrubber().scrub(line, { sink: "log" });
        if (out === SCRUB_WITHHELD) out = withheldLogLine();
      } catch {
        out = withheldLogLine();
      }
      return inner.write(out);
    },
  };
}

/**
 * The one way core modules create a logger. Same output as `pino({ name })` (JSON on stdout,
 * level "info"), with every line scrubbed for secrets.
 */
export function createModuleLogger(name: string, opts?: ModuleLoggerOptions): pino.Logger {
  const destination = createScrubbingDestination(opts?.destination ?? stdoutDestination());
  return pino({ name, level: opts?.level ?? "info" }, destination as pino.DestinationStream);
}
