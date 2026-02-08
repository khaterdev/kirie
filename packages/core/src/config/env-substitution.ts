/**
 * Recursively substitute ${VAR_NAME} references with environment variable values.
 * Escape with $${VAR_NAME} to produce literal ${VAR_NAME}.
 */
export function substituteEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\$\{(\w+)\}/g, "§§ESCAPED_$1§§")
      .replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
        const value = process.env[varName];
        if (value === undefined) {
          throw new Error(`Environment variable "${varName}" is not set (referenced in config)`);
        }
        return value;
      })
      .replace(/§§ESCAPED_(\w+)§§/g, "${$1}");
  }

  if (Array.isArray(obj)) {
    return obj.map(item => substituteEnvVars(item));
  }

  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }

  return obj;
}
