/**
 * An in-memory stand-in for the docker CLI. Tests never run Docker: every
 * call is recorded and answered from this state.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_FINGERPRINT_LABEL } from "./docker.js";
import type { SandboxDockerExec, SandboxDockerResult } from "./types.js";

interface FakeContainer {
  id?: string;
  running: boolean;
  fingerprint?: string;
  labelled: boolean;
}

export class FakeDocker {
  calls: string[][] = [];
  daemonUp = true;
  images = new Set<string>(["kirie-sandbox:latest"]);
  containers = new Map<string, FakeContainer>();
  failCreate = false;
  failStart = false;
  /** Self-test answer; default: a correct, non-root, network-less container that writes the marker. */
  selfTest: (ws: string, marker: string) => SandboxDockerResult = (ws, marker) => {
    writeFileSync(join(ws, marker), "");
    return { stdout: "UID=501\nWS_OK\nNET=lo \n", stderr: "", code: 0 };
  };

  private nextId = 1;

  /** Find a container by name or id; returns its name key. */
  private ref(r: string): string | undefined {
    if (this.containers.has(r)) return r;
    for (const [name, c] of this.containers) if (c.id === r) return name;
    return undefined;
  }

  private ok(stdout = ""): SandboxDockerResult {
    return { stdout, stderr: "", code: 0 };
  }

  private down(): SandboxDockerResult {
    return { stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", code: 1 };
  }

  exec: SandboxDockerExec = async (args) => {
    this.calls.push([...args]);
    if (!this.daemonUp) return this.down();
    const [cmd, ...rest] = args;
    switch (cmd) {
      case "info":
        return this.ok("29.2.1\n");
      case "image":
        return this.images.has(rest[rest.length - 1]!) ? this.ok("sha256:abc\n") : { stdout: "", stderr: "Error: No such image", code: 1 };
      case "inspect": {
        const name = this.ref(rest[rest.length - 1]!);
        const c = name ? this.containers.get(name) : undefined;
        if (!name || !c) return { stdout: "", stderr: `Error: No such object: ${rest[rest.length - 1]}`, code: 1 };
        const format = rest[rest.indexOf("--format") + 1]!;
        if (format.includes("|")) return this.ok(`${c.id ?? name}|${c.running}|${c.fingerprint ?? "<no value>"}\n`);
        return this.ok(`${c.running}\n`);
      }
      case "ps":
        return this.ok([...this.containers.entries()].filter(([, c]) => c.labelled).map(([n]) => n).join("\n") + "\n");
      case "create": {
        if (this.failCreate) return { stdout: "", stderr: "Error response from daemon: create failed", code: 125 };
        const name = rest[rest.indexOf("--name") + 1]!;
        if (this.containers.has(name)) return { stdout: "", stderr: `Error response from daemon: Conflict. The container name "/${name}" is already in use`, code: 125 };
        const fp = rest.find((a) => a.startsWith(`${SANDBOX_FINGERPRINT_LABEL}=`))?.split("=")[1];
        const id = (this.nextId++).toString(16).padStart(64, "a");
        this.containers.set(name, { id, running: false, ...(fp ? { fingerprint: fp } : {}), labelled: rest.includes("kirie.sandbox=1") });
        return this.ok(`${id}\n`);
      }
      case "start": {
        const name = this.ref(rest[0]!);
        const c = name ? this.containers.get(name) : undefined;
        if (!c || this.failStart) return { stdout: "", stderr: "Error response from daemon: cannot start", code: 1 };
        c.running = true;
        return this.ok(`${rest[0]}\n`);
      }
      case "rm": {
        const name = this.ref(rest[rest.length - 1]!);
        return name && this.containers.delete(name) ? this.ok(`${name}\n`) : { stdout: "", stderr: `Error: No such container: ${rest[rest.length - 1]}`, code: 1 };
      }
      case "exec": {
        // exec -w <ws> <container> sh -c <script> sh <ws> <marker>
        const container = rest[2]!;
        const name = this.ref(container);
        const c = name ? this.containers.get(name) : undefined;
        if (!c || !c.running) return { stdout: "", stderr: `Error response from daemon: No such container: ${container}`, code: 1 };
        return this.selfTest(rest[rest.length - 2]!, rest[rest.length - 1]!);
      }
      default:
        return { stdout: "", stderr: `unexpected docker call ${cmd}`, code: 99 };
    }
  };

  /** Every argument of every call, flattened (for "never" assertions). */
  allArgs(): string[] {
    return this.calls.flat();
  }
}
