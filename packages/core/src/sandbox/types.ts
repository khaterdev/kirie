export type SandboxScope = "shared" | "agent" | "session";
export type SandboxMode = "off" | "docker";

export interface SandboxConfig {
  mode: SandboxMode;
  scope: SandboxScope;
  workspaceAccess: "rw" | "none";
  docker: {
    image: string;
    readOnlyRoot: boolean;
    network: "none" | "bridge" | "host";
    capDrop: string[];
    memory: string;
    cpus: number;
  };
  prune: {
    idleHours: number;
    maxAgeDays: number;
  };
}

export interface SandboxInstance {
  containerId: string;
  agentId: string;
  sessionKey?: string;
  scope: SandboxScope;
  createdAt: string;
  status: "created" | "running" | "stopped";
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: "off",
  scope: "agent",
  workspaceAccess: "rw",
  docker: {
    image: "kirie-sandbox:latest",
    readOnlyRoot: true,
    network: "none",
    capDrop: ["ALL"],
    memory: "512m",
    cpus: 1,
  },
  prune: {
    idleHours: 24,
    maxAgeDays: 7,
  },
};
