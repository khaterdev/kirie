import { describe, it, expect, vi } from "vitest";
import { ComputerUseConfigSchema } from "../config/sections/computer-use.js";
import {
  assertReadOnlyComputerUseDriverArgs,
  createComputerUseAppResolver,
  expandComputerUsePath,
  parseComputerUsePermissions,
  probeComputerUseDriver,
  stopComputerUseDriver,
  type ComputerUseExecFn,
  type ComputerUseExecResult,
} from "./driver.js";

const HOME = "/Users/tester";
const DRIVER = `${HOME}/.local/bin/cua-driver`;
const cfg = ComputerUseConfigSchema.parse({ enabled: true });

type Responder = (file: string, args: readonly string[]) => ComputerUseExecResult;

const ok = (stdout = "", stderr = ""): ComputerUseExecResult => ({ code: 0, stdout, stderr });
const fail = (stderr = "failed"): ComputerUseExecResult => ({ code: 1, stdout: "", stderr });

const GOOD_PERMS = JSON.stringify({ accessibility: { granted: true }, screen_recording: { granted: true }, attribution: "driver-daemon" });

function healthy(over: Partial<Record<string, ComputerUseExecResult>> = {}): Responder {
  return (file, args) => {
    const key = `${file === DRIVER ? "driver" : file} ${args.join(" ")}`;
    if (over[key]) return over[key]!;
    if (key === "driver --version") return ok("cua-driver 0.59.2\n");
    if (key.startsWith("/usr/bin/codesign --verify")) return ok();
    if (key.startsWith("/usr/bin/codesign -dv")) return ok("", "Executable=/Applications/CuaDriver.app/Contents/MacOS/CuaDriver\nIdentifier=com.trycua.driver\nFormat=app bundle\nTeamIdentifier=ABCDE12345\n");
    if (key === "driver status") return ok("running");
    if (key === "driver permissions status --json") return ok(GOOD_PERMS);
    return fail(`unexpected: ${key}`);
  };
}

function fakeExec(responder: Responder): { exec: ComputerUseExecFn; calls: Array<{ file: string; args: readonly string[] }> } {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const exec: ComputerUseExecFn = async (file, args) => {
    calls.push({ file, args });
    return responder(file, args);
  };
  return { exec, calls };
}

const FORBIDDEN = ["grant", "connect", "update", "serve", "install"];

function expectReadOnly(calls: Array<{ args: readonly string[] }>): void {
  for (const c of calls) {
    for (const word of FORBIDDEN) expect(c.args.map((a) => a.toLowerCase()), c.args.join(" ")).not.toContain(word);
  }
}

