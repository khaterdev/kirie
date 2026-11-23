import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../commands/registry.js";
import type { CommandReply } from "../commands/types.js";
import { OwnerDirectory } from "../interaction/owners.js";
import { RuntimeSettings } from "../config/runtime-settings.js";
import { AuditTrail } from "../security/audit-trail.js";
import type { UnifiedMessage, ChannelName } from "../channels/normalizer.js";
import type { ResolvedIdentity } from "../security/auth.js";
import { SandboxConfigSchema } from "../config/sections/sandbox.js";
import type { SdkCallContext } from "../engine/sdk-options.js";
import { SandboxController, SANDBOX_HEALTH_TICKS_DOWN, SANDBOX_HEALTH_TICKS_HEALTHY, SANDBOX_MODE_SCHEMA } from "./controller.js";
import { createSandboxCommands } from "./commands.js";
import { createSandboxContributor } from "./sdk-contributor.js";
import { createSandboxStatusApp } from "./status-api.js";
import { FakeDocker } from "./fake-docker.test-util.js";
import type { SandboxProbeResult } from "./native-probe.js";

const OWNER = "1001";
const STRANGER = "2002";

function msg(text: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return { id: "10", channel: "telegram" as ChannelName, senderId: OWNER, senderName: "Owner", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null, ...over } as UnifiedMessage;
}

