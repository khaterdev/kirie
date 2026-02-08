/**
 * OpenTelemetry instrumentation helpers for Kirie.
 * Provides trace wrappers for agent execution, tool calls, and channel I/O.
 */

/** Telemetry configuration */
export interface TelemetryConfig {
  enabled: boolean;
  exporter: "console" | "otlp" | "jaeger";
  endpoint?: string;
  serviceName?: string;
}

/**
 * Trace context for a span. When telemetry is disabled,
 * these are no-ops that just call the wrapped function.
 */
export interface TraceContext {
  traceAgentExecution<T>(
    sessionKey: string,
    agentId: string,
    fn: () => Promise<T>,
  ): Promise<T>;
  traceToolCall<T>(toolName: string, fn: () => Promise<T>): Promise<T>;
  traceChannelIO<T>(
    channel: string,
    direction: "in" | "out",
    fn: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Creates a no-op trace context when telemetry is disabled.
 * All methods simply call the wrapped function directly.
 */
export function createNoopTraceContext(): TraceContext {
  return {
    async traceAgentExecution<T>(_sessionKey: string, _agentId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceToolCall<T>(_toolName: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async traceChannelIO<T>(_channel: string, _direction: "in" | "out", fn: () => Promise<T>): Promise<T> {
      return fn();
    },
  };
}

/**
 * Creates a trace context with OpenTelemetry spans.
 * Requires @opentelemetry/api to be installed.
 * Falls back to noop if the package is not available.
 */
export function createTraceContext(config: TelemetryConfig): TraceContext {
  if (!config.enabled) return createNoopTraceContext();

  // Dynamic import to avoid hard dependency on opentelemetry
  let tracer: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const otel = require("@opentelemetry/api");
    tracer = otel.trace.getTracer(config.serviceName ?? "kirie-core", "0.1.0");
  } catch {
    // OpenTelemetry not installed -- fall back to noop
    return createNoopTraceContext();
  }

  return {
    async traceAgentExecution<T>(sessionKey: string, agentId: string, fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan("agent.execute", {
        attributes: { "session.key": sessionKey, "agent.id": agentId },
      }, async (span: any) => {
        try {
          const result = await fn();
          span.setStatus({ code: 1 }); // OK
          return result;
        } catch (err) {
          span.setStatus({ code: 2, message: String(err) }); // ERROR
          throw err;
        } finally {
          span.end();
        }
      });
    },
    async traceToolCall<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan("tool.call", {
        attributes: { "tool.name": toolName },
      }, async (span: any) => {
        try {
          const result = await fn();
          span.setStatus({ code: 1 });
          return result;
        } catch (err) {
          span.setStatus({ code: 2, message: String(err) });
          throw err;
        } finally {
          span.end();
        }
      });
    },
    async traceChannelIO<T>(channel: string, direction: "in" | "out", fn: () => Promise<T>): Promise<T> {
      return tracer.startActiveSpan(`channel.${direction}`, {
        attributes: { "channel.name": channel, "channel.direction": direction },
      }, async (span: any) => {
        try {
          const result = await fn();
          span.setStatus({ code: 1 });
          return result;
        } catch (err) {
          span.setStatus({ code: 2, message: String(err) });
          throw err;
        } finally {
          span.end();
        }
      });
    },
  };
}
