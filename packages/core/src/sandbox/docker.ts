import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toDockerPath } from "../platform.js";
import type { SandboxConfig } from "./types.js";

const execFileAsync = promisify(execFile);

export async function execDocker(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, { timeout: 30000 });
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

export async function isDockerAvailable(): Promise<boolean> {
  const result = await execDocker(["info", "--format", "{{.ServerVersion}}"]);
  return result.code === 0;
}

export async function ensureDockerImage(image: string): Promise<boolean> {
  const check = await execDocker(["image", "inspect", image]);
  if (check.code === 0) return true;
  const pull = await execDocker(["pull", image]);
  return pull.code === 0;
}

export function buildSandboxCreateArgs(params: {
  name: string;
  config: SandboxConfig;
  workspaceDir?: string;
  agentId: string;
  sessionKey?: string;
}): string[] {
  const args = ["create", "--name", params.name];

  // Labels for tracking
  args.push("--label", "kirie.sandbox=1");
  args.push("--label", `kirie.agentId=${params.agentId}`);
  if (params.sessionKey) args.push("--label", `kirie.sessionKey=${params.sessionKey}`);

  const { docker } = params.config;

  // Security
  if (docker.readOnlyRoot) args.push("--read-only");
  args.push("--tmpfs", "/tmp:rw,noexec,nosuid");
  for (const cap of docker.capDrop) {
    args.push("--cap-drop", cap);
  }

  // Resources
  args.push("--memory", docker.memory);
  args.push("--cpus", String(docker.cpus));

  // Network
  args.push("--network", docker.network);

  // Workspace mount (convert Windows paths for Docker Desktop)
  if (params.workspaceDir && params.config.workspaceAccess === "rw") {
    args.push("-v", `${toDockerPath(params.workspaceDir)}:/workspace:rw`);
  }

  args.push(docker.image);
  return args;
}

export async function dockerContainerState(name: string): Promise<{ exists: boolean; running: boolean }> {
  const result = await execDocker(["inspect", "--format", "{{.State.Running}}", name]);
  if (result.code !== 0) return { exists: false, running: false };
  return { exists: true, running: result.stdout.trim() === "true" };
}
