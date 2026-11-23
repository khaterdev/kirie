import { describe, it, expect } from "vitest";
import { parseShell, countHiddenShellChars, SHELL_MAX_CERTAIN_LENGTH, type ParsedShell } from "./shell-parse.js";

const HOME = "/Users/tester";
const CWD = "/Users/tester/.kirie";

function parse(cmd: string): ParsedShell {
  return parseShell(cmd, { cwd: CWD, home: HOME });
}

function cmds(p: ParsedShell): string[] {
  return p.segments.map((s) => s.cmd).filter(Boolean);
}

function codes(p: ParsedShell): string[] {
  return p.uncertain.map((u) => u.code);
}

function argvOf(p: ParsedShell, cmd: string): string[] | undefined {
  return p.segments.find((s) => s.cmd === cmd)?.argv;
}

interface Case {
  cmd: string;
  /** Commands that must appear (any depth) */
  has?: string[];
  /** Commands that must not appear */
  not?: string[];
  /** Uncertainty codes that must appear */
  uncertain?: string[];
  /** No uncertainty at all */
  certain?: boolean;
  /** argv of a command */
  argv?: [string, string[]];
}

const CASES: Case[] = [
  // Plain commands and quoting
  { cmd: "ls", has: ["ls"], certain: true },
  { cmd: "ls -la /tmp", argv: ["ls", ["ls", "-la", "/tmp"]], certain: true },
  { cmd: "echo 'hello world'", argv: ["echo", ["echo", "hello world"]], certain: true },
  { cmd: "echo \"hello world\"", argv: ["echo", ["echo", "hello world"]], certain: true },
  { cmd: "echo hello\\ world", argv: ["echo", ["echo", "hello world"]], certain: true },
  { cmd: "echo 'a'\"b\"c", argv: ["echo", ["echo", "abc"]], certain: true },
  { cmd: "echo \"it's\"", argv: ["echo", ["echo", "it's"]], certain: true },
  { cmd: "echo 'say \"hi\"'", argv: ["echo", ["echo", "say \"hi\""]], certain: true },
  { cmd: "echo \"a\\\"b\"", argv: ["echo", ["echo", "a\"b"]], certain: true },
  { cmd: "echo \"a\\nb\"", argv: ["echo", ["echo", "a\\nb"]], certain: true },
  { cmd: "echo $'a\\tb'", argv: ["echo", ["echo", "a\tb"]], certain: true },
  { cmd: "echo a # rm -rf /", has: ["echo"], not: ["rm"], certain: true },
  { cmd: "echo \"# not a comment\" ; ls", has: ["echo", "ls"], certain: true },
  { cmd: "echo a\\\nb", argv: ["echo", ["echo", "ab"]] },
  { cmd: "git commit -m 'rm -rf / is bad'", has: ["git"], not: ["rm"], certain: true },
  { cmd: "grep -r 'mkfs' .", has: ["grep"], not: ["mkfs"], certain: true },

  // Separators
  { cmd: "a; b", has: ["a", "b"] },
  { cmd: "a && b", has: ["a", "b"] },
  { cmd: "a || b", has: ["a", "b"] },
  { cmd: "a | b", has: ["a", "b"] },
  { cmd: "a |& b", has: ["a", "b"] },
  { cmd: "a & b", has: ["a", "b"] },
  { cmd: "a\nb", has: ["a", "b"] },
  { cmd: "a;b&&c||d|e&f", has: ["a", "b", "c", "d", "e", "f"] },
  { cmd: "git status && rm -rf ~", has: ["git", "rm"], argv: ["rm", ["rm", "-rf", "~"]] },
  { cmd: "true;rm -rf /", has: ["true", "rm"] },

  // Subshells and groups
  { cmd: "(cd /tmp && ls)", has: ["cd", "ls"] },
  { cmd: "{ rm -rf x; }", has: ["rm"] },
  { cmd: "( ( rm -rf x ) )", has: ["rm"] },
  { cmd: "if true; then rm -rf x; fi", has: ["true", "rm"] },
  { cmd: "while true; do rm -rf x; done", has: ["true", "rm"] },
  { cmd: "for f in a b; do rm \"$f\"; done", has: ["rm"] },
  { cmd: "! rm -rf x", has: ["rm"] },
  { cmd: "f() { rm -rf /; }; f", has: ["rm", "f"] },
  { cmd: "function g { rm -rf /; }", has: ["rm"] },

  // Substitutions, three deep
  { cmd: "echo $(rm -rf x)", has: ["echo", "rm"] },
  { cmd: "echo `rm -rf x`", has: ["echo", "rm"] },
  { cmd: "echo \"$(rm -rf x)\"", has: ["echo", "rm"] },
  { cmd: "echo $(echo $(echo $(rm -rf x)))", has: ["rm"] },
  { cmd: "echo `echo \\`rm -rf x\\``", has: ["rm"] },
  { cmd: "echo $(echo \"$(echo `rm -rf x`)\")", has: ["rm"] },
  { cmd: "X=$(rm -rf /) true", has: ["true", "rm"] },
  { cmd: "X=`rm -rf /`", has: ["rm"] },
  { cmd: "echo ${X:-$(rm -rf /)}", has: ["rm"] },
  { cmd: "echo $((1 + $(rm -rf x)))", has: ["rm"] },
  { cmd: "diff <(rm -rf a) <(ls)", has: ["diff", "rm", "ls"] },
  { cmd: "tee >(rm -rf a)", has: ["tee", "rm"] },
  { cmd: "cat < <(rm -rf a)", has: ["cat", "rm"] },
  { cmd: "echo $((2+3))", has: ["echo"], not: ["2+3"], certain: true },

  // Shell -c and eval
  { cmd: "bash -c 'rm -rf x'", has: ["bash", "rm"] },
  { cmd: "bash -c \"rm -rf x\"", has: ["rm"] },
  { cmd: "sh -c 'echo a; rm -rf x'", has: ["echo", "rm"] },
  { cmd: "zsh -c 'rm -rf x'", has: ["rm"] },
  { cmd: "dash -c 'rm -rf x'", has: ["rm"] },
  { cmd: "bash -lc 'rm -rf x'", has: ["rm"] },
  { cmd: "bash -x -c 'rm -rf x'", has: ["rm"] },
  { cmd: "bash -o pipefail -c 'rm -rf x'", has: ["rm"] },
  { cmd: "bash -c 'bash -c \"rm -rf x\"'", has: ["rm"] },
  { cmd: "sh -c \"$CMD\"", uncertain: ["shell-c-dynamic"] },
  { cmd: "sh -c \"rm -rf $DIR\"", has: ["rm"], uncertain: ["shell-c-dynamic"] },
  { cmd: "eval 'rm -rf x'", has: ["eval", "rm"] },
  { cmd: "eval \"$X\"", uncertain: ["eval-dynamic"] },
  { cmd: "eval rm -rf x", has: ["rm"] },
  { cmd: "su -c 'rm -rf x'", has: ["rm"] },
  { cmd: "env -S 'rm -rf x'", has: ["rm"] },
  { cmd: "flock /tmp/l -c 'rm -rf x'", has: ["rm"] },

  // Wrappers
  { cmd: "sudo rm -rf x", has: ["rm"], not: ["sudo"] },
  { cmd: "sudo -u root rm -rf x", has: ["rm"] },
  { cmd: "sudo -E -H rm -rf x", has: ["rm"] },
  { cmd: "sudo env X=1 rm -rf /", has: ["rm"], argv: ["rm", ["rm", "-rf", "/"]] },
  { cmd: "doas rm -rf x", has: ["rm"] },
  { cmd: "env rm -rf x", has: ["rm"] },
  { cmd: "env -i PATH=/bin rm x", has: ["rm"], uncertain: ["env-override"] },
  { cmd: "command rm -rf x", has: ["rm"] },
  { cmd: "builtin cd /tmp", has: ["cd"] },
  { cmd: "exec rm -rf x", has: ["rm"] },
  { cmd: "nohup rm -rf x &", has: ["rm"] },
  { cmd: "time rm -rf x", has: ["rm"] },
  { cmd: "nice -n 10 rm -rf x", has: ["rm"] },
  { cmd: "timeout 5 rm -rf x", has: ["rm"] },
  { cmd: "timeout -s KILL 5 rm -rf x", has: ["rm"] },
  { cmd: "stdbuf -oL rm -rf x", has: ["rm"] },
  { cmd: "caffeinate -i rm -rf x", has: ["rm"] },
  { cmd: "busybox rm -rf x", has: ["rm"] },
  { cmd: "sudo timeout 5 nice env rm -rf x", has: ["rm"] },
  { cmd: "FOO=1 BAR=2 rm -rf x", has: ["rm"] },
  { cmd: "command -v rm", has: ["command"], not: ["rm"] },
  { cmd: "PATH=/tmp/evil:$PATH ls", has: ["ls"], uncertain: ["env-override"] },
  { cmd: "LD_PRELOAD=/tmp/x.so ls", uncertain: ["env-override"] },
  { cmd: "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls", uncertain: ["env-override"] },
  { cmd: "export PATH=/tmp:$PATH", uncertain: ["env-override"] },

  // Command name obfuscation
  { cmd: "\\rm -rf x", has: ["rm"] },
  { cmd: "/bin/rm -rf x", has: ["rm"] },
  { cmd: "/usr/bin/env rm -rf x", has: ["rm"] },
  { cmd: "\"rm\" -rf x", has: ["rm"] },
  { cmd: "'rm' -rf x", has: ["rm"] },
  { cmd: "r\"m\" -rf x", has: ["rm"] },
  { cmd: "r''m -rf x", has: ["rm"] },
  { cmd: "r\\m -rf x", has: ["rm"] },
  { cmd: "RM -rf x", has: ["rm"] },
  { cmd: "grm -rf x", has: ["rm"] },
  { cmd: "$'\\x72\\x6d' -rf x", has: ["rm"] },
  { cmd: "$'\\162\\155' -rf x", has: ["rm"] },
  { cmd: "$'\\u0072m' -rf x", has: ["rm"] },
  { cmd: "{rm,-rf,x}", has: ["rm"], uncertain: ["brace-expansion"] },
  { cmd: "$CMD -rf x", uncertain: ["dynamic-command"] },
  { cmd: "${CMD} -rf x", uncertain: ["dynamic-command"] },
  { cmd: "$(echo rm) -rf x", uncertain: ["dynamic-command"] },
  { cmd: "`echo rm` -rf x", uncertain: ["dynamic-command"] },
  { cmd: "/bin/r? -rf x", uncertain: ["dynamic-command"] },
  { cmd: "/bin/r* -rf x", uncertain: ["dynamic-command"] },
  { cmd: "alias ll='rm -rf'", uncertain: ["alias"] },

  // xargs, find -exec, watch, ssh, kubectl/docker exec
  { cmd: "ls | xargs rm -rf", has: ["xargs", "rm"] },
  { cmd: "find . -print0 | xargs -0 -n 1 rm", has: ["rm"] },
  { cmd: "xargs -I{} sh -c 'rm -rf {}'", has: ["rm"] },
  { cmd: "find . -name '*.tmp' -exec rm -rf {} \\;", has: ["find", "rm"] },
  { cmd: "find . -name x -exec rm {} +", has: ["rm"] },
  { cmd: "find . -execdir rm {} ';'", has: ["rm"] },
  { cmd: "watch -n 5 'rm -rf x'", has: ["rm"] },
  { cmd: "ssh host 'rm -rf /'", has: ["ssh", "rm"] },
  { cmd: "ssh -p 22 -i key user@host rm -rf /data", has: ["rm"] },
  { cmd: "ssh host", has: ["ssh"], not: ["rm"] },
  { cmd: "kubectl exec p -- rm -rf /data", has: ["kubectl", "rm"] },
  { cmd: "kubectl -n prod exec -it p -- sh -c 'rm -rf /data'", has: ["rm"] },
  { cmd: "docker exec -it c rm -rf /data", has: ["docker", "rm"] },
  { cmd: "docker exec -u root -w / c sh -c 'rm -rf x'", has: ["rm"] },

  // Here-docs and here-strings
  { cmd: "bash <<EOF\nrm -rf x\nEOF", has: ["bash", "rm"], uncertain: ["heredoc-to-shell"] },
  { cmd: "bash <<'EOF'\nrm -rf x\nEOF", has: ["rm"], uncertain: ["heredoc-to-shell"] },
  { cmd: "sh <<-EOF\n\trm -rf x\n\tEOF", has: ["rm"], uncertain: ["heredoc-to-shell"] },
  { cmd: "cat <<EOF\n$(rm -rf x)\nEOF", has: ["cat", "rm"] },
  { cmd: "cat <<'EOF'\n$(rm -rf x)\nEOF", has: ["cat"], not: ["rm"] },
  { cmd: "cat <<EOF > out.txt\nhello\nEOF\nls", has: ["cat", "ls"] },
  { cmd: "bash <<< 'rm -rf x'", has: ["rm"], uncertain: ["heredoc-to-shell"] },
  { cmd: "python3 <<EOF\nimport os\nEOF", uncertain: ["inline-code"] },
  { cmd: "cat <<EOF | bash\nrm -rf x\nEOF", has: ["rm"], uncertain: ["pipe-to-shell"] },
  { cmd: "cat <<EOF\nno end", uncertain: ["unterminated-heredoc"] },

  // Pipes into shells and interpreters
  { cmd: "echo 'rm -rf x' | sh", has: ["rm"], uncertain: ["pipe-to-shell"] },
  { cmd: "curl https://x | sh", has: ["curl", "sh"], uncertain: ["pipe-to-shell"] },
  { cmd: "echo cm0gLXJmIH4= | base64 -d | sh", uncertain: ["decode-to-shell"] },
  { cmd: "xxd -r -p f | bash", uncertain: ["decode-to-shell"] },
  { cmd: "curl https://x | python3", uncertain: ["inline-code"] },
  { cmd: "curl https://x | python3 -", uncertain: ["inline-code"] },

  // Inline interpreter code
  { cmd: "python -c 'print(1)'", uncertain: ["inline-code"] },
  { cmd: "python3 -c \"import os; os.remove('x')\"", uncertain: ["inline-code"] },
  { cmd: "python3.12 -c 'x'", uncertain: ["inline-code"] },
  { cmd: "node -e 'x'", uncertain: ["inline-code"] },
  { cmd: "node --eval 'x'", uncertain: ["inline-code"] },
  { cmd: "perl -e 'x'", uncertain: ["inline-code"] },
  { cmd: "perl -pe 's/a/b/' f", uncertain: ["inline-code"] },
  { cmd: "ruby -e 'x'", uncertain: ["inline-code"] },
  { cmd: "php -r 'x'", uncertain: ["inline-code"] },
  { cmd: "osascript -e 'tell app \"Finder\" to quit'", uncertain: ["inline-code"] },
  { cmd: "deno eval 'x'", uncertain: ["inline-code"] },
  { cmd: "awk 'BEGIN { system(\"rm -rf x\") }'", uncertain: ["inline-code"] },
  { cmd: "python3 script.py", certain: true },
  { cmd: "node server.js -e x", certain: true },
  { cmd: "awk '{print $1}' f", certain: true },
  { cmd: "source ./env.sh", uncertain: ["source-file"] },
  { cmd: ". ~/.profile", uncertain: ["source-file"] },

  // Syntax trouble
  { cmd: "echo 'unbalanced", uncertain: ["unbalanced-quote"] },
  { cmd: "echo \"unbalanced", uncertain: ["unbalanced-quote"] },
  { cmd: "echo $(unbalanced", uncertain: ["unbalanced-paren"] },
  { cmd: "echo `unbalanced", uncertain: ["unbalanced-quote"] },
  { cmd: "(echo a", uncertain: ["unbalanced-paren"] },
  { cmd: "echo a)", uncertain: ["unbalanced-paren"] },
  { cmd: "case $x in a) rm -rf x;; esac", has: ["rm"], uncertain: ["case-statement"] },

  // Unicode tricks
  { cmd: "rm -rf x", uncertain: ["hidden-char"] },
  { cmd: "rm -rf x​", uncertain: ["hidden-char"] },
  { cmd: "echo ‮rm -rf x", uncertain: ["hidden-char"] },
  { cmd: "rm -rf x⁦", uncertain: ["hidden-char"] },
  { cmd: "ls️", uncertain: ["hidden-char"] },
  { cmd: "ls\r\nrm -rf x", has: ["rm"], uncertain: ["hidden-char"] },
  { cmd: "echo \u001b[2Jrm", uncertain: ["hidden-char"] },
  { cmd: "echo héllo wörld", certain: true },

  // Redirects
  { cmd: "echo x > /etc/hosts", has: ["echo"], certain: true },
  { cmd: "echo x >> ~/.zshrc", certain: true },
  { cmd: "ls 2>/dev/null", certain: true },
  { cmd: "ls > out 2>&1", certain: true },
  { cmd: "ls &> out", certain: true },
  { cmd: "> ~/.zshrc", certain: true },
  { cmd: "2>/dev/null rm -rf x", has: ["rm"] },
  { cmd: "cat < /etc/passwd", has: ["cat"] },
  { cmd: "echo >", uncertain: ["parse-error"] },
];

