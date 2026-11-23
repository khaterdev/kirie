import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { OneShotError, runOneShot } from "./oneshot.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;

describe("runOneShot with an abort signal", () => {
  let dir: string;
  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "kirie-oneshot-sig-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({ kind: "judge" as const, model: "m", system: "s", prompt: "p", parse: (v: unknown) => v, cwd: join(dir, "cwd") });

  it("an already-aborted signal rejects with reason aborted and spawns nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await runOneShot({ ...base(), signal: ac.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OneShotError);
    expect((err as OneShotError).reason).toBe("aborted");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("aborting mid-call aborts the query and rejects with reason aborted", async () => {
    const ac = new AbortController();
    mockQuery.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve()));
        throw new Error("Operation aborted");
      })(),
    );
    const call = runOneShot({ ...base(), signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const err = await call.catch((e: unknown) => e);
    expect((err as OneShotError).reason).toBe("aborted");
  });

  it("a stream that just ends after the abort is still reported as aborted", async () => {
    const ac = new AbortController();
    mockQuery.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener("abort", () => resolve()));
      })(),
    );
    const call = runOneShot({ ...base(), signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(((await call.catch((e: unknown) => e)) as OneShotError).reason).toBe("aborted");
  });
});
