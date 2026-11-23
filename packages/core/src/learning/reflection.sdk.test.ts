import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { LearningConfigSchema } from "../config/sections/learning.js";
import { SdkOptionsPipeline } from "../engine/sdk-options.js";
import { newToolUseSummary } from "../engine/tool-observer.js";
import { LearningIntake } from "./intake.js";
import { LearningKv } from "./learning-db.js";
import { ProposalStore } from "./proposal-store.js";
import { ReflectionEngine } from "./reflection.js";
import { SkillStateStore } from "./skill-state-store.js";
import { TurnRecorder } from "./turn-recorder.js";
import { OWNER_DM_KEY, tempLearningEnv, type TempLearningEnv } from "./learning.test-util.js";

const mockQuery = sdkQuery as unknown as ReturnType<typeof vi.fn>;
let env: TempLearningEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; mockQuery.mockReset(); });

describe("reflection model call (real runOneShot, mocked SDK)", () => {
  it("has no tools, no MCP servers, no setting sources, no persisted session, and a deny-all canUseTool", async () => {
    env = tempLearningEnv();
    const cfg = LearningConfigSchema.parse({ enabled: true });
    const store = new ProposalStore(env.db);
    const skillState = new SkillStateStore(env.db);
    const skillsRoot = join(env.dir, "skills");
    mkdirSync(skillsRoot);
    const recorder = new TurnRecorder({ db: env.db, store, skillState, untrustedTools: () => [], allowUntrustedSkillProposals: () => false, skillRoots: { project: skillsRoot } });
    const now = Date.now();
    recorder.record({
      sessionKey: OWNER_DM_KEY, source: "main", origin: "owner_message", userMsgId: 1, assistantMsgId: 2,
      startedAt: now - 1000, endedAt: now, numTurns: 1, costUsd: 0, isError: false, wasAborted: false, toolUse: newToolUseSummary(),
    });
    let captured: Options | undefined;
    mockQuery.mockImplementation(({ options }: { options: Options }) => {
      captured = options;
      return (async function* () {
        yield { type: "result", subtype: "success", is_error: false, result: "", structured_output: { memories: [], skills: [] }, total_cost_usd: 0.001, num_turns: 1 };
      })();
    });
    const engine = new ReflectionEngine({
      config: () => cfg,
      enabled: () => true,
      model: () => "utility-model",
      kv: new LearningKv(env.db),
      store,
      intake: new LearningIntake({ store, config: () => cfg, skillsRoot, skillState }),
      recorder,
      history: { recent: () => [
        { id: 1, role: "user", content: "hello", created_at: new Date(now).toISOString() },
        { id: 2, role: "assistant", content: "hi", created_at: new Date(now).toISOString() },
      ] },
      context: { skills: () => [], memoryKeys: () => [], memoryMdHeadings: () => [], readSkill: () => null },
      cwd: join(env.dir, "tmp", "oneshot"),
      sdkOptions: new SdkOptionsPipeline(),
    });
    const r = await engine.runNow(OWNER_DM_KEY);
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
    // The pipeline installs no hook for a no-tools kind.
    expect(captured!.hooks).toBeUndefined();
    const verdict = await captured!.canUseTool!("Write", { file_path: "/x" }, { signal: new AbortController().signal, toolUseID: "t", requestId: "r" } as never);
    expect(verdict?.behavior).toBe("deny");
  });
});
