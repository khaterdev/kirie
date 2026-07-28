import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Tests for the platform-aware signal handling in the daemon lifecycle.
 *
 * We test the kill-signal logic in isolation by simulating the same
 * branching logic used in stopDaemon() for the Kokoro process cleanup.
 */

describe("Kokoro process kill - platform-aware signal handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockProcess() {
    return {
      killed: false,
      // Mirrors ChildProcess.kill, which takes an optional signal. forceKill
      // passes "SIGKILL" on non-Windows platforms.
      kill: vi.fn(function (this: { killed: boolean }, _signal?: NodeJS.Signals | number) {
        this.killed = true;
      }),
    };
  }

  /**
   * Simulates the kill logic from stopDaemon:
   *   if (process.platform === "win32") proc.kill()
   *   else proc.kill("SIGKILL")
   */
  function forceKill(proc: ReturnType<typeof createMockProcess>, platform: string) {
    if (platform === "win32") {
      proc.kill();
    } else {
      proc.kill("SIGKILL");
    }
  }

  it('calls kill() without signal on Windows ("win32")', () => {
    const proc = createMockProcess();
    forceKill(proc, "win32");
    expect(proc.kill).toHaveBeenCalledWith();
    expect(proc.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it('calls kill("SIGKILL") on macOS ("darwin")', () => {
    const proc = createMockProcess();
    forceKill(proc, "darwin");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it('calls kill("SIGKILL") on Linux ("linux")', () => {
    const proc = createMockProcess();
    forceKill(proc, "linux");
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kill call does not throw regardless of platform", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      const proc = createMockProcess();
      expect(() => forceKill(proc, platform)).not.toThrow();
    }
  });

  it("marks process as killed after kill call", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      const proc = createMockProcess();
      expect(proc.killed).toBe(false);
      forceKill(proc, platform);
      expect(proc.killed).toBe(true);
    }
  });
});