describe("probeComputerUseDriver", () => {
  it("healthy driver: installed, signed, running, both grants, driver-daemon attribution", async () => {
    const { exec, calls } = fakeExec(healthy());
    const s = await probeComputerUseDriver(cfg, { exec, isExecutable: (p) => p === DRIVER, homeDir: HOME });
    expect(s).toMatchObject({
      installed: true, healthy: true, version: "cua-driver 0.59.2", appBundleOk: true, bundleIdentifier: "com.trycua.driver",
      daemonRunning: true, accessibility: true, screenRecording: true, attribution: "driver-daemon", problems: [],
    });
    expect(s.driverPath).toBe(DRIVER);
    expectReadOnly(calls);
  });

  it("missing binary: not installed, setup steps, nothing executed", async () => {
    const { exec, calls } = fakeExec(healthy());
    const s = await probeComputerUseDriver(cfg, { exec, isExecutable: () => false, homeDir: HOME });
    expect(s.installed).toBe(false);
    expect(s.healthy).toBe(false);
    expect(s.problems[0]).toMatch(/not installed .*Kirie does not install it.*computer-use-setup\.md/);
    expect(calls).toHaveLength(0);
  });

  it("a relative driverPath is refused (never searched on PATH)", async () => {
    const { exec, calls } = fakeExec(healthy());
    const s = await probeComputerUseDriver(ComputerUseConfigSchema.parse({ driverPath: "cua-driver" }), { exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.problems[0]).toMatch(/absolute/);
    expect(calls).toHaveLength(0);
  });

  it("bad signature or wrong identifier is a problem", async () => {
    const bad = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "/usr/bin/codesign --verify --deep --strict /Applications/CuaDriver.app": fail() })).exec, isExecutable: () => true, homeDir: HOME });
    expect(bad.healthy).toBe(false);
    expect(bad.appBundleOk).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/does not verify/);
    const wrongId = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "/usr/bin/codesign -dv /Applications/CuaDriver.app": ok("", "Identifier=com.evil.driver\n") })).exec, isExecutable: () => true, homeDir: HOME });
    expect(wrongId.healthy).toBe(false);
    expect(wrongId.problems.join(" ")).toMatch(/not signed as com\.trycua\.driver/);
  });

  it("nothing from driverPath runs before the app and the CLI signatures verify", async () => {
    const { exec, calls } = fakeExec(healthy({ [`/usr/bin/codesign --verify --strict ${DRIVER}`]: fail() }));
    const s = await probeComputerUseDriver(cfg, { exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.problems.join(" ")).toMatch(/signature of .*cua-driver does not verify/);
    expect(calls.some((c) => c.file === DRIVER)).toBe(false);
    const order = fakeExec(healthy());
    await probeComputerUseDriver(cfg, { exec: order.exec, isExecutable: () => true, homeDir: HOME });
    const firstDriver = order.calls.findIndex((c) => c.file === DRIVER);
    const lastCodesign = order.calls.map((c) => c.file).lastIndexOf("/usr/bin/codesign");
    expect(lastCodesign).toBeLessThan(firstDriver);
  });

  it("a CLI signed by another team than the app is refused", async () => {
    const { exec, calls } = fakeExec(healthy({ [`/usr/bin/codesign -dv ${DRIVER}`]: ok("", "Identifier=cua-driver\nTeamIdentifier=ZZZZZ99999\n") }));
    const s = await probeComputerUseDriver(cfg, { exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.problems.join(" ")).toMatch(/not signed by the same team/);
    expect(calls.some((c) => c.file === DRIVER)).toBe(false);
  });

  it("requireSignedDriver off skips codesign with a warning", async () => {
    const { exec, calls } = fakeExec(healthy());
    const s = await probeComputerUseDriver(ComputerUseConfigSchema.parse({ requireSignedDriver: false }), { exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(true);
    expect(calls.some((c) => c.file === "/usr/bin/codesign")).toBe(false);
    expect(s.warnings.join(" ")).toMatch(/requireSignedDriver/);
  });

  it("permissions not granted are problems that name CuaDriver.app, not node", async () => {
    const perms = JSON.stringify({ accessibility: false, screenRecording: "denied", attribution: "driver-daemon" });
    const s = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "driver permissions status --json": ok(perms) })).exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.accessibility).toBe(false);
    expect(s.screenRecording).toBe(false);
    expect(s.problems.join(" ")).toMatch(/Accessibility is not granted to CuaDriver\.app/);
    expect(s.problems.join(" ")).toMatch(/Screen Recording/);
  });

  it("attribution caller is a problem; a missing attribution is only a warning", async () => {
    const caller = JSON.stringify({ accessibility: true, screen_recording: true, attribution: "caller" });
    const s = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "driver permissions status --json": ok(caller) })).exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.problems.join(" ")).toMatch(/attribution "caller"/);
    const none = JSON.stringify({ tcc_accessibility: "granted", tcc_screen_recording: "granted" });
    const n = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "driver permissions status --json": ok(none) })).exec, isExecutable: () => true, homeDir: HOME });
    expect(n.healthy).toBe(true);
    expect(n.warnings.join(" ")).toMatch(/attribution/);
  });

  it("unreadable permission JSON and command timeouts are reported, never thrown", async () => {
    const s = await probeComputerUseDriver(cfg, {
      exec: fakeExec(healthy({
        "driver permissions status --json": { code: -1, stdout: "", stderr: "", timedOut: true },
        "driver --version": { code: -1, stdout: "", stderr: "", timedOut: true },
      })).exec,
      isExecutable: () => true,
      homeDir: HOME,
    });
    expect(s.healthy).toBe(false);
    expect(s.problems.join(" ")).toMatch(/Could not read/);
    expect(s.warnings.join(" ")).toMatch(/timed out/);
  });

  it("a stopped daemon is a warning, not a problem", async () => {
    const s = await probeComputerUseDriver(cfg, { exec: fakeExec(healthy({ "driver status": fail("not running") })).exec, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(true);
    expect(s.daemonRunning).toBe(false);
    expect(s.warnings.join(" ")).toMatch(/not running/);
  });

  it("an exec that throws is reported as a problem", async () => {
    const s = await probeComputerUseDriver(cfg, { exec: async () => { throw new Error("spawn EACCES"); }, isExecutable: () => true, homeDir: HOME });
    expect(s.healthy).toBe(false);
    expect(s.problems.join(" ")).toMatch(/spawn EACCES/);
  });
});

