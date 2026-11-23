import { describe, it, expect } from "vitest";
import { parseFrontmatter, parseSkillFile } from "./loader.js";

describe("parseFrontmatter (tolerant, for the curator)", () => {
  it("parses LF and CRLF files, a BOM, and a closing delimiter without a trailing newline", () => {
    expect(parseFrontmatter("---\nname: a\ndescription: d\n---\n\nbody\n")).toEqual({ frontmatter: { name: "a", description: "d" }, body: "body" });
    expect(parseFrontmatter("---\r\nname: a\r\ndescription: d\r\n---\r\nbody\r\n")).toEqual({ frontmatter: { name: "a", description: "d" }, body: "body" });
    expect(parseFrontmatter("﻿---\nname: a\n---")).toEqual({ frontmatter: { name: "a" }, body: "" });
    expect(parseFrontmatter("---\n---\nbody")).toEqual({ frontmatter: {}, body: "body" });
  });

  it("reports a missing block, bad YAML and a non-mapping without throwing", () => {
    expect(parseFrontmatter("# Remotion\n\nNo frontmatter at all.")).toEqual({ frontmatter: null, body: "# Remotion\n\nNo frontmatter at all.", error: "no frontmatter block" });
    const bad = parseFrontmatter("---\nname: [unclosed\n---\nbody");
    expect(bad.frontmatter).toBeNull();
    expect(bad.error).toMatch(/does not parse/);
    expect(bad.body).toBe("body");
    expect(parseFrontmatter("---\n- a\n- b\n---\nbody").error).toBe("frontmatter is not a YAML mapping");
  });

  it("does not end the block at a --- inside a line", () => {
    expect(parseFrontmatter("---\ndescription: a---b\n---\nbody").frontmatter).toEqual({ description: "a---b" });
  });

  it("parseSkillFile keeps its strict behaviour (the boot sync is unchanged)", () => {
    expect(parseSkillFile("---\r\nname: a\r\ndescription: d\r\n---\r\nbody", "/x", "bundled")).toBeNull();
    expect(parseSkillFile("no frontmatter", "/x", "bundled")).toBeNull();
    expect(parseSkillFile("---\nname: a\ndescription: d\n---\nbody", "/x", "bundled")?.name).toBe("a");
  });
});
