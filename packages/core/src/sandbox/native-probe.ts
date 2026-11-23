/**
 * Self-test before `/sandbox native` is accepted (PLAN C.10).
 *
 * One `kind: "utility"` turn on the utility model with the real native
 * settings, in a fresh folder under `<dataDir>/tmp/sandbox-probe`. The model
 * runs one fixed Bash command that tries five writes; the result is read from
 * the disk, never from the model's reply:
 *
 *   inside the cwd                     must work
 *   outside the cwd                    must fail
 *   into a denyWrite folder            must fail
 *   into it through a case variant     must fail (APFS is case-insensitive)
 *   through a symlink to outside       must fail
 *
 * Nothing outside the probe folder is touched, and the folder is removed.
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { query as sdkQuery, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkOptionsPipeline } from "../engine/sdk-options.js";
import { createModuleLogger } from "../logging/logger.js";
import type { SandboxNativeSettings } from "./native.js";

const log = createModuleLogger("sandbox");

/** Long enough for the owner to answer an approval card when /approvals scope is "all". */
export const SANDBOX_PROBE_TIMEOUT_MS = 180_000;
export const SANDBOX_PROBE_BUDGET_USD = 0.05;

export interface SandboxProbeResult {
  ok: boolean;
  reason?: string;
  /** What was found on disk. */
  observed?: { inside: boolean; outside: boolean; denied: boolean; caseVariant: boolean; symlink: boolean };
}

type QueryFn = (args: { prompt: string; options: Options }) => Query;

export interface SandboxNativeProbeDeps {
  dataDir: string;
  model: string;
  /** The real native settings for a given cwd, with extra denyWrite entries. */
  buildSettings: (cwd: string, extraDenyWrite: readonly string[]) => SandboxNativeSettings;
  sdkOptions?: SdkOptionsPipeline;
  query?: QueryFn;
  timeoutMs?: number;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function runSandboxNativeProbe(deps: SandboxNativeProbeDeps): Promise<SandboxProbeResult> {
  const base = join(deps.dataDir, "tmp", "sandbox-probe", randomBytes(6).toString("hex"));
  const work = join(base, "work");
  const outside = join(base, "outside");
  const denied = join(work, "protected");
  try {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    mkdirSync(denied, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(work, "link"));
  } catch (err) {
    rmSync(base, { recursive: true, force: true });
    return { ok: false, reason: `could not prepare the probe folder: ${err instanceof Error ? err.message : String(err)}` };
  }

  const files = {
    inside: join(work, "in.txt"),
    outside: join(outside, "out.txt"),
    denied: join(denied, "p.txt"),
    caseVariant: join(work, "PROTECTED", "q.txt"),
    caseVariantReal: join(denied, "q.txt"),
    symlink: join(work, "link", "l.txt"),
    symlinkReal: join(outside, "l.txt"),
  };
  const command = [files.inside, files.outside, files.denied, files.caseVariant, files.symlink]
    .map((f) => `touch ${shellQuote(f)} 2>/dev/null`)
    .join("; ") + "; echo PROBE_DONE";

  const settings = deps.buildSettings(work, [denied]);
  const options: Options = {
    model: deps.model,
    cwd: work,
    tools: ["Bash"],
    allowedTools: ["Bash"],
    permissionMode: "bypassPermissions",
    settingSources: [],
    persistSession: false,
    strictMcpConfig: true,
    mcpServers: {},
    maxTurns: 4,
    maxBudgetUsd: SANDBOX_PROBE_BUDGET_USD,
    systemPrompt: "You are a one-step self-test. Run the single Bash command you are given exactly once, unchanged, without dangerouslyDisableSandbox. Then reply with the word DONE.",
    sandbox: settings,
  };
  deps.sdkOptions?.apply(options, { kind: "utility", ownerDm: false, interactive: false, label: "sandbox self-test", cwd: work });

  const run = deps.query ?? (sdkQuery as unknown as QueryFn);
  let q: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resultError: string | undefined;
  try {
    q = run({ prompt: `Run this command with the Bash tool:\n\n${command}`, options });
    const stream = q;
    const consume = (async () => {
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if (msg.type === "result") {
          if (msg.is_error || msg.subtype !== "success") {
            const text = "result" in msg && typeof msg.result === "string" ? msg.result : msg.subtype;
            resultError = String(text).split("\n")[0]!.slice(0, 200);
          }
          break;
        }
      }
    })();
    const outcome = await Promise.race([
      consume.then(() => "done" as const),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), deps.timeoutMs ?? SANDBOX_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (outcome === "timeout") return { ok: false, reason: "the self-test turn did not finish in time" };

    const observed = {
      inside: existsSync(files.inside),
      outside: existsSync(files.outside),
      denied: existsSync(files.denied),
      caseVariant: existsSync(files.caseVariantReal),
      symlink: existsSync(files.symlinkReal),
    };
    if (!observed.inside) {
      return { ok: false, observed, reason: resultError ? `the sandboxed command did not run (${resultError})` : "the sandboxed command did not run, so nothing could be checked" };
    }
    const leaks: string[] = [];
    if (observed.outside) leaks.push("a write outside the allowed folders succeeded");
    if (observed.denied) leaks.push("a write into a protected folder succeeded");
    if (observed.caseVariant) leaks.push("a write into a protected folder through a different letter case succeeded");
    if (observed.symlink) leaks.push("a write through a symlink to outside succeeded");
    if (leaks.length > 0) return { ok: false, observed, reason: leaks.join("; ") };
    return { ok: true, observed };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox self-test failed");
    return { ok: false, reason: `the self-test could not run: ${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
    try {
      q?.close();
    } catch {
      // already closed
    }
    rmSync(base, { recursive: true, force: true });
  }
}
