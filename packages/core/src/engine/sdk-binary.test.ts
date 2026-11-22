import { describe, it, expect } from "vitest";
import { accessSync, constants } from "node:fs";
import { checkClaudeBinary } from "./sdk-binary.js";

describe("checkClaudeBinary", () => {
  // Guards the install itself: if pnpm drops the SDK's optional platform
  // package, this fails in CI / the rebuild script instead of in production.
  it("finds an executable native binary for this platform", () => {
    const result = checkClaudeBinary();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.candidates[0]).toContain(`${process.platform}-${process.arch}`);
    expect(() => accessSync(result.path!, constants.X_OK)).not.toThrow();
  });
});
