import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  buildPrompt,
  buildBackgroundTaskSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  MEMORY_PROPOSE_REPLACEMENTS,
  renderSelfLearningRules,
  type ChannelContext,
  type SenderIdentity,
  type PromptConfig,
} from "./prompt-builder.js";

const baseConfig: PromptConfig = {
  maxTurns: 10,
  model: "claude-opus-4-8",
};

const dmChannel: ChannelContext = {
  channel: "telegram",
  chatType: "dm",
  chatId: "12345",
};

const groupChannel: ChannelContext = {
  channel: "discord",
  chatType: "group",
  chatId: "guild-abc",
};

const threadChannel: ChannelContext = {
  channel: "slack",
  chatType: "thread",
  chatId: "channel-xyz",
  threadId: "thread-999",
};

const ownerSender: SenderIdentity = {
  name: "Alice",
  platformId: "user-001",
  role: "owner",
};

const adminSender: SenderIdentity = {
  name: "Bob",
  platformId: "user-002",
  role: "admin",
};

const userSender: SenderIdentity = {
  name: "Charlie",
  platformId: "user-003",
  role: "user",
};

const readonlySender: SenderIdentity = {
  name: "Dave",
  platformId: "user-004",
  role: "readonly",
};

describe("buildPrompt", () => {
  describe("system prompt structure", () => {
    it("returns a preset-type system prompt for claude_code", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });

      expect(result.systemPrompt.type).toBe("preset");
      expect(result.systemPrompt.preset).toBe("claude_code");
      expect(typeof result.systemPrompt.append).toBe("string");
    });

    it("passes through maxTurns and model from config", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });

      expect(result.maxTurns).toBe(10);
      expect(result.model).toBe("claude-opus-4-8");
    });

    it("converts maxTurns 0 to undefined (unlimited)", () => {
      const unlimitedConfig: PromptConfig = {
        maxTurns: 0,
        model: "claude-opus-4-8",
      };
      const result = buildPrompt({
        config: unlimitedConfig,
        channel: dmChannel,
        sender: ownerSender,
      });

      expect(result.maxTurns).toBeUndefined();
    });
  });

  describe("role-to-permission mapping", () => {
    it("maps owner to acceptEdits", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      expect(result.permissionMode).toBe("acceptEdits");
    });

    it("maps admin to acceptEdits", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: adminSender,
      });
      expect(result.permissionMode).toBe("acceptEdits");
    });

    it("maps user to default", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: userSender,
      });
      expect(result.permissionMode).toBe("default");
    });

    it("maps readonly to plan", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: readonlySender,
      });
      expect(result.permissionMode).toBe("plan");
    });
  });

  describe("XML context tags in appended prompt", () => {
    it("includes <assistant_identity> with the default system prompt", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("<assistant_identity>");
      expect(append).toContain("You are Kirie, a personal AI assistant.");
      expect(append).toContain("</assistant_identity>");
    });

    it("includes <channel_context> with channel details", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("<channel_context>");
      expect(append).toContain("Channel: telegram");
      expect(append).toContain("Chat type: dm");
      expect(append).toContain("Chat ID: 12345");
      expect(append).toContain("</channel_context>");
    });

    it("includes <sender_context> with sender details", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("<sender_context>");
      expect(append).toContain("Name: Alice");
      expect(append).toContain("Platform ID: user-001");
      expect(append).toContain("Role: owner");
      expect(append).toContain("</sender_context>");
    });

    it("includes <behavioral_rules>", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("<behavioral_rules>");
      expect(append).toContain("dm conversation on telegram");
      expect(append).toContain("</behavioral_rules>");
    });

    it("includes threadId in channel context when present", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: threadChannel,
        sender: userSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("Thread ID: thread-999");
    });

    it("omits threadId when not present", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).not.toContain("Thread ID:");
    });
  });

  describe("group chat behavioral rules", () => {
    it("adds concise/relevant rules for group chats", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: groupChannel,
        sender: userSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("keep responses concise and relevant");
      expect(append).toContain("Only respond when directly addressed");
    });

    it("does not add group-specific rules for DM chats", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: userSender,
      });
      const append = result.systemPrompt.append;

      expect(append).not.toContain("keep responses concise and relevant");
      expect(append).not.toContain("Only respond when directly addressed");
    });
  });

  describe("readonly behavioral rules", () => {
    it("adds readonly restriction for readonly users", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: readonlySender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("readonly access");
      expect(append).toContain("must not execute any tools");
    });

    it("does not add readonly restriction for other roles", () => {
      for (const sender of [ownerSender, adminSender, userSender]) {
        const result = buildPrompt({
          config: baseConfig,
          channel: dmChannel,
          sender,
        });
        expect(result.systemPrompt.append).not.toContain("readonly access");
      }
    });
  });

  describe("reply context instructions", () => {
    it("includes reply context guidance in behavioral rules", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("[Replying to ...]");
      expect(append).toContain("responding to a specific previous message");
    });
  });

  describe("custom instructions", () => {
    it("appends custom instructions inside assistant_identity", () => {
      const customConfig: PromptConfig = {
        customInstructions: "Always respond in Spanish. My name is Alex.",
        maxTurns: 5,
        model: "claude-opus-4-8",
      };

      const result = buildPrompt({
        config: customConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      // Default prompt is always included
      expect(append).toContain(DEFAULT_SYSTEM_PROMPT);
      // Custom instructions appear inside <assistant_identity>
      expect(append).toContain("Always respond in Spanish. My name is Alex.");
      expect(result.maxTurns).toBe(5);
    });

    it("uses only default prompt when no custom instructions given", () => {
      const result = buildPrompt({
        config: baseConfig,
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain(DEFAULT_SYSTEM_PROMPT);
    });
  });

  describe("SOUL.md context injection", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "kirie-test-soul-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("injects SOUL.md content inside <soul_context> tags", () => {
      const soulContent = `# Soul\n\n## Name\nKirie\n\n## Mission\n- Help the owner`;
      writeFileSync(join(tmpDir, "SOUL.md"), soulContent);

      const result = buildPrompt({
        config: { ...baseConfig, dataDir: tmpDir },
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("<soul_context>");
      expect(append).toContain("## Name\nKirie");
      expect(append).toContain("Help the owner");
      expect(append).toContain("</soul_context>");
    });

    it("places soul_context before memory_context", () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "# Soul\n## Name\nKirie");
      writeFileSync(join(tmpDir, "MEMORY.md"), "# Memory\n## Owner\nAlice");

      const result = buildPrompt({
        config: { ...baseConfig, dataDir: tmpDir },
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      const soulIdx = append.indexOf("<soul_context>");
      const memIdx = append.indexOf("<memory_context>");
      expect(soulIdx).toBeGreaterThan(-1);
      expect(memIdx).toBeGreaterThan(-1);
      expect(soulIdx).toBeLessThan(memIdx);
    });

    it("omits soul_context when SOUL.md is missing", () => {
      const result = buildPrompt({
        config: { ...baseConfig, dataDir: tmpDir },
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).not.toContain("<soul_context>");
    });

    it("includes soul update instructions in self_learning_rules", () => {
      writeFileSync(join(tmpDir, "SOUL.md"), "# Soul");

      const result = buildPrompt({
        config: { ...baseConfig, dataDir: tmpDir },
        channel: dmChannel,
        sender: ownerSender,
      });
      const append = result.systemPrompt.append;

      expect(append).toContain("Soul & Identity");
      expect(append).toContain("SOUL.md");
      expect(append).toContain("update SOUL.md accordingly");
    });
  });
});

describe("learning prompt rules (PLAN C.3, DECISIONS 4)", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "kirie-test-learning-rules-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function prompts(): string[] {
    const chat = buildPrompt({ config: { ...baseConfig, dataDir: tmpDir }, channel: dmChannel, sender: ownerSender });
    const background = buildBackgroundTaskSystemPrompt({ ...baseConfig, dataDir: tmpDir });
    return [`${chat.systemPrompt.append}\n${DEFAULT_SYSTEM_PROMPT}`, background];
  }

  it("the old self-edit text is gone from the chat and background prompts", () => {
    for (const text of prompts()) {
      expect(text).not.toContain("you document it as a reusable skill");
      expect(text).not.toContain("document it as a skill");
      expect(text).not.toContain("Update skills when you find better approaches");
      expect(text).not.toContain("Learning something = creating a skill");
    }
  });

  it("says to propose with learning_propose and to edit skills only on the owner's explicit request", () => {
    for (const text of prompts()) {
      expect(text).toContain("learning_propose");
      expect(text).toContain("only when the owner explicitly asks in the current conversation");
      expect(text).toContain("Never edit SOUL.md, TOOLS.md or any skill on your own initiative");
      expect(text).toContain("you cannot approve, apply or reject proposals");
    }
  });

  it("keeps the direct memory DB rules (memoryPolicy direct is the default)", () => {
    const [chat] = prompts();
    expect(chat).toContain("Save things here aggressively and often");
  });
});

