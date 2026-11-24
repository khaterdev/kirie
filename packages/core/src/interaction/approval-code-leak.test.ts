/**
 * Regression for CORE-B1 (review round 1b): the approval-code leak.
 *
 * The attack: an injected agent in ask mode starts a gated call, reads the
 * prompt's code from ~/.kirie/logs/audit.jsonl (it can read that file),
 * posts a look-alike text card ("Read README.md ... reply /approve K7Q2"),
 * and the owner types the code. Before the fix the real, dangerous request
 * was approved and the reply did not say what it approved.
 *
 * Now: the audit trail holds no code; even with the code (say, read off the
 * card some other way), a typed /approve on a channel with buttons only sends
 * the real card again, and every reply names the request.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditTrail } from "../security/audit-trail.js";
import { OwnerDirectory } from "./owners.js";
import { InteractionRouter } from "./router.js";
import { OwnerPrompts } from "./owner-prompts.js";
import { makeFakeAdapter, makeFakeRegistry, type FakeAdapter } from "./fake-channel.test-util.js";
import { CommandRegistry } from "../commands/registry.js";
import { createCoreCommands } from "../commands/builtin/core.js";

const OWNER = "1001";
const none = { telegram: [], discord: [], slack: [], whatsapp: [], signal: [] };

describe("CORE-B1 regression: an approval code cannot be lifted from the audit log and typed in from a look-alike card", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(adapter: FakeAdapter) {
    dir = mkdtempSync(join(tmpdir(), "kirie-b1-"));
    const auditPath = join(dir, "audit.jsonl");
    const audit = new AuditTrail(auditPath);
    const registry = makeFakeRegistry([adapter]);
    const owners = new OwnerDirectory({ ...none, telegram: [OWNER] });
    const router = new InteractionRouter({ channelRegistry: registry, owners, audit });
    router.attach(adapter);
    const prompts = new OwnerPrompts({ router, channelRegistry: registry, owners, audit, maxPending: 10 });
    const commands = new CommandRegistry({ owners, prompts, audit });
    commands.registerAll(
      createCoreCommands({
        help: commands,
        channelRegistry: { getRunning: () => [], getAll: () => new Map(), isRunning: () => true } as never,
        sessionStore: { count: () => 0, listAll: () => [], getRow: () => undefined } as never,
        prompts,
      }),
    );
    const typed = async (text: string): Promise<string[]> => {
      const replies: string[] = [];
      await commands.dispatch({
        message: { id: "m1", channel: "telegram", senderId: OWNER, senderName: "o", text, chatType: "dm", chatId: OWNER, timestamp: Date.now(), raw: null },
        identity: { role: "owner" } as never,
        source: "channel",
        send: async (r) => {
          replies.push(r.text);
        },
      });
      return replies;
    };
    return { auditPath, prompts, typed };
  }

  it("the audit file never contains the code, and a typed /approve on a button channel does not approve", async () => {
    const adapter = makeFakeAdapter("telegram");
    const { auditPath, prompts, typed } = setup(adapter);

    // 1. A gated tool call (ask mode) asks the owner.
    let settled = false;
    const pending = prompts.requestApproval({
      kind: "approval",
      title: "Approval needed",
      body: "Tool: Bash\nCommand:\nrm -rf ~/work/client-repo",
      summary: "Bash: rm -rf ~/work/client-repo",
      timeoutMs: 600_000,
    });
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 10));

    // 2. The agent reads the audit log: no code anywhere in it.
    const realCode = prompts.pending()[0]!.code;
    const auditText = readFileSync(auditPath, "utf8");
    const lines = auditText.trim().split("\n").map((l) => JSON.parse(l) as { action: string; detail: Record<string, unknown> });
    const sent = lines.find((l) => l.action === "prompt.sent")!;
    expect(sent.detail).not.toHaveProperty("code");
    expect(sent.detail.ref).toMatch(/^[0-9a-f]{12}$/);
    expect(auditText).not.toContain(realCode);

    // 3. Suppose the agent got the code anyway (e.g. read off the card). The owner types it from a look-alike card.
    const replies = await typed(`/approve ${realCode}`);
    await new Promise((r) => setTimeout(r, 10));

    // Not approved: the real card was sent again, with buttons, and the reply names the real request.
    expect(settled).toBe(false);
    expect(prompts.pending()).toHaveLength(1);
    expect(replies.join("\n")).toContain("rm -rf ~/work/client-repo");
    expect(replies.join("\n")).not.toMatch(/^Approved/m);
    expect(adapter.sentInteractive).toHaveLength(2);
    expect(adapter.sentInteractive.at(-1)!.text).toContain("rm -rf ~/work/client-repo");

    // The typed code is not written to the audit trail either.
    expect(readFileSync(auditPath, "utf8")).not.toContain(realCode);

    prompts.cancelAll("test");
    expect(await pending).toMatchObject({ outcome: "cancelled" });
  });

  it("on a channel without buttons, a typed /approve answers, and the reply says exactly what was approved", async () => {
    const adapter = makeFakeAdapter("telegram", { buttons: false });
    const { auditPath, prompts, typed } = setup(adapter);
    const pending = prompts.requestApproval({
      kind: "approval",
      title: "Approval needed",
      body: "Tool: Bash\nCommand:\nrm -rf ~/work/client-repo",
      summary: "Bash: rm -rf ~/work/client-repo",
      timeoutMs: 600_000,
    });
    await new Promise((r) => setTimeout(r, 10));
    const code = prompts.pending()[0]!.code;
    expect(readFileSync(auditPath, "utf8")).not.toContain(code);
    const replies = await typed(`/approve ${code}`);
    expect(await pending).toMatchObject({ outcome: "approved" });
    expect(replies).toEqual([`Approved ${code} (Approve): Bash: rm -rf ~/work/client-repo`]);
    expect(readFileSync(auditPath, "utf8")).not.toContain(code);
  });
});
