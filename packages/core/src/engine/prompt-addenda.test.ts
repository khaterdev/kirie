import { describe, it, expect } from "vitest";
import { PromptAddenda, appendPromptAddenda } from "./prompt-addenda.js";
import { buildPrompt, buildBackgroundTaskSystemPrompt } from "./prompt-builder.js";

const chatCtx = { kind: "chat" as const, channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true };

describe("PromptAddenda", () => {
  it("renders non-null addenda sorted by name, joined by blank lines", () => {
    const a = new PromptAddenda();
    a.register("zeta", () => "Z line");
    a.register("alpha", () => "A line");
    a.register("empty", () => null);
    a.register("blank", () => "   ");
    expect(a.render(chatCtx)).toBe("A line\n\nZ line");
  });

  it("throws on a duplicate or invalid name", () => {
    const a = new PromptAddenda();
    a.register("accounts", () => "x");
    expect(() => a.register("accounts", () => "y")).toThrow(/already registered/);
    expect(() => a.register("Bad Name", () => "y")).toThrow(/Invalid/);
  });

  it("skips an addendum that throws", () => {
    const a = new PromptAddenda();
    a.register("boom", () => { throw new Error("nope"); });
    a.register("ok", () => "fine");
    expect(a.render(chatCtx)).toBe("fine");
  });

  it("passes the context through so a feature can target the owner DM only", () => {
    const a = new PromptAddenda();
    a.register("owner-only", (ctx) => (ctx.ownerDm ? "owner text" : null));
    expect(a.render(chatCtx)).toBe("owner text");
    expect(a.render({ ...chatCtx, ownerDm: false })).toBe("");
  });

  it("appendPromptAddenda leaves the base unchanged when nothing renders", () => {
    expect(appendPromptAddenda("base", undefined, chatCtx)).toBe("base");
    expect(appendPromptAddenda("base", new PromptAddenda(), chatCtx)).toBe("base");
  });
});

describe("prompt-builder addenda hook", () => {
  const baseConfig = { maxTurns: 10, model: "test-model" };

  it("appends addenda at the end of the chat prompt with the sender context", () => {
    const a = new PromptAddenda();
    const seen: unknown[] = [];
    a.register("probe", (ctx) => { seen.push(ctx); return "<probe>hello</probe>"; });
    const built = buildPrompt({
      config: { ...baseConfig, addenda: a },
      channel: { channel: "telegram", chatType: "dm", chatId: "42" },
      sender: { name: "Owner", platformId: "42", role: "owner" },
    });
    expect(built.systemPrompt.append.endsWith("<probe>hello</probe>")).toBe(true);
    expect(seen[0]).toEqual({ kind: "chat", channel: "telegram", chatType: "dm", senderRole: "owner", ownerDm: true });
  });

  it("marks a group chat as not the owner DM", () => {
    const a = new PromptAddenda();
    const seen: Array<{ ownerDm: boolean }> = [];
    a.register("probe", (ctx) => { seen.push(ctx); return null; });
    buildPrompt({
      config: { ...baseConfig, addenda: a },
      channel: { channel: "telegram", chatType: "group", chatId: "-100" },
      sender: { name: "Owner", platformId: "42", role: "owner" },
    });
    expect(seen[0]?.ownerDm).toBe(false);
  });

  it("is unchanged without addenda", () => {
    const opts = {
      channel: { channel: "telegram", chatType: "dm" as const, chatId: "42" },
      sender: { name: "Owner", platformId: "42", role: "owner" as const },
    };
    const without = buildPrompt({ config: baseConfig, ...opts }).systemPrompt.append;
    const withEmpty = buildPrompt({ config: { ...baseConfig, addenda: new PromptAddenda() }, ...opts }).systemPrompt.append;
    expect(withEmpty.replace(/<current_time>.*<\/current_time>/, "")).toBe(without.replace(/<current_time>.*<\/current_time>/, ""));
  });

  it("appends background addenda with kind background", () => {
    const a = new PromptAddenda();
    a.register("probe", (ctx) => (ctx.kind === "background" ? "<bg>yes</bg>" : null));
    expect(buildBackgroundTaskSystemPrompt({ ...baseConfig, addenda: a }).endsWith("<bg>yes</bg>")).toBe(true);
  });

  it("no longer hard-codes the slash-command list", () => {
    const built = buildPrompt({
      config: { ...baseConfig, dataDir: "/nonexistent-kirie-prompt-test" },
      channel: { channel: "telegram", chatType: "dm", chatId: "42" },
      sender: { name: "Owner", platformId: "42", role: "owner" },
    });
    expect(built.systemPrompt.append).toContain("<slash_commands>");
    expect(built.systemPrompt.append).not.toContain("Users can type /help, /status");
  });
});
