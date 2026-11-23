import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillStateRecord } from "@kirie/core";
import { detectBroken, detectDrift, detectDuplicates, detectStale, mentionsSkill, referencedFiles } from "./detectors.js";
import { clusterPairs } from "./similarity.js";
import { snapshotSkill, sha256Text, type CuratorSkillSource, type SkillSnapshot } from "./snapshot.js";
import { fixtureTree, skillMd, stateRow, testEnv, type FixtureTree } from "./curator.test-util.js";
import type { SkillDefinition } from "../types.js";

let tree: FixtureTree;
beforeEach(() => { tree = fixtureTree(); });
afterEach(() => tree.cleanup());

function snap(name: string, opts: { source?: CuratorSkillSource; state?: Partial<SkillStateRecord> | null; original?: SkillDefinition; root?: "project" | "user"; dir?: string } = {}): SkillSnapshot {
  const state = opts.state === null ? null : stateRow(name, opts.state ?? {});
  return snapshotSkill(opts.dir ?? join(tree.root, name), name, {
    root: opts.root ?? "project",
    source: opts.source ?? "local",
    state,
    ...(opts.original ? { bundledOriginal: opts.original } : {}),
  });
}

function detectors(findings: Array<{ skill: string; detector: string }>, skill: string): string[] {
  return findings.filter((f) => f.skill === skill).map((f) => f.detector).sort();
}

function bundledDef(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return { name, description: `How to ${name}`, content: "x", source: "bundled", filePath: `/repo/skills/${name}/SKILL.md`, ...over };
}

describe("broken detectors", () => {
  it("B1 to B10, one case each, without throwing on a skill with no frontmatter", () => {
    mkdirSync(join(tree.root, "empty-dir"));
    tree.write("remotion", { "SKILL.md": "# Remotion\n\nRender videos with React.\n" });
    tree.write("bad-yaml", { "SKILL.md": "---\nname: [oops\n---\nbody\n" });
    tree.write("no-desc", { "SKILL.md": "---\nname: no-desc\n---\nbody\n" });
    tree.write("renamed", { "SKILL.md": skillMd("other-name") });
    tree.write("angle", { "SKILL.md": skillMd("angle", "Use <b>this</b>") });
    tree.write("refs", { "SKILL.md": skillMd("refs", "Refs", "Run `scripts/go.sh` and read [the guide](references/guide.md) and [site](https://example.com).\n"), "references/guide.md": "ok" });
    tree.write("needs-bin", { "SKILL.md": "---\nname: needs-bin\ndescription: d\nmetadata:\n  requires:\n    bins: [definitely-missing-bin]\n---\nbody\n" });
    tree.write("huge", { "SKILL.md": skillMd("huge", "Huge", "x".repeat(24_500)) });
    tree.write("evil", { "SKILL.md": skillMd("evil", "Evil", "```js\neval(input)\n```\n") });
    tree.write("weather", { "SKILL.md": skillMd("weather") });

    const snaps = [
      snap("empty-dir"), snap("remotion"), snap("bad-yaml"), snap("no-desc"), snap("renamed"), snap("angle"),
      snap("refs"), snap("needs-bin"), snap("huge"), snap("evil"),
      snap("weather", { source: "bundled", original: bundledDef("weather", { requires: { bins: ["curl-missing"], env: ["MISSING_KEY"] } }) }),
    ];
    const f = detectBroken(snaps, testEnv());
    expect(detectors(f, "empty-dir")).toEqual(["B1"]);
    expect(detectors(f, "remotion")).toEqual(["B2"]);
    expect(f.find((x) => x.skill === "remotion")!.severity).toBe("error");
    expect(detectors(f, "bad-yaml")).toEqual(["B2"]);
    expect(detectors(f, "no-desc")).toEqual(["B3"]);
    expect(detectors(f, "renamed")).toEqual(["B4"]);
    expect(detectors(f, "angle")).toEqual(["B5"]);
    expect(detectors(f, "refs")).toEqual(["B6"]);
    expect(f.find((x) => x.detector === "B6")!.data).toEqual({ missing: ["scripts/go.sh"] });
    expect(detectors(f, "weather")).toEqual(["B7"]);
    expect(f.find((x) => x.detector === "B7")!.data).toEqual({ missing: ["bin curl-missing", "env MISSING_KEY"] });
    expect(detectors(f, "needs-bin")).toEqual(["B8"]);
    expect(detectors(f, "huge")).toEqual(["B9"]);
    expect(detectors(f, "evil")).toEqual(["B10"]);
  });

  it("tolerates CRLF frontmatter; an eligible bundled original is not B7", () => {
    tree.write("crlf", { "SKILL.md": "---\r\nname: crlf\r\ndescription: Windows line endings\r\n---\r\nbody\r\n" });
    tree.write("weather", { "SKILL.md": skillMd("weather") });
    const f = detectBroken([snap("crlf"), snap("weather", { source: "bundled", original: bundledDef("weather", { requires: { bins: ["git"], env: ["PRESENT_KEY"] }, os: ["darwin"] }) })], testEnv());
    expect(f).toEqual([]);
  });

  it("reports symlinked and nested skill dirs as warnings", () => {
    const real = join(tree.dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "SKILL.md"), skillMd("linked"));
    symlinkSync(real, join(tree.root, "linked"));
    tree.write("bundle", { "SKILL.md": skillMd("bundle"), "inner/SKILL.md": skillMd("inner") });
    const f = detectBroken([snap("linked"), snap("bundle")], testEnv());
    expect(detectors(f, "linked")).toEqual(["symlink"]);
    expect(detectors(f, "bundle")).toEqual(["nested"]);
  });

  it("referencedFiles ignores URLs, absolute paths and code fences", () => {
    expect(referencedFiles("See [a](./assets/a.png), [b](https://x.y/z), [c](/etc/x), `references/r.md`, `npm i`\n```\ncat scripts/inside-fence.sh\n```")).toEqual(["assets/a.png", "references/r.md"]);
  });
});