describe("/sandbox and the controller", () => {
  let root: string;
  let home: string;
  let dataDir: string;
  let settings: RuntimeSettings;
  let audit: AuditTrail;
  let registry: CommandRegistry;
  let controller: SandboxController;
  let fake: FakeDocker;
  let confirmAnswer: "approved" | "denied";
  let requestApproval: ReturnType<typeof vi.fn>;
  let probe: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let binaryFound: boolean;
  let sessions: { closeIdleSessions: ReturnType<typeof vi.fn>; closeAndWait: ReturnType<typeof vi.fn>; isBusy: ReturnType<typeof vi.fn> };
  let busy: Set<string>;

  async function run(text: string, over: Partial<UnifiedMessage> = {}): Promise<{ kind: string; text: string }> {
    const replies: CommandReply[] = [];
    const message = msg(text, over);
    const outcome = await registry.dispatch({
      message,
      identity: { canonicalId: message.senderId, senderId: message.senderId, role: message.senderId === OWNER ? "owner" : "user", channel: "telegram" } as ResolvedIdentity,
      source: "channel",
      send: async (r) => { replies.push(r); },
    });
    return { kind: outcome.kind, text: replies.map((r) => r.text).join("\n") };
  }

  function build(config: Record<string, unknown> = {}): void {
    controller = new SandboxController({
      config: SandboxConfigSchema.parse(config),
      settings,
      dataDir,
      home,
      audit,
      notifyOwner: notify,
      sessions,
      nativeProbe: probe,
      resolveBinary: () => (binaryFound ? { ok: true, path: "/usr/local/bin/docker" } : { ok: false, reason: "no docker binary found" }),
      dockerExec: () => fake.exec,
      uid: 501,
      gid: 20,
    });
    registry = new CommandRegistry({ owners: new OwnerDirectory({ telegram: [OWNER] }), prompts: { requestApproval } as never, audit });
    registry.registerAll(createSandboxCommands({ controller }));
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kirie-sbx-cmd-")));
    home = join(root, "home");
    dataDir = join(home, ".kirie");
    mkdirSync(join(home, "dev"), { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    settings = new RuntimeSettings(join(dataDir, "state", "runtime-settings.json"));
    audit = new AuditTrail(join(dataDir, "logs", "audit.jsonl"));
    fake = new FakeDocker();
    confirmAnswer = "approved";
    requestApproval = vi.fn(async () => ({ outcome: confirmAnswer, optionId: confirmAnswer === "approved" ? "approve" : "deny", code: "K7Q2" }));
    probe = vi.fn(async (): Promise<SandboxProbeResult> => ({ ok: true }));
    notify = vi.fn();
    binaryFound = true;
    busy = new Set();
    sessions = {
      closeIdleSessions: vi.fn(() => 2),
      closeAndWait: vi.fn(async () => {}),
      isBusy: vi.fn((k: string) => busy.has(k)),
    };
    build();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("is owner-only and DM-only through the registry; synthetic text never runs it", async () => {
    expect((await run("/sandbox off", { senderId: STRANGER, chatId: STRANGER })).kind).toBe("denied");
    expect((await run("/sandbox docker", { chatType: "group", chatId: "-100" })).kind).toBe("denied");
    const def = registry.get("sandbox")!;
    expect(def).toMatchObject({ ownerOnly: true, scope: "dm", category: "security" });
    const outcome = await registry.dispatch({
      message: msg("/sandbox off"),
      identity: { canonicalId: OWNER, senderId: OWNER, role: "owner", channel: "telegram" } as ResolvedIdentity,
      source: "synthetic",
      send: async () => {},
    });
    expect(outcome.kind).toBe("not-command");
  });

  it("status says off by default and what is never sandboxed", async () => {
    const r = await run("/sandbox");
    expect(r.text).toMatch(/Sandbox: off \(from config\.yaml\)/);
    expect(r.text).toMatch(/Never sandboxed: .*MCP/);
    expect(controller.mode()).toBe("off");
  });

  it("native: runs the self-test, then persists and restarts idle sessions", async () => {
    const r = await run("/sandbox native");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/Testing the macOS sandbox/);
    expect(r.text).toMatch(/self-test passed/);
    expect(r.text).toMatch(/background tasks keep the mode they started with/);
    expect(controller.mode()).toBe("native");
    expect(settings.get("sandbox.mode", SANDBOX_MODE_SCHEMA)).toBe("native");
    expect(sessions.closeIdleSessions).toHaveBeenCalledWith(0);
    expect(audit.recent({ feature: "sandbox", action: "mode.changed" })).toHaveLength(1);
    // The probe got the real settings builder.
    const builder = probe.mock.calls[0]![0] as (cwd: string, extra: readonly string[]) => { enabled: boolean; filesystem: { denyWrite: string[] } };
    const s = builder("/probe/work", ["/probe/work/protected"]);
    expect(s.enabled).toBe(true);
    expect(s.filesystem.denyWrite).toContain("/probe/work/protected");
    expect(s.filesystem.denyWrite).toContain(join(dataDir, "secrets"));
  });

  it("native: a failed self-test refuses the switch with the reason", async () => {
    probe.mockResolvedValueOnce({ ok: false, reason: "a write outside the allowed folders succeeded" });
    const r = await run("/sandbox native");
    expect(r.text).toMatch(/Not switched to native: the self-test failed: a write outside/);
    expect(controller.mode()).toBe("off");
    expect(audit.recent({ feature: "sandbox", action: "mode.refused" })).toHaveLength(1);
  });

  it("docker: refused with the reason when the binary, Docker or the image is missing", async () => {
    binaryFound = false;
    build();
    expect((await run("/sandbox docker")).text).toMatch(/Not switched to docker: no docker binary found/);
    binaryFound = true;
    build();
    fake.daemonUp = false;
    expect((await run("/sandbox docker")).text).toMatch(/Not switched to docker: Docker is not reachable/);
    fake.daemonUp = true;
    fake.images.clear();
    expect((await run("/sandbox docker")).text).toMatch(/Not switched to docker: the image kirie-sandbox:latest is not built.*sandbox-setup\.sh/);
    expect(controller.mode()).toBe("off");
    expect(fake.allArgs()).not.toContain("pull");
  });

  it("docker: refused when the container fails its self-test", async () => {
    fake.selfTest = () => ({ stdout: "UID=0\nWS_OK\nNET=lo \n", stderr: "", code: 0 });
    const r = await run("/sandbox docker");
    expect(r.text).toMatch(/Not switched to docker: the container failed its self-test: the container runs as root/);
    expect(controller.mode()).toBe("off");
  });

  it("docker: ready, persisted; the contributor then routes Bash into the container", async () => {
    const r = await run("/sandbox docker");
    expect(r.text).toMatch(/Sandbox docker: the container is running/);
    expect(controller.mode()).toBe("docker");
    expect(controller.docker().healthy).toBe(true);
    expect(controller.approvalInfo()).toEqual({ mode: "docker", network: "none" });
    const opts = { cwd: dataDir, mcpServers: { "kirie-tools": { command: "node", args: ["x"], env: {} } } };
    const c: SdkCallContext = { kind: "chat", sessionKey: "telegram:dm:1", ownerDm: true, interactive: true, label: "chat", cwd: dataDir };
    createSandboxContributor({ source: controller, spawns: controller.spawns })(opts as never, c);
    expect((opts as { toolAliases?: Record<string, string> }).toolAliases).toEqual({ Bash: "mcp__kirie-tools__sandbox_bash" });
    const status = await run("/sandbox");
    expect(status.text).toMatch(/Docker binary: \/usr\/local\/bin\/docker/);
    expect(status.text).toMatch(/Container kirie-sandbox-shared: running/);
    expect(status.text).toMatch(/files written there land on this Mac/);
  });

  it("off needs a confirmation; cancel keeps the mode", async () => {
    await run("/sandbox docker");
    confirmAnswer = "denied";
    expect((await run("/sandbox off")).text).toMatch(/Cancelled/);
    expect(controller.mode()).toBe("docker");
    confirmAnswer = "approved";
    expect((await run("/sandbox off")).text).toMatch(/Sandbox off/);
    expect(controller.mode()).toBe("off");
    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({ kind: "confirm" });
  });

  it("allow-write refuses protected and broad paths and stores a project folder", async () => {
    for (const bad of ["~", "/", "~/.ssh", `${dataDir}/secrets`, `${dataDir}/state`, "~/Library"]) {
      expect((await run(`/sandbox allow-write ${bad}`)).text, bad).toMatch(/Not added/);
    }
    const r = await run("/sandbox allow-write ~/dev");
    expect(r.text).toMatch(new RegExp(`Added ${join(home, "dev").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(r.text).toMatch(/applies when the sandbox is native/);
    expect(controller.allowWrite()).toEqual([join(home, "dev")]);
    expect((await run("/sandbox allow-write ~/dev")).text).toMatch(/already writable/);
    expect((await run("/sandbox disallow-write ~/dev")).text).toMatch(/Removed/);
    expect(controller.allowWrite()).toEqual([]);
  });

  it("disallow-write cannot remove a config entry", async () => {
    build({ native: { allowWrite: ["~/dev"] } });
    expect((await run("/sandbox disallow-write ~/dev")).text).toMatch(/comes from config\.yaml/);
  });

  it("reset drops overrides after a confirmation when the mode changes", async () => {
    await run("/sandbox native");
    await run("/sandbox allow-write ~/dev");
    confirmAnswer = "denied";
    expect((await run("/sandbox reset")).text).toMatch(/Cancelled/);
    confirmAnswer = "approved";
    expect((await run("/sandbox reset")).text).toMatch(/overrides dropped. Mode from config\.yaml: off/);
    expect(controller.mode()).toBe("off");
    expect(controller.allowWrite()).toEqual([]);
  });

  it("recreate only in docker mode, and it runs the self-test again", async () => {
    expect((await run("/sandbox recreate")).text).toMatch(/only applies in docker mode/);
    await run("/sandbox docker");
    const creates = fake.calls.filter((c) => c[0] === "create").length;
    expect((await run("/sandbox recreate")).text).toMatch(/recreated and passed its self-test/);
    expect(fake.calls.filter((c) => c[0] === "create").length).toBe(creates + 1);
  });

  it("unknown subcommand shows usage", async () => {
    expect((await run("/sandbox launch")).text).toMatch(/Unknown subcommand/);
  });

  describe("docker mode from config: start, health, fail closed", () => {
    it("start brings the container up", async () => {
      build({ mode: "docker" });
      await controller.start();
      expect(controller.docker().healthy).toBe(true);
      expect(notify).not.toHaveBeenCalled();
    });

    it("start with Docker down fails closed and tells the owner once", async () => {
      build({ mode: "docker" });
      fake.daemonUp = false;
      await controller.start();
      expect(controller.docker().healthy).toBe(false);
      expect(controller.approvalInfo()).toEqual({ mode: "off" });
      expect(controller.addendum({ kind: "chat", ownerDm: true })).toMatch(/not running right now, so you have no shell/);
      controller.onTick(SANDBOX_HEALTH_TICKS_DOWN);
      await vi.waitFor(() => expect(fake.calls.filter((c) => c[0] === "info").length).toBeGreaterThan(1));
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0]![0]).toMatch(/shell commands are off.*Nothing runs on this Mac instead/);
    });

    it("a container that disappears is recreated on the next health tick", async () => {
      build({ mode: "docker" });
      await controller.start();
      fake.containers.clear();
      controller.onTick(SANDBOX_HEALTH_TICKS_HEALTHY);
      await vi.waitFor(() => expect(fake.containers.get("kirie-sandbox-shared")?.running).toBe(true));
      expect(controller.docker().healthy).toBe(true);
    });

    it("Docker going away marks the shell down until it is back", async () => {
      build({ mode: "docker" });
      await controller.start();
      fake.daemonUp = false;
      controller.onTick(SANDBOX_HEALTH_TICKS_HEALTHY);
      await vi.waitFor(() => expect(controller.docker().healthy).toBe(false));
      expect(notify).toHaveBeenCalledTimes(1);
      fake.daemonUp = true;
      controller.onTick(SANDBOX_HEALTH_TICKS_DOWN * 10);
      await vi.waitFor(() => expect(controller.docker().healthy).toBe(true));
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls[1]![0]).toMatch(/running again/);
    });

    it("stop removes the container when stopOnShutdown is set", async () => {
      build({ mode: "docker" });
      await controller.start();
      await controller.stop();
      expect(fake.containers.size).toBe(0);
    });

    it("stop leaves Docker alone when this process never used it", async () => {
      build({ mode: "off" });
      await controller.stop();
      expect(fake.calls).toEqual([]);
    });
  });

  it("chat sessions spawned before a change are restarted when idle; busy ones later", async () => {
    const spawnChat = (key: string): void => {
      createSandboxContributor({ source: controller, spawns: controller.spawns })({ cwd: dataDir } as never, { kind: "chat", sessionKey: key, ownerDm: true, interactive: true, label: "c", cwd: dataDir });
    };
    spawnChat("a");
    spawnChat("b");
    busy.add("b");
    await run("/sandbox native");
    await vi.waitFor(() => expect(sessions.closeAndWait).toHaveBeenCalledWith("a", 5000));
    expect(sessions.closeAndWait).not.toHaveBeenCalledWith("b", 5000);
    busy.delete("b");
    controller.onTick(1);
    await vi.waitFor(() => expect(sessions.closeAndWait).toHaveBeenCalledWith("b", 5000));
    // A session spawned with the new options is left alone.
    sessions.closeAndWait.mockClear();
    spawnChat("c");
    controller.onTick(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(sessions.closeAndWait).not.toHaveBeenCalled();
  });

  it("the prompt addendum names the shell tool in docker mode and is absent when off", async () => {
    expect(controller.addendum({ kind: "chat", ownerDm: true })).toBeNull();
    await run("/sandbox docker");
    const text = controller.addendum({ kind: "chat", ownerDm: true })!;
    expect(text).toContain("mcp__kirie-tools__sandbox_bash");
    expect(text).toMatch(/no network/);
    await run("/sandbox native");
    expect(controller.addendum({ kind: "background", ownerDm: false })).toMatch(/macOS sandbox/);
  });

  it("the status route is GET-only and changes nothing", async () => {
    const app = createSandboxStatusApp(controller);
    const res = await app.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "off", configuredMode: "off" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await app.request("/status", { method, body: JSON.stringify({ mode: "off" }) });
      expect(r.status, method).toBe(404);
    }
    expect((await app.request("/mode", { method: "POST" })).status).toBe(404);
    expect(controller.mode()).toBe("off");
  });
});