describe("parseShell table", () => {
  it("has at least 120 cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(120);
  });

  for (const c of CASES) {
    it(JSON.stringify(c.cmd), () => {
      const p = parse(c.cmd);
      for (const h of c.has ?? []) expect(cmds(p), `expected ${h}`).toContain(h);
      for (const n of c.not ?? []) expect(cmds(p), `did not expect ${n}`).not.toContain(n);
      for (const u of c.uncertain ?? []) expect(codes(p), `expected uncertainty ${u}`).toContain(u);
      if (c.certain) expect(codes(p)).toEqual([]);
      if (c.argv) expect(argvOf(p, c.argv[0])).toEqual(c.argv[1]);
    });
  }
});

describe("parseShell details", () => {
  it("records wrappers and sudo", () => {
    const p = parse("sudo -u root nice -n 5 rm -rf x");
    const rm = p.segments.find((s) => s.cmd === "rm")!;
    expect(rm.sudo).toBe(true);
    expect(rm.wrappers).toEqual(["sudo", "nice"]);
    expect(rm.fullArgv[0]).toBe("sudo");
  });

  it("tracks cd for later segments", () => {
    const p = parse("cd / && rm -rf *");
    expect(p.segments.find((s) => s.cmd === "rm")!.cwd).toBe("/");
    const q = parse("cd ~ && rm -rf *");
    expect(q.segments.find((s) => s.cmd === "rm")!.cwd).toBe(HOME);
    const r = parse("cd \"$DIR\" && rm -rf *");
    expect(r.segments.find((s) => s.cmd === "rm")!.cwd).toBeNull();
    const s = parse("cd .. && rm -rf *");
    expect(s.segments.find((x) => x.cmd === "rm")!.cwd).toBe(HOME);
  });

  it("tracks cd inside bash -c and a subshell", () => {
    expect(parse("bash -c 'cd / && rm -rf *'").segments.find((s) => s.cmd === "rm")!.cwd).toBe("/");
    expect(parse("(cd / ; rm -rf *)").segments.find((s) => s.cmd === "rm")!.cwd).toBe("/");
  });

  it("marks remote segments and gives them no cwd", () => {
    const p = parse("ssh host 'rm -rf *'");
    const rm = p.segments.find((s) => s.cmd === "rm")!;
    expect(rm.remote).toBe(true);
    expect(rm.cwd).toBeNull();
    expect(rm.via).toBe("ssh");
  });

  it("assigns pipeline groups and stages", () => {
    const p = parse("a | b | c; d");
    const [a, b, c, d] = p.segments;
    expect(a!.group).toBe(b!.group);
    expect(b!.group).toBe(c!.group);
    expect([a!.stage, b!.stage, c!.stage]).toEqual([0, 1, 2]);
    expect(d!.group).not.toBe(a!.group);
  });

  it("keeps redirect targets and here-doc bodies", () => {
    const p = parse("cat > ~/.zshrc <<EOF\nexport X=1\nEOF");
    const cat = p.segments[0]!;
    expect(cat.redirects.map((r) => r.op)).toEqual([">", "<<"]);
    expect(cat.redirects[0]!.target).toBe("~/.zshrc");
    expect(cat.stdinText).toBe("export X=1");
  });

  it("flags dynamic args for xargs and find -exec", () => {
    expect(parse("ls | xargs rm").segments.find((s) => s.cmd === "rm")!.dynamicArgs).toBe(true);
    expect(parse("find . -exec rm {} \\;").segments.find((s) => s.cmd === "rm")!.dynamicArgs).toBe(true);
  });

  it("detects fork bombs, named or not", () => {
    expect(parse(":(){ :|:& };:").forkBomb).toBe(true);
    expect(parse(":(){:|:&};:").forkBomb).toBe(true);
    expect(parse("bomb() { bomb | bomb & }; bomb").forkBomb).toBe(true);
    expect(parse("f() { echo hi; }; f | cat &").forkBomb).toBe(false);
    expect(parse("echo ':|:&'").forkBomb).toBe(false);
  });

  it("marks over-long input uncertain but still sees a command at the end", () => {
    const padding = "true; ".repeat(2000);
    const p = parse(`${padding}rm -rf /`);
    expect(codes(p)).toContain("too-long");
    expect(cmds(p)).toContain("rm");
    expect(p.segments.length).toBeGreaterThan(2000);
  });

  it("a 9000-character command is uncertain", () => {
    const p = parse(`echo ${"a".repeat(9000)}`);
    expect(codes(p)).toContain("too-long");
    expect(SHELL_MAX_CERTAIN_LENGTH).toBe(8000);
  });

  it("caps nesting depth and reports it", () => {
    let cmd = "rm -rf x";
    for (let i = 0; i < 20; i++) cmd = `echo $(${cmd})`;
    const p = parse(cmd);
    expect(codes(p)).toContain("too-deep");
  });

  it("counts hidden characters", () => {
    expect(countHiddenShellChars("abc")).toBe(0);
    expect(countHiddenShellChars("a​b‮c")).toBe(2);
    expect(countHiddenShellChars("tab\tand\nnewline")).toBe(0);
  });

  it("never throws on non-string input", () => {
    expect(parseShell(undefined as unknown as string).uncertain.map((u) => u.code)).toEqual(["parse-error"]);
  });
});