describe("duplicate detectors", () => {
  it("D1 exact content: archives the less used one and never prefers the bundled one", () => {
    tree.write("alpha", { "SKILL.md": "same" });
    tree.write("beta", { "SKILL.md": "same" });
    tree.write("gamma", { "SKILL.md": "same" });
    const r = detectDuplicates([
      snap("alpha", { state: { useCount: 1 } }),
      snap("beta", { state: { useCount: 9 } }),
      snap("gamma", { source: "bundled", state: { useCount: 0 } }),
    ], { threshold: 0.9, vectors: null });
    expect(r.exact.map((e) => e.archive).sort()).toEqual(["alpha", "beta"]);
    expect(new Set(r.exact.map((e) => e.keep))).toEqual(new Set(["gamma"]));
  });

  it("D2 reports the same name in both roots", () => {
    tree.write("deploy", { "SKILL.md": skillMd("deploy") });
    const userRoot = join(tree.dir, "user-skills");
    mkdirSync(join(userRoot, "deploy"), { recursive: true });
    writeFileSync(join(userRoot, "deploy", "SKILL.md"), skillMd("deploy", "Other"));
    const r = detectDuplicates([snap("deploy"), snap("deploy", { root: "user", source: "user", dir: join(userRoot, "deploy") })], { threshold: 0.9, vectors: null });
    expect(r.findings.map((x) => x.detector)).toEqual(["D2"]);
  });

  it("D3 with a stub embedder: cosine above the threshold makes a cluster; D4 marks it likely", () => {
    tree.write("pdf-tools", { "SKILL.md": skillMd("pdf-tools", "Work with PDF files") });
    tree.write("pdf-helper", { "SKILL.md": skillMd("pdf-helper", "Edit PDF documents") });
    tree.write("weather", { "SKILL.md": skillMd("weather", "Get the forecast") });
    const vectors = {
      nameDescription: new Map([["pdf-tools", [1, 0, 0]], ["pdf-helper", [0.95, 0.1, 0]], ["weather", [0, 0, 1]]]),
      body: new Map([["pdf-tools", [1, 1]], ["pdf-helper", [1, 0.98]], ["weather", [0, 1]]]),
    };
    const r = detectDuplicates([snap("pdf-tools"), snap("pdf-helper"), snap("weather")], { threshold: 0.9, vectors });
    expect(r.clusters).toEqual([{ members: ["pdf-helper", "pdf-tools"], likely: true }]);
    expect(r.findings[0]!.detector).toBe("D4");
  });

  it("without an embedder only the name-Jaccard half runs, lexically", () => {
    tree.write("git-commit", { "SKILL.md": skillMd("git-commit", "Write a git commit message for staged changes") });
    tree.write("commit-git", { "SKILL.md": skillMd("commit-git", "Write git commit message for the staged changes") });
    tree.write("git-rebase", { "SKILL.md": skillMd("git-rebase", "Rebase a branch interactively") });
    const r = detectDuplicates([snap("git-commit"), snap("commit-git"), snap("git-rebase")], { threshold: 0.9, vectors: null });
    expect(r.clusters.map((c) => c.members)).toEqual([["commit-git", "git-commit"]]);
  });

  it("clusters are capped at four members", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const pairs = names.flatMap((x, i) => names.slice(i + 1).map((y) => ({ a: x, b: y, score: 0.95 })));
    const clusters = clusterPairs(pairs, 4);
    expect(clusters.every((c) => c.length <= 4)).toBe(true);
    expect(clusters[0]).toHaveLength(4);
  });
});

