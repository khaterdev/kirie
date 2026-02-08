import { readFileSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { parse as parseYaml } from "yaml";

export const INCLUDE_KEY = "$include";
export const MAX_INCLUDE_DEPTH = 10;

export class ConfigIncludeError extends Error {
  readonly includePath: string;
  constructor(message: string, includePath: string, cause?: Error) {
    super(`Config include error (${includePath}): ${message}`);
    this.name = "ConfigIncludeError";
    this.includePath = includePath;
    if (cause) this.cause = cause;
  }
}

export class CircularIncludeError extends ConfigIncludeError {
  readonly chain: string[];
  constructor(chain: string[]) {
    super(`Circular include: ${chain.join(" → ")}`, chain[chain.length - 1]!);
    this.name = "CircularIncludeError";
    this.chain = chain;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source;
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (key in result && Array.isArray(result[key]) && Array.isArray(value)) {
      result[key] = [...(result[key] as unknown[]), ...value];
    } else if (
      key in result &&
      isPlainObject(result[key]) &&
      isPlainObject(value)
    ) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

class IncludeProcessor {
  private visited = new Set<string>();
  private depth = 0;
  constructor(private basePath: string) {}

  process(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.process(item));
    if (!isPlainObject(value)) return value;
    if (!(INCLUDE_KEY in value)) return this.processObject(value);
    return this.processInclude(value);
  }

  private processObject(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj))
      result[key] = this.process(val);
    return result;
  }

  private processInclude(obj: Record<string, unknown>): unknown {
    const includeValue = obj[INCLUDE_KEY];
    const otherKeys = Object.keys(obj).filter((k) => k !== INCLUDE_KEY);
    const included = this.resolveInclude(includeValue);
    if (otherKeys.length === 0) return included;
    if (!isPlainObject(included)) {
      throw new ConfigIncludeError(
        "Sibling keys require included content to be an object",
        String(includeValue),
      );
    }
    const rest: Record<string, unknown> = {};
    for (const key of otherKeys) rest[key] = this.process(obj[key]);
    return deepMerge(included, rest);
  }

  private resolveInclude(value: unknown): unknown {
    if (typeof value === "string") return this.loadFile(value);
    if (Array.isArray(value)) {
      return value.reduce<unknown>((merged, item) => {
        if (typeof item !== "string")
          throw new ConfigIncludeError(
            `Expected string in $include array, got ${typeof item}`,
            String(item),
          );
        return deepMerge(merged, this.loadFile(item));
      }, {});
    }
    throw new ConfigIncludeError(
      `Expected string or string[] for $include, got ${typeof value}`,
      String(value),
    );
  }

  private loadFile(includePath: string): unknown {
    const resolvedPath = resolve(dirname(this.basePath), includePath);
    if (this.visited.has(resolvedPath)) {
      throw new CircularIncludeError([...this.visited, resolvedPath]);
    }
    this.depth++;
    if (this.depth > MAX_INCLUDE_DEPTH) {
      throw new ConfigIncludeError(
        `Include depth exceeds ${MAX_INCLUDE_DEPTH}`,
        includePath,
      );
    }
    this.visited.add(resolvedPath);
    try {
      const raw = readFileSync(resolvedPath, "utf-8");
      const ext = extname(resolvedPath).toLowerCase();
      const parsed = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
      const nested = new IncludeProcessor(resolvedPath);
      nested.visited = new Set(this.visited);
      nested.depth = this.depth;
      return nested.process(parsed);
    } catch (err) {
      if (err instanceof ConfigIncludeError) throw err;
      throw new ConfigIncludeError(`Failed to load`, includePath, err as Error);
    } finally {
      this.visited.delete(resolvedPath);
      this.depth--;
    }
  }
}

export function processIncludes(config: unknown, configPath: string): unknown {
  return new IncludeProcessor(configPath).process(config);
}