describe("read-only guard and stop", () => {
  it("refuses grant, connect, update, serve, install, config set, telemetry enable, call", () => {
    for (const args of [["permissions", "grant"], ["connect"], ["update"], ["serve"], ["install"], ["config", "set", "x"], ["telemetry", "enable"], ["call", "click"]]) {
      expect(() => assertReadOnlyComputerUseDriverArgs(args), args.join(" ")).toThrow(/read-only/);
    }
    expect(() => assertReadOnlyComputerUseDriverArgs(["permissions", "status", "--json"])).not.toThrow();
    expect(() => assertReadOnlyComputerUseDriverArgs(["stop"])).not.toThrow();
  });

  it("stop runs `cua-driver stop` only when installed and its signature still verifies", async () => {
    const { exec, calls } = fakeExec(() => ok());
    expect(await stopComputerUseDriver(cfg, { exec, isExecutable: () => false, homeDir: HOME })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await stopComputerUseDriver(cfg, { exec, isExecutable: () => true, homeDir: HOME })).toBe(true);
    expect(calls).toEqual([{ file: "/usr/bin/codesign", args: ["--verify", "--strict", DRIVER] }, { file: DRIVER, args: ["stop"] }]);
    const swapped = fakeExec((file) => (file === "/usr/bin/codesign" ? fail() : ok()));
    expect(await stopComputerUseDriver(cfg, { exec: swapped.exec, isExecutable: () => true, homeDir: HOME })).toBe(false);
    expect(swapped.calls.some((c) => c.file === DRIVER)).toBe(false);
  });

  it("expands ~", () => {
    expect(expandComputerUsePath("~/.local/bin/cua-driver", HOME)).toBe(DRIVER);
    expect(expandComputerUsePath("/opt/x", HOME)).toBe("/opt/x");
  });
});

describe("parseComputerUsePermissions", () => {
  it("reads nested and flat shapes and rejects non-JSON", () => {
    expect(parseComputerUsePermissions(GOOD_PERMS)).toEqual({ accessibility: true, screenRecording: true, attribution: "driver-daemon" });
    expect(parseComputerUsePermissions(JSON.stringify({ permissions: { Accessibility: "authorized", ScreenCapture: "authorized" } }))).toEqual({ accessibility: true, screenRecording: true });
    expect(parseComputerUsePermissions("not json")).toBeNull();
  });
});

describe("createComputerUseAppResolver", () => {
  it("resolves a pid with lsappinfo and caches it for 30 s", async () => {
    let now = 0;
    const exec = vi.fn<ComputerUseExecFn>(async (_file, args) => {
      if (args.includes("bundleid")) return ok('"CFBundleIdentifier"="com.apple.Notes"\n');
      return ok('"LSDisplayName"="Notes"\n');
    });
    const resolve = createComputerUseAppResolver({ exec, now: () => now });
    expect(await resolve(321)).toEqual({ bundleId: "com.apple.Notes", name: "Notes" });
    expect(exec).toHaveBeenCalledWith("/usr/bin/lsappinfo", ["info", "-only", "bundleid", "321"], { timeoutMs: 2_000 });
    await resolve(321);
    expect(exec).toHaveBeenCalledTimes(2);
    now = 31_000;
    await resolve(321);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("an unknown pid or bad output resolves to null; invalid pids run nothing", async () => {
    const exec = vi.fn<ComputerUseExecFn>(async () => ok(""));
    const resolve = createComputerUseAppResolver({ exec });
    expect(await resolve(5)).toBeNull();
    expect(await resolve(-1)).toBeNull();
    expect(await resolve(1.5)).toBeNull();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