describe("stale detector", () => {
  const now = new Date("2026-11-23T00:00:00.000Z");
  const base = { now, staleAfterDays: 30, archiveAfterDays: 90, pruneBundled: false, trackingStartedAt: "2026-01-01T00:00:00.000Z", protectedNames: new Set<string>(), scheduleTexts: [] as string[] };

  function staleSnaps(): SkillSnapshot[] {
    for (const n of ["idle", "recent", "pinned", "bound", "scheduled", "bundled", "new-one", "older"]) tree.write(n, { "SKILL.md": skillMd(n) });
    return [
      snap("idle", { state: { lastUsedAt: "2026-07-01T00:00:00.000Z" } }),
      snap("recent", { state: { lastUsedAt: "2026-11-20T00:00:00.000Z" } }),
      snap("pinned", { state: { pinned: true } }),
      snap("bound"),
      snap("scheduled"),
      snap("bundled", { source: "bundled" }),
      snap("new-one", { state: { firstSeenAt: "2026-11-10T00:00:00.000Z" } }),
      snap("older", { state: { lastUsedAt: "2026-10-01T00:00:00.000Z" } }),
    ];
  }

  it("honours pins, agent bindings, schedule references, bundled exclusion and first-sight grace", () => {
    const r = detectStale(staleSnaps(), { ...base, protectedNames: new Set(["bound"]), scheduleTexts: ["Every morning run /scheduled and report"] });
    expect(r.archive.map((c) => c.name)).toEqual(["idle"]);
    expect(r.markStale.sort()).toEqual(["idle", "older"]);
  });

  it("nothing is judged before tracking start plus staleAfterDays", () => {
    const r = detectStale(staleSnaps(), { ...base, trackingStartedAt: "2026-11-01T00:00:00.000Z" });
    expect(r.archive).toEqual([]);
    expect(r.markStale).toEqual([]);
    expect(detectStale(staleSnaps(), { ...base, trackingStartedAt: null }).findings).toEqual([]);
  });

  it("pruneBundled lets unused bundled skills be proposed", () => {
    const r = detectStale(staleSnaps(), { ...base, pruneBundled: true });
    // No bindings or schedules in this case, so "bound" and "scheduled" are candidates too; "pinned" never is.
    expect(r.archive.map((c) => c.name).sort()).toEqual(["bound", "bundled", "idle", "scheduled"]);
  });

  it("mentionsSkill matches whole words and /name only", () => {
    expect(mentionsSkill("use /weather now", "weather")).toBe(true);
    expect(mentionsSkill("the weather skill", "weather")).toBe(true);
    expect(mentionsSkill("weatherman", "weather")).toBe(false);
    expect(mentionsSkill("my-weather-2", "weather")).toBe(false);
  });
});

describe("drift detector", () => {
  it("flags content that differs from the approved hash; bundled only with an override", () => {
    tree.write("notes", { "SKILL.md": skillMd("notes", "edited") });
    tree.write("fresh", { "SKILL.md": skillMd("fresh") });
    tree.write("weather", { "SKILL.md": skillMd("weather", "patched") });
    tree.write("clean", { "SKILL.md": skillMd("clean") });
    const r = detectDrift([
      snap("notes", { state: { approvedHash: sha256Text(skillMd("notes")) } }),
      snap("fresh", { state: { approvedHash: null } }),
      snap("weather", { source: "bundled", state: { approvedHash: sha256Text(skillMd("weather")) } }),
      snap("clean", { state: { approvedHash: sha256Text(skillMd("clean")) } }),
    ], { directWrites: [] });
    expect(r.propose.map((d) => d.name).sort()).toEqual(["fresh", "notes"]);
    expect(r.propose.find((d) => d.name === "fresh")!.approvedHash).toBeNull();

    const overridden = detectDrift([snap("weather", { source: "bundled", state: { approvedHash: sha256Text(skillMd("weather")), override: true } })], { directWrites: [] });
    expect(overridden.propose.map((d) => d.name)).toEqual(["weather"]);
  });

  it("auto-adopts a drift within two minutes of an owner-turn direct write, not later", () => {
    const d = tree.write("notes", { "SKILL.md": skillMd("notes", "edited") });
    const mtime = new Date("2026-11-23T10:00:00.000Z");
    utimesSync(join(d, "SKILL.md"), mtime, mtime);
    const s = snap("notes", { state: { approvedHash: sha256Text(skillMd("notes")) } });
    const near = detectDrift([s], { directWrites: [{ skill: "notes", atMs: mtime.getTime() + 60_000 }] });
    expect(near.autoAdopt.map((x) => x.name)).toEqual(["notes"]);
    expect(near.propose).toEqual([]);
    const far = detectDrift([s], { directWrites: [{ skill: "notes", atMs: mtime.getTime() + 10 * 60_000 }, { skill: "other", atMs: mtime.getTime() }] });
    expect(far.propose.map((x) => x.name)).toEqual(["notes"]);
  });
});
