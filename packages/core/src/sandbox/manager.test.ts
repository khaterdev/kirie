import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import { SandboxManager } from "./manager.js";
import { FakeDocker } from "./fake-docker.test-util.js";

describe("SandboxManager (fake docker)", () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let ws: string;
  let fake: FakeDocker;

  const make = (over: Record<string, unknown> = {}, workspace = ws) =>
    new SandboxManager(SandboxConfigSchema.parse({ mode: "docker", docker: over }), {
      exec: fake.exec,
      workspaceDir: workspace,
      pathEnv: { home, dataDir },
      uid: 501,
      gid: 20,
    });

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-sbx-mgr-")));
    home = join(root, "home");
    dataDir = join(home, ".kirie");
    ws = join(dataDir, "sandbox-workspace");
    mkdirSync(dataDir, { recursive: true });
    fake = new FakeDocker();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("ensureShared creates and starts the shared container, then is idempotent", async () => {
    const m = make();
    const a = await m.ensureShared();
    expect(a.name).toBe("kirie-sandbox-shared");
    expect(fake.containers.get("kirie-sandbox-shared")?.running).toBe(true);
    const creates = () => fake.calls.filter((c) => c[0] === "create").length;
    expect(creates()).toBe(1);
    await m.ensureShared();
    await m.ensureShared();
    expect(creates()).toBe(1);
    expect(fake.allArgs()).not.toContain("pull");
  });

  it("starts a stopped container with the same configuration instead of recreating it", async () => {
    const m = make();
    await m.ensureShared();
    fake.containers.get("kirie-sandbox-shared")!.running = false;
    await m.ensureShared();
    expect(fake.calls.filter((c) => c[0] === "create")).toHaveLength(1);
    expect(fake.containers.get("kirie-sandbox-shared")?.running).toBe(true);
  });

  it("recreates a container whose configuration differs (never reuses a weaker one)", async () => {
    await make({ network: "bridge" }).ensureShared();
    await make({ network: "none" }).ensureShared();
    expect(fake.calls.filter((c) => c[0] === "create")).toHaveLength(2);
    expect(fake.calls.some((c) => c[0] === "rm" && c.includes("kirie-sandbox-shared"))).toBe(true);
  });

  it("recreates a stopped container that will not start", async () => {
    const m = make();
    await m.ensureShared();
    fake.containers.get("kirie-sandbox-shared")!.running = false;
    fake.failStart = true;
    await expect(m.ensureShared()).rejects.toThrow(/docker start failed/);
    expect(fake.containers.has("kirie-sandbox-shared")).toBe(false);
  });

  it("refuses when the image is missing and never pulls", async () => {
    fake.images.clear();
    await expect(make().ensureShared()).rejects.toThrow(/not present locally.*sandbox-setup\.sh/);
    expect(fake.allArgs()).not.toContain("pull");
    expect(fake.calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("refuses a workspace that would expose protected folders", async () => {
    await expect(make({}, home).ensureShared()).rejects.toThrow(/cannot be mounted/);
    await expect(make({}, dataDir).ensureShared()).rejects.toThrow(/cannot be mounted/);
    await expect(make({}, join(home, ".ssh")).ensureShared()).rejects.toThrow(/cannot be mounted/);
    expect(fake.calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("refuses a workspace that is a symlink into ~/.ssh", async () => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    symlinkSync(join(home, ".ssh"), ws);
    await expect(make().ensureShared()).rejects.toThrow(/cannot be mounted/);
    expect(fake.calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("reapOrphans removes only other labelled containers", async () => {
    fake.containers.set("kirie-sandbox-old1", { running: true, labelled: true });
    fake.containers.set("kirie-sandbox-old2", { running: false, labelled: true });
    fake.containers.set("someone-elses", { running: true, labelled: false });
    const m = make();
    await m.ensureShared();
    expect([...fake.containers.keys()].sort()).toEqual(["kirie-sandbox-shared", "someone-elses"]);
    expect(fake.calls.find((c) => c[0] === "ps")).toEqual(["ps", "-a", "--filter", "label=kirie.sandbox=1", "--format", "{{.Names}}"]);
  });

  it("health reports running, stopped, missing and unknown", async () => {
    const m = make();
    expect(await m.health()).toBe("missing");
    await m.ensureShared();
    expect(await m.health()).toBe("running");
    fake.containers.get("kirie-sandbox-shared")!.running = false;
    expect(await m.health()).toBe("stopped");
    fake.daemonUp = false;
    expect(await m.health()).toBe("unknown");
  });

  it("destroyAll removes the shared container and orphans", async () => {
    const m = make();
    await m.ensureShared();
    fake.containers.set("kirie-sandbox-old", { running: true, labelled: true });
    await m.destroyAll();
    expect(fake.containers.size).toBe(0);
    expect(m.current()).toBeNull();
  });

  it("selfTest passes for a correct container and cleans up its marker", async () => {
    const m = make();
    await m.ensureShared();
    expect(await m.selfTest()).toEqual({ ok: true });
  });

  it("selfTest fails for root, writable root, invisible workspace or a network interface", async () => {
    const m = make();
    await m.ensureShared();
    fake.selfTest = () => ({ stdout: "UID=0\nWS_OK\nNET=lo \n", stderr: "", code: 0 });
    expect((await m.selfTest()).reason).toMatch(/root/);
    fake.selfTest = (w, mk) => { mkdirSync(w, { recursive: true }); writeFileSync(join(w, mk), ""); return { stdout: "UID=501\nWS_OK\nROOT_WRITABLE\nNET=lo \n", stderr: "", code: 0 }; };
    expect((await m.selfTest()).reason).toMatch(/root filesystem is writable/);
    fake.selfTest = () => ({ stdout: "UID=501\nWS_OK\nNET=lo \n", stderr: "", code: 0 });
    expect((await m.selfTest()).reason).toMatch(/did not appear/);
    fake.selfTest = (w, mk) => { writeFileSync(join(w, mk), ""); return { stdout: "UID=501\nWS_OK\nNET=lo eth0 \n", stderr: "", code: 0 }; };
    expect((await m.selfTest()).reason).toMatch(/network interface/);
  });

  it("selfTest reports a missing container as a failure, not a host run", async () => {
    const m = make();
    const r = await m.selfTest();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/No such container/);
  });

  it("never adopts a container found by name: the first ensure in a process recreates it", async () => {
    const m = make();
    // Something with Docker access planted a container with our name and even our fingerprint label.
    fake.containers.set("kirie-sandbox-shared", { id: "f".repeat(64), running: true, fingerprint: m.fingerprint(), labelled: true });
    const inst = await m.ensureShared();
    expect(inst.containerId).not.toBe("f".repeat(64));
    expect(fake.calls.some((c) => c[0] === "rm" && c.includes("kirie-sandbox-shared"))).toBe(true);
    expect(fake.calls.filter((c) => c[0] === "create")).toHaveLength(1);
  });

  it("health and the self-test address the pinned id, not the name", async () => {
    const m = make();
    const inst = await m.ensureShared();
    // Replace the container under the same name: health must not accept it.
    fake.containers.delete("kirie-sandbox-shared");
    fake.containers.set("kirie-sandbox-shared", { id: "e".repeat(64), running: true, labelled: true });
    expect(await m.health()).toBe("missing");
    const execCall = () => fake.calls.filter((c) => c[0] === "exec").at(-1);
    await m.selfTest();
    expect(execCall()).toContain(inst.containerId);
  });

  it("refuses an image reference that docker would read as a flag; create never pulls", async () => {
    await expect(make({ image: "--privileged" }).ensureShared()).rejects.toThrow(/not a plain image reference/);
    expect(fake.calls.some((c) => c[0] === "create")).toBe(false);
    await make().ensureShared();
    const create = fake.calls.find((c) => c[0] === "create")!;
    expect(create.slice(0, 3)).toEqual(["create", "--pull", "never"]);
  });

  it("refuses a workspace that is or contains the agent's working directory or its settings", async () => {
    const withCwd = (workspace: string, agentCwd: string) =>
      new SandboxManager(SandboxConfigSchema.parse({ mode: "docker" }), { exec: fake.exec, workspaceDir: workspace, pathEnv: { home, dataDir, agentCwd }, uid: 501, gid: 20 });
    await expect(withCwd(join(home, "dev"), join(home, "dev", "proj")).ensureShared()).rejects.toThrow(/working directory/);
    await expect(withCwd(join(home, "dev", "proj"), join(home, "dev", "proj")).ensureShared()).rejects.toThrow(/working directory/);
    await expect(withCwd(join(dataDir, ".claude", "x"), dataDir).ensureShared()).rejects.toThrow(/protected/);
    await expect(withCwd(join(dataDir, "skills"), dataDir).ensureShared()).rejects.toThrow(/protected/);
  });
});
