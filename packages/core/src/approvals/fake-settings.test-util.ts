/**
 * Test-only in-memory stand-in for RuntimeSettings (get / effective / set / delete).
 * Not exported from the package and not bundled.
 */

import type { z } from "zod/v3";

export class FakeApprovalSettings {
  readonly map = new Map<string, unknown>();
  get<T>(key: string, schema: z.ZodType<T>): T | undefined {
    if (!this.map.has(key)) return undefined;
    const r = schema.safeParse(this.map.get(key));
    return r.success ? r.data : undefined;
  }
  effective<T>(key: string, schema: z.ZodType<T>, configValue: T): T {
    return this.get(key, schema) ?? configValue;
  }
  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
}
