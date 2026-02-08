import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  probeGateway,
  detectSyncedFolders,
  collectAttackSurface,
  runDeepAudit,
} from "./audit.js";
import type { KirieConfig } from "../config/schema.js";
import { KirieConfigSchema } from "../config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, unknown> = {}): KirieConfig {
  return KirieConfigSchema.parse(overrides);
}

// ---------------------------------------------------------------------------
// probeGateway
// ---------------------------------------------------------------------------

describe("probeGateway", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports gateway as reachable when /health responds", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("OK", { status: 200 }),
    );

    const findings = await probeGateway("http://127.0.0.1:18789");

    expect(findings.some((f) => f.category === "gateway" && f.message.includes("reachable"))).toBe(true);
    const reachable = findings.find((f) => f.message.includes("reachable"));
    expect(reachable?.severity).toBe("info");
    expect(reachable?.message).toContain("200");
  });

  it("reports gateway as unreachable when /health fails", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );

    const findings = await probeGateway("http://127.0.0.1:18789");

    const unreachable = findings.find((f) => f.message.includes("not reachable"));
    expect(unreachable).toBeDefined();
    expect(unreachable?.severity).toBe("warning");
    expect(unreachable?.remediation).toBeDefined();
  });

  it("detects public exposure on non-loopback hostname", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("OK", { status: 200 }),
    );

    const findings = await probeGateway("http://192.168.1.100:18789");

    const exposure = findings.find((f) => f.message.includes("public interface"));
    expect(exposure).toBeDefined();
    expect(exposure?.severity).toBe("critical");
    expect(exposure?.remediation).toContain("localhost");
  });

  it("does not flag public exposure for localhost", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("OK", { status: 200 }),
    );

    const findings = await probeGateway("http://localhost:18789");

    const exposure = findings.find((f) => f.message.includes("public interface"));
    expect(exposure).toBeUndefined();
  });

  it("does not flag public exposure for 127.0.0.1", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("OK", { status: 200 }),
    );

    const findings = await probeGateway("http://127.0.0.1:18789");

    const exposure = findings.find((f) => f.message.includes("public interface"));
    expect(exposure).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectSyncedFolders
// ---------------------------------------------------------------------------

describe("detectSyncedFolders", () => {
  it("detects iCloud in state directory", () => {
    const findings = detectSyncedFolders(
      "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/.kirie",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("State directory");
    expect(findings[0]?.message).toContain("cloud-synced");
  });

  it("detects Dropbox in config path", () => {
    const findings = detectSyncedFolders(
      undefined,
      "/Users/me/Dropbox/kirie/config.yaml",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Config file");
  });

  it("detects Google Drive in state directory", () => {
    const findings = detectSyncedFolders(
      "/Users/me/Google Drive/My Drive/.kirie",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
  });

  it("detects OneDrive in config path", () => {
    const findings = detectSyncedFolders(
      undefined,
      "/Users/me/OneDrive/Documents/config.yaml",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("Config file");
  });

  it("returns no findings for normal paths", () => {
    const findings = detectSyncedFolders(
      "/home/me/.kirie",
      "/home/me/.kirie/config.yaml",
    );

    expect(findings).toHaveLength(0);
  });

  it("returns no findings when both args are undefined", () => {
    const findings = detectSyncedFolders(undefined, undefined);
    expect(findings).toHaveLength(0);
  });

  it("detects both state dir and config in synced folders", () => {
    const findings = detectSyncedFolders(
      "/Users/me/iCloud/.kirie",
      "/Users/me/Dropbox/config.yaml",
    );

    expect(findings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// collectAttackSurface
// ---------------------------------------------------------------------------

describe("collectAttackSurface", () => {
  it("flags open group policy as critical", () => {
    const config = makeConfig({
      security: { groupPolicy: "all" },
    });

    const findings = collectAttackSurface(config);

    const groupFinding = findings.find((f) => f.message.includes("Group policy"));
    expect(groupFinding).toBeDefined();
    expect(groupFinding?.severity).toBe("critical");
    expect(groupFinding?.category).toBe("attack-surface");
  });

  it("does not flag mention-only group policy", () => {
    const config = makeConfig({
      security: { groupPolicy: "mention-only" },
    });

    const findings = collectAttackSurface(config);

    const groupFinding = findings.find((f) => f.message.includes("Group policy"));
    expect(groupFinding).toBeUndefined();
  });

  it("flags disabled sandbox as info", () => {
    const config = makeConfig({
      sandbox: { mode: "off" },
    });

    const findings = collectAttackSurface(config);

    const sandboxFinding = findings.find((f) => f.message.includes("Sandbox disabled"));
    expect(sandboxFinding).toBeDefined();
    expect(sandboxFinding?.severity).toBe("info");
    expect(sandboxFinding?.remediation).toContain("Docker");
  });

  it("does not flag sandbox when docker mode is on", () => {
    const config = makeConfig({
      sandbox: { mode: "docker" },
    });

    const findings = collectAttackSurface(config);

    const sandboxFinding = findings.find((f) => f.message.includes("Sandbox disabled"));
    expect(sandboxFinding).toBeUndefined();
  });

  it("flags both open groups and disabled sandbox", () => {
    const config = makeConfig({
      security: { groupPolicy: "all" },
      sandbox: { mode: "off" },
    });

    const findings = collectAttackSurface(config);

    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.severity === "critical")).toBe(true);
    expect(findings.some((f) => f.severity === "info")).toBe(true);
  });

  it("returns empty for hardened config", () => {
    const config = makeConfig({
      security: { groupPolicy: "disabled" },
      sandbox: { mode: "docker" },
    });

    const findings = collectAttackSurface(config);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runDeepAudit (integration)
// ---------------------------------------------------------------------------

describe("runDeepAudit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an AuditReport with deep findings", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const config = makeConfig({
      security: { groupPolicy: "all" },
      sandbox: { mode: "off" },
    });

    const report = await runDeepAudit(config, {
      kirieDir: "/tmp/kirie-test-nonexistent",
    });

    expect(report.timestamp).toBeInstanceOf(Date);
    expect(report.totalFindings).toBeGreaterThan(0);
    expect(report.findings.length).toBe(report.totalFindings);

    // Should include gateway finding (unreachable since we mocked rejection)
    expect(report.findings.some((f) => f.category === "gateway")).toBe(true);

    // Should include attack surface findings
    expect(report.findings.some((f) => f.category === "attack-surface")).toBe(true);

    // Should have the code-safety pass since the temp dir doesn't exist
    expect(report.findings.some((f) => f.category === "code-safety")).toBe(true);
  });

  it("marks report as failed when critical findings exist", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED"),
    );

    const config = makeConfig({
      security: { groupPolicy: "all" },
    });

    const report = await runDeepAudit(config, {
      kirieDir: "/tmp/kirie-test-nonexistent",
    });

    // groupPolicy "all" produces a critical attack-surface finding
    expect(report.passed).toBe(false);
    expect(report.summary.critical).toBeGreaterThan(0);
  });
});
