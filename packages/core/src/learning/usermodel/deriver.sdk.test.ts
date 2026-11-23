import { describe, it, expect, vi, afterEach } from "vitest";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { SdkOptionsPipeline } from "../../engine/sdk-options.js";
import { LearningKv } from "../learning-db.js";
import { UserModelDeriver } from "./deriver.js";
import { UserFactStore } from "./fact-store.js";
import { openUserModelHistorySource } from "./source.js";
import { tempUserModelEnv, testOwners, userModelConfig, type TempUserModelEnv } from "./usermodel.test-util.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;
let env: TempUserModelEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; mockQuery.mockReset(); });

describe("user model derivation call (real runOneShot, mocked SDK)", () => {
  it("has no tools, no MCP servers, no setting sources, no persisted session, and goes through the options pipeline", async () => {
    env = tempUserModelEnv();
    const id = env.addRow({ content: "I prefer short replies" });
    let captured: Options | undefined;
    mockQuery.mockImplementation(({ options }: { options: Options }) => {
      captured = options;
      return (async function* () {
        yield {
          type: "result", subtype: "success", is_error: false, result: "", total_cost_usd: 0.002, num_turns: 1,
          structured_output: { ops: [{ op: "add", category: "communication", statement: "Prefers short replies", kind: "explicit", evidence: [`c:${id}`] }] },
        };
      })();
    });
    const pipeline = new SdkOptionsPipeline();
    const seen: string[] = [];
    pipeline.registerContributor("account-env", (_o, ctx) => { seen.push(ctx.kind); }, 20);
    const store = new UserFactStore(env.db);
    const deriver = new UserModelDeriver({
      db: env.db, store, kv: new LearningKv(env.db), history: openUserModelHistorySource(env.historyPath), owners: testOwners,
      config: () => userModelConfig({ enabled: true }), enabled: () => true, model: () => "utility-model",
      embedder: () => null, intake: () => null, cwd: `${env.dir}/tmp/oneshot`, sdkOptions: pipeline,
    });
    const r = await deriver.run("command");
    expect(r.status).toBe("ok");
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      tools: [],
      mcpServers: {},
      settingSources: [],
      allowedTools: [],
      persistSession: false,
      strictMcpConfig: true,
      permissionMode: "default",
      model: "utility-model",
      outputFormat: { type: "json_schema" },
    });
    expect(captured!.hooks).toBeUndefined();
    const verdict = await captured!.canUseTool!("WebFetch", { url: "https://example.org" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as never);
    expect(verdict?.behavior).toBe("deny");
    // The account contributor ran: the call uses the same account selection as the chats.
    expect(seen).toEqual(["oneshot"]);
    expect(store.list().map((f) => f.statement)).toEqual(["Prefers short replies"]);
  });
});