/** Deterministic pseudo-random generator so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ALPHABET = [
  "a", "b", "rm", " ", " ", "-rf", "/", "~", "'", "\"", "\\", "$", "(", ")", "{", "}", "`", ";", "&", "|", "<", ">",
  "<<", "EOF", "\n", "*", "?", "[", "]", "#", "=", "$(", "${", "<(", "​", "‮", "é", "\t", "bash -c ", "eval ",
  "sudo ", "xargs ", "-exec ", "$'\\x72'", ",", "!", "2>&1", "&&", "||",
];

describe("parseShell fuzz", () => {
  it("never throws and returns quickly on random input", { timeout: 20_000 }, () => {
    const rand = rng(42);
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(rand() * 120) + 1;
      let s = "";
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const start = performance.now();
      let result: ParsedShell | undefined;
      expect(() => { result = parse(s); }).not.toThrow();
      const elapsed = performance.now() - start;
      worst = Math.max(worst, elapsed);
      expect(Array.isArray(result!.segments)).toBe(true);
    }
    expect(worst).toBeLessThan(50);
  });

  it("random printable bytes never throw", { timeout: 20_000 }, () => {
    const rand = rng(7);
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rand() * 200);
      let s = "";
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(rand() * 0x7f) + 1);
      const start = performance.now();
      expect(() => parse(s)).not.toThrow();
      expect(performance.now() - start).toBeLessThan(50);
    }
  });
});

describe("parseShell timing on hostile input", () => {
  const cases: Array<[string, string]> = [
    ["deep quotes", "'a'".repeat(20_000)],
    ["many backslashes", "\\".repeat(50_000)],
    ["unterminated $(", "$(".repeat(5_000)],
    ["nested $( )", `${"$(".repeat(200)}x${")".repeat(200)}`],
    ["many pipes", "a|".repeat(20_000)],
    ["many semicolons", ";".repeat(50_000)],
    ["long word", "a".repeat(200_000)],
    ["many braces", "{a,b}".repeat(5_000)],
    ["heredoc flood", "cat <<E\n".repeat(2_000)],
    ["double quotes with substitutions", `"${"$(x)".repeat(10_000)}"`],
  ];
  for (const [name, input] of cases) {
    it(`${name} parses in bounded time`, { timeout: 10_000 }, () => {
      const start = performance.now();
      expect(() => parse(input)).not.toThrow();
      expect(performance.now() - start).toBeLessThan(2000);
    });
  }
});