describe("learning.memoryPolicy in the prompt (item 5)", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "kirie-test-memory-policy-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  function prompts(memoryPolicy?: "direct" | "propose"): string[] {
    const config = { ...baseConfig, dataDir: tmpDir, ...(memoryPolicy ? { memoryPolicy } : {}) };
    const chat = buildPrompt({ config, channel: dmChannel, sender: ownerSender });
    const background = buildBackgroundTaskSystemPrompt(config);
    // The clock line is the only part that changes between two builds.
    return [chat.systemPrompt.append, background].map((t) => t.replace(/<current_time>[^<]*<\/current_time>/g, ""));
  }

  it("direct is byte-identical to the rules before memoryPolicy existed", () => {
    // sha256 of SELF_LEARNING_RULES with dataDir "/DATA", taken from the source before this change.
    const hash = createHash("sha256").update(renderSelfLearningRules("/DATA", "direct")).digest("hex");
    expect(hash).toBe("61b9e1940a8a29f06f669ac4f9b0fd2345396d4c5dd37ca756a3aba2c79cf828");
    expect(renderSelfLearningRules("/DATA")).toBe(renderSelfLearningRules("/DATA", "direct"));
  });

  it("an unset memoryPolicy and \"direct\" build the same chat and background prompts", () => {
    expect(prompts("direct")).toEqual(prompts());
  });

  it("every replaced slice exists exactly once in the direct rules", () => {
    const direct = renderSelfLearningRules("/DATA", "direct");
    for (const { from } of MEMORY_PROPOSE_REPLACEMENTS) {
      expect(from.length).toBeGreaterThan(20);
      expect(direct.split(from)).toHaveLength(2);
    }
  });

  it("propose replaces the save-on-your-own rules in the chat and background prompts", () => {
    for (const text of prompts("propose")) {
      expect(text).not.toContain("Save things here aggressively and often");
      expect(text).not.toContain("WHAT TO SAVE");
      expect(text).not.toContain("Save AS YOU GO");
      expect(text).not.toContain("Proactive flush");
      expect(text).not.toContain("Proactively record");
      expect(text).not.toContain("Log a daily note entry for every significant conversation");
      expect(text).toContain("Memory policy is \"propose\"");
      expect(text).toContain("file it with learning_propose (kind memory, or memory_md for a MEMORY.md line)");
      expect(text).toContain("Use daily_note_append only when the owner asks you to note something");
      // The rest of the rules are untouched.
      expect(text).toContain("**HOW TO SAVE:**");
      expect(text).toContain("CRITICAL RULE — NEVER say");
      expect(text).toContain("Never edit SOUL.md, TOOLS.md or any skill on your own initiative");
    }
  });
});
