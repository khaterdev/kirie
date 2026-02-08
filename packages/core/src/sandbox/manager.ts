import { randomUUID } from "node:crypto";
import { execDocker, buildSandboxCreateArgs, ensureDockerImage } from "./docker.js";
import type { SandboxConfig, SandboxInstance } from "./types.js";

export class SandboxManager {
  private instances = new Map<string, SandboxInstance>();
  private config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  async createSandbox(agentId: string, sessionKey?: string, workspaceDir?: string): Promise<SandboxInstance> {
    await ensureDockerImage(this.config.docker.image);

    const containerId = `kirie-sandbox-${randomUUID().slice(0, 8)}`;
    const args = buildSandboxCreateArgs({
      name: containerId,
      config: this.config,
      workspaceDir,
      agentId,
      sessionKey,
    });

    const result = await execDocker(args);
    if (result.code !== 0) {
      throw new Error(`Failed to create sandbox: ${result.stderr}`);
    }

    // Start the container
    await execDocker(["start", containerId]);

    const instance: SandboxInstance = {
      containerId,
      agentId,
      sessionKey,
      scope: this.config.scope,
      createdAt: new Date().toISOString(),
      status: "running",
    };

    this.instances.set(containerId, instance);
    return instance;
  }

  async destroySandbox(containerId: string): Promise<void> {
    await execDocker(["rm", "-f", containerId]);
    this.instances.delete(containerId);
  }

  async execInSandbox(containerId: string, command: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return execDocker(["exec", containerId, ...command]);
  }

  async pruneIdle(maxIdleHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxIdleHours * 60 * 60 * 1000).toISOString();
    let pruned = 0;
    for (const [id, instance] of this.instances) {
      if (instance.createdAt < cutoff) {
        await this.destroySandbox(id);
        pruned++;
      }
    }
    return pruned;
  }

  listInstances(): SandboxInstance[] {
    return [...this.instances.values()];
  }
}
