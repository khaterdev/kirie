/**
 * Hand-written shell analysis for the approval gate (PLAN C.9, R2 section 4
 * "Shell command analysis").
 *
 * Rules this file keeps:
 * - Tokenise the raw text first; never normalise first (R6 9 "Avoid" 7).
 * - Split into simple commands at `;`, `&&`, `||`, `|`, `|&`, `&`, newlines
 *   and subshell or group boundaries, and recurse into nested command text:
 *   `$(..)`, backticks, `<(..)`, `>(..)`, `bash -c '<literal>'`, `eval`,
 *   `xargs`, `find -exec`, `watch`, `ssh host '<cmd>'`, `kubectl exec -- ..`,
 *   `docker exec ..`, `su -c`, `env -S`, here-docs fed to a shell.
 * - Unwrap `sudo`, `env`, `command`, `nohup`, `timeout` and friends.
 * - Mark *uncertain* instead of guessing. Anything this parser cannot read
 *   with confidence is reported, never silently accepted.
 * - Never throw, linear in the input (each nesting level re-reads only its own
 *   text, and nesting is capped), no regular expression with nested
 *   quantifiers.
 */

import { basename, isAbsolute, normalize, resolve } from "node:path";
import { expandApprovalHome } from "./paths.js";

export interface ShellArg {
  /** Value after quote removal. Expansions are kept as their source text (`$HOME`, `$(..)`). */
  value: string;
  /** Contains a parameter expansion, command substitution or arithmetic. */
  expansion: boolean;
  /** Contains an unquoted `*`, `?` or `[`. */
  glob: boolean;
  /** Any part was quoted. */
  quoted: boolean;
  /** A leading `~` was quoted or escaped, so it is a literal directory name, not the home folder. */
  literalTilde?: boolean;
}

export interface ShellRedirect {
  /** `>`, `>>`, `>|`, `<`, `<>`, `<<`, `<<-`, `<<<`, `&>`, `&>>`, `>&`, `<&` */
  op: string;
  fd?: string;
  target: string;
  /** Target contains an expansion. */
  dynamic: boolean;
  /** Here-doc or here-string body. */
  body?: string;
}

export interface ShellSegment {
  /** Source text of this simple command (best effort). */
  raw: string;
  /** Words after assignments and wrappers were removed. `argv[0]` is the command as written. */
  argv: string[];
  args: ShellArg[];
  /** Normalized command name: basename of argv[0], lower case, leading backslash removed. "" when none. */
  cmd: string;
  /** argv including the wrappers (`sudo rm -rf x`), without assignments. Used for pattern matching. */
  fullArgv: string[];
  assignments: string[];
  redirects: ShellRedirect[];
  /** Unwrapped wrappers in order (`sudo`, `env`, `timeout`, ...). */
  wrappers: string[];
  /** Run with elevated privileges (sudo, doas, su -c, pkexec). */
  sudo: boolean;
  /** 0 for top level. */
  depth: number;
  /** How this text was reached: "$()", "`", "<()", ">()", "bash -c", "eval", "xargs", "find -exec", "ssh", ... */
  via?: string;
  /** Runs on another machine or in a container (ssh, kubectl exec, docker exec). */
  remote: boolean;
  /** Receives extra arguments at run time (xargs, find -exec). */
  dynamicArgs: boolean;
  /** Pipeline id (segments joined by `|` share it). */
  group: number;
  /** Position inside the pipeline. */
  stage: number;
  /** Absolute working directory after earlier `cd` commands; null when unknown. */
  cwd: string | null;
  /** Here-doc or here-string text fed to this command. */
  stdinText?: string;
  /** Index of the segment whose text contained this one. */
  parent?: number;
}

export interface ShellUncertainty {
  code: string;
  detail: string;
  /** Segment the uncertainty belongs to; absent for whole-command problems. */
  segment?: number;
  /** For `inline-code`: the code text, so the engine can apply `approvals.inlineCode`. */
  code_text?: string;
}

export interface ParsedShell {
  segments: ShellSegment[];
  uncertain: ShellUncertainty[];
  /** A fork bomb shape was found (`:(){ :|:& };:` and named variants). */
  forkBomb: boolean;
  /** Names defined as shell functions. */
  functions: string[];
}

export interface ParseShellOptions {
  /** Working directory of the call; used to track `cd`. */
  cwd?: string;
  home?: string;
}

/** Over this length a command is uncertain (still parsed, so hardline rules see all of it). */
export const SHELL_MAX_CERTAIN_LENGTH = 8000;
/** Nesting depth limit for `$(..)`, `bash -c`, `eval`, ... */
export const SHELL_MAX_DEPTH = 16;
const MAX_UNWRAP = 24;
const MAX_BRACE_EXPANSION = 64;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "yash", "posh", "rbash"]);
const INTERPRETER_CODE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  python: ["-c"], python2: ["-c"], python3: ["-c"], pypy: ["-c"], pypy3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"], nodejs: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], lua: ["-e"], luajit: ["-e"],
  rscript: ["-e"], osascript: ["-e"], bun: ["-e", "--eval", "-p", "--print"], tclsh: [], swift: ["-e"],
  pwsh: ["-c", "-command", "-encodedcommand", "-e", "-ec"], powershell: ["-c", "-command", "-encodedcommand"],
};
const INTERPRETERS_READING_STDIN = new Set([
  "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "perl", "ruby", "php", "lua", "osascript",
  "bun", "deno", "tclsh", "rscript", "irb", "pwsh",
]);
const RESERVED_PREFIX = new Set(["!", "{", "if", "then", "else", "elif", "do", "while", "until", "time", "coproc"]);
const RESERVED_SKIP = new Set(["}", "fi", "done", "esac", "]]"]);
const DANGEROUS_ENV = new Set([
  "PATH", "IFS", "BASH_ENV", "ENV", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS4", "ZDOTDIR", "NODE_OPTIONS",
  "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "NODE_PATH", "PAGER", "EDITOR", "VISUAL",
  "LESSOPEN", "LESSCLOSE", "BROWSER", "GIT_PAGER", "GIT_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH",
  "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXTERNAL_DIFF",
]);

function isDangerousEnvName(name: string): boolean {
  return DANGEROUS_ENV.has(name) || name.startsWith("LD_") || name.startsWith("DYLD_") || name.startsWith("GIT_CONFIG") ||
    name.toLowerCase().startsWith("npm_config_");
}
/** GNU coreutils installed with a `g` prefix on macOS (Homebrew). */
const G_PREFIXED = new Set(["rm", "chmod", "chown", "chgrp", "dd", "shred", "truncate", "cp", "mv", "tee", "ln", "install", "sed", "find", "xargs", "timeout", "stdbuf", "nice", "env", "rmdir", "unlink", "touch", "cat", "tar", "awk"]);

// ── Character classes ──────────────────────────────────────────────────────

function isHiddenCodePoint(cp: number): boolean {
  if (cp < 0x20) return cp !== 0x09 && cp !== 0x0a;            // C0 controls except tab and newline (CR counts)
  if (cp === 0x7f) return true;
  if (cp >= 0x80 && cp <= 0x9f) return true;                   // C1 controls
  if (cp === 0x00a0 || cp === 0x00ad || cp === 0x034f || cp === 0x061c || cp === 0x115f || cp === 0x1160) return true;
  if (cp === 0x1680 || cp === 0x180e) return true;
  if (cp >= 0x2000 && cp <= 0x200f) return true;               // odd spaces, zero-width, LRM/RLM
  if (cp >= 0x2028 && cp <= 0x202f) return true;               // line/para separators, bidi embeddings, NNBSP
  if (cp >= 0x205f && cp <= 0x206f) return true;               // MMSP, word joiner, invisible operators, bidi isolates
  if (cp === 0x3000 || cp === 0x3164 || cp === 0xfeff || cp === 0xffa0) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;               // variation selectors
  if (cp >= 0xfff9 && cp <= 0xfffb) return true;               // interlinear annotation
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;             // tag characters
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;             // variation selectors supplement
  return false;
}

/** Count of control, zero-width, bidi, odd-space and variation-selector characters. */
export function countHiddenShellChars(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (isHiddenCodePoint(ch.codePointAt(0)!)) n++;
  }
  return n;
}

/** True for characters the approval card must show as escapes. */
export function isHiddenShellChar(ch: string): boolean {
  return isHiddenCodePoint(ch.codePointAt(0) ?? 0);
}

function isOpChar(c: string | undefined): boolean {
  return c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">" || c === "\n";
}

function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t" || c === "\r";
}

function isNameStart(c: string | undefined): boolean {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_");
}

function isNameChar(c: string | undefined): boolean {
  return isNameStart(c) || (c !== undefined && c >= "0" && c <= "9");
}

// ── Tokens ─────────────────────────────────────────────────────────────────

interface Sub { text: string; kind: string }

interface Word {
  value: string;
  /** Per character of value: true when the character came from a quoted or escaped context. */
  quotedMask: boolean[];
  raw: string;
  start: number;
  end: number;
  quoted: boolean;
  expansion: boolean;
  glob: boolean;
  subs: Sub[];
}

type Token =
  | { t: "word"; w: Word }
  | { t: "op"; op: string; start: number; end: number }
  | { t: "redir"; op: string; fd?: string; target?: Word; body?: string; start: number; end: number };

interface PendingHeredoc { token: Extract<Token, { t: "redir" }>; delim: string; stripTabs: boolean; quoted: boolean }

class Scanner {
  i = 0;
  readonly tokens: Token[] = [];
  readonly problems: Array<{ code: string; detail: string }> = [];
  private pending: PendingHeredoc[] = [];

  constructor(private readonly s: string) {}

  run(): void {
    const s = this.s;
    let guard = 0;
    while (this.i < s.length) {
      if (++guard > s.length * 4 + 16) {
        this.problems.push({ code: "parse-error", detail: "scanner made no progress" });
        return;
      }
      const c = s[this.i];
      if (isBlank(c)) { this.i++; continue; }
      if (c === "\\" && s[this.i + 1] === "\n") { this.i += 2; continue; }
      if (c === "\n") {
        this.tokens.push({ t: "op", op: "\n", start: this.i, end: this.i + 1 });
        this.i++;
        this.readHeredocBodies();
        continue;
      }
      if (c === "#") {
        while (this.i < s.length && s[this.i] !== "\n") this.i++;
        continue;
      }
      if (c === "(" && s[this.i + 1] === "(") {
        // Arithmetic command (( .. )): a single word, never a here-doc or a command list.
        const end = findArithEnd(s, this.i + 2);
        if (end !== -1) {
          const start = this.i;
          const inner = s.slice(this.i + 2, end);
          const subs = inner.includes("$(") || inner.includes("`") ? this.collectSubstitutions(inner) : [];
          this.i = end + 2;
          const value = s.slice(start, this.i);
          this.tokens.push({ t: "word", w: { value, quotedMask: Array.from({ length: value.length }, () => true), raw: value, start, end: this.i, quoted: true, expansion: false, glob: false, subs } });
          continue;
        }
      }
      if (c === "{") {
        // Named file descriptor redirect: {fd}>file, {fd}<&-
        let j = this.i + 1;
        while (j < s.length && isNameChar(s[j])) j++;
        if (j > this.i + 1 && s[j] === "}" && (s[j + 1] === "<" || s[j + 1] === ">") && isNameStart(s[this.i + 1])) {
          const fd = s.slice(this.i, j + 1);
          this.i = j + 1;
          this.readRedirect(fd);
          continue;
        }
      }
      if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") { this.readOperator(); continue; }
      if (c === "<" || c === ">") {
        if (s[this.i + 1] === "(") { this.tokens.push({ t: "word", w: this.readWord() }); continue; }
        this.readRedirect(undefined);
        continue;
      }
      if (c !== undefined && c >= "0" && c <= "9") {
        let j = this.i;
        while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
        if ((s[j] === "<" || s[j] === ">") && s[j + 1] !== "(") {
          const fd = s.slice(this.i, j);
          this.i = j;
          this.readRedirect(fd);
          continue;
        }
      }
      this.tokens.push({ t: "word", w: this.readWord() });
    }
    if (this.pending.length > 0) {
      this.problems.push({ code: "unterminated-heredoc", detail: "here-document without its body" });
      this.pending = [];
    }
  }

  private readOperator(): void {
    const s = this.s;
    const start = this.i;
    const c = s[this.i]!;
    const n = s[this.i + 1];
    let op: string = c;
    if (c === ";" && n === ";") op = s[this.i + 2] === "&" ? ";;&" : ";;";
    else if (c === ";" && n === "&") op = ";&";
    else if (c === "&" && n === "&") op = "&&";
    else if (c === "&" && n === ">") { this.readRedirect(undefined); return; }
    else if (c === "|" && n === "|") op = "||";
    else if (c === "|" && n === "&") op = "|&";
    this.i += op.length;
    this.tokens.push({ t: "op", op, start, end: this.i });
  }

  private readRedirect(fd: string | undefined): void {
    const s = this.s;
    const start = this.i;
    const ops = ["&>>", "<<<", "<<-", "&>", ">>", ">|", "<>", "<<", ">&", "<&", "<", ">"];
    const op = ops.find((o) => s.startsWith(o, this.i)) ?? s[this.i]!;
    this.i += op.length;
    while (isBlank(s[this.i])) this.i++;
    const token: Extract<Token, { t: "redir" }> = { t: "redir", op, start, end: this.i, ...(fd !== undefined ? { fd } : {}) };
    if (this.i >= s.length || isOpChar(s[this.i])) {
      this.problems.push({ code: "parse-error", detail: `redirect ${op} without a target` });
      this.tokens.push(token);
      return;
    }
    const target = this.readWord();
    token.target = target;
    token.end = this.i;
    this.tokens.push(token);
    if (op === "<<" || op === "<<-") {
      this.pending.push({ token, delim: target.value, stripTabs: op === "<<-", quoted: target.quoted });
    } else if (op === "<<<") {
      token.body = target.value;
    }
  }

  private readHeredocBodies(): void {
    const s = this.s;
    for (const h of this.pending) {
      const lines: string[] = [];
      let found = false;
      while (this.i < s.length) {
        let nl = s.indexOf("\n", this.i);
        if (nl === -1) nl = s.length;
        let line = s.slice(this.i, nl);
        this.i = Math.min(nl + 1, s.length);
        if (h.stripTabs) line = line.replace(/^\t+/, "");
        if (line === h.delim) { found = true; break; }
        lines.push(line);
      }
      if (!found) this.problems.push({ code: "unterminated-heredoc", detail: `here-document "${h.delim}" has no end line` });
      h.token.body = lines.join("\n");
      if (!h.quoted) {
        // Substitutions in an unquoted here-doc body run when the command runs.
        const subs = this.collectSubstitutions(h.token.body);
        if (subs.length > 0) {
          h.token.target = { ...(h.token.target as Word), subs: [...(h.token.target as Word).subs, ...subs], expansion: true };
        }
      }
    }
    this.pending = [];
  }

  /** Command substitutions inside text that is otherwise literal (here-doc bodies). */
  collectSubstitutions(text: string): Sub[] {
    const out: Sub[] = [];
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
        const end = findParenEnd(text, i + 2);
        if (end === -1) { this.problems.push({ code: "unbalanced-paren", detail: "unterminated $(" }); return out; }
        out.push({ text: text.slice(i + 2, end), kind: "$()" });
        i = end + 1;
        continue;
      }
      if (c === "`") {
        const r = readBacktick(text, i + 1);
        if (r.end === -1) { this.problems.push({ code: "unbalanced-quote", detail: "unterminated backtick" }); return out; }
        out.push({ text: r.text, kind: "`" });
        i = r.end + 1;
        continue;
      }
      i++;
    }
    return out;
  }

  readWord(): Word {
    const s = this.s;
    const start = this.i;
    let value = "";
    const mask: boolean[] = [];
    let quoted = false;
    let expansion = false;
    let glob = false;
    const subs: Sub[] = [];
    const push = (text: string, q: boolean): void => {
      value += text;
      for (let k = 0; k < text.length; k++) mask.push(q);
    };

    // Process substitution at the start of a word: <( .. ) and >( .. )
    if ((s[this.i] === "<" || s[this.i] === ">") && s[this.i + 1] === "(") {
      const kind = `${s[this.i]}()`;
      const end = findParenEnd(s, this.i + 2);
      if (end === -1) {
        this.problems.push({ code: "unbalanced-paren", detail: `unterminated ${kind}` });
        this.i = s.length;
      } else {
        subs.push({ text: s.slice(this.i + 2, end), kind });
        this.i = end + 1;
      }
      const text = s.slice(start, this.i);
      push(text, true);
      return { value, quotedMask: mask, raw: text, start, end: this.i, quoted: true, expansion: true, glob: false, subs };
    }

    while (this.i < s.length) {
      const c = s[this.i]!;
      if (isBlank(c) || c === "\n") break;
      if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")" || c === "<" || c === ">") break;
      if (c === "\\") {
        const n = s[this.i + 1];
        if (n === undefined) { this.i++; break; }
        if (n === "\n") { this.i += 2; continue; }
        push(n, true);
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        quoted = true;
        if (end === -1) {
          this.problems.push({ code: "unbalanced-quote", detail: "unterminated single quote" });
          push(s.slice(this.i + 1), true);
          this.i = s.length;
          break;
        }
        push(s.slice(this.i + 1, end), true);
        this.i = end + 1;
        continue;
      }
      if (c === "$" && s[this.i + 1] === "'") {
        const r = readAnsiC(s, this.i + 2);
        quoted = true;
        if (r.end === -1) {
          this.problems.push({ code: "unbalanced-quote", detail: "unterminated $'...'" });
          push(r.value, true);
          this.i = s.length;
          break;
        }
        push(r.value, true);
        this.i = r.end + 1;
        continue;
      }
      if (c === "\"" || (c === "$" && s[this.i + 1] === "\"")) {
        this.i += c === "$" ? 2 : 1;
        quoted = true;
        const r = this.readDoubleQuoted(subs);
        if (r.expansion) expansion = true;
        push(r.value, true);
        if (!r.closed) {
          this.problems.push({ code: "unbalanced-quote", detail: "unterminated double quote" });
          break;
        }
        continue;
      }
      if (c === "$") {
        const r = this.readDollar(subs);
        if (r) {
          expansion = true;
          push(r, false);
          continue;
        }
        push("$", false);
        this.i++;
        continue;
      }
      if (c === "`") {
        const r = readBacktick(s, this.i + 1);
        expansion = true;
        if (r.end === -1) {
          this.problems.push({ code: "unbalanced-quote", detail: "unterminated backtick" });
          push(s.slice(this.i), false);
          this.i = s.length;
          break;
        }
        subs.push({ text: r.text, kind: "`" });
        push(s.slice(this.i, r.end + 1), false);
        this.i = r.end + 1;
        continue;
      }
      if (c === "*" || c === "?" || c === "[") glob = true;
      push(c, false);
      this.i++;
    }
    return { value, quotedMask: mask, raw: s.slice(start, this.i), start, end: this.i, quoted, expansion, glob, subs };
  }

  private readDoubleQuoted(subs: Sub[]): { value: string; closed: boolean; expansion: boolean } {
    const s = this.s;
    let value = "";
    let expansion = false;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === "\"") { this.i++; return { value, closed: true, expansion }; }
      if (c === "\\") {
        const n = s[this.i + 1];
        if (n === "$" || n === "`" || n === "\"" || n === "\\") { value += n; this.i += 2; continue; }
        if (n === "\n") { this.i += 2; continue; }
        value += "\\";
        this.i++;
        continue;
      }
      if (c === "$") {
        const r = this.readDollar(subs, true);
        if (r) { expansion = true; value += r; continue; }
        value += "$";
        this.i++;
        continue;
      }
      if (c === "`") {
        const r = readBacktick(s, this.i + 1);
        expansion = true;
        if (r.end === -1) { value += s.slice(this.i); this.i = s.length; return { value, closed: false, expansion }; }
        subs.push({ text: r.text, kind: "`" });
        value += s.slice(this.i, r.end + 1);
        this.i = r.end + 1;
        continue;
      }
      value += c;
      this.i++;
    }
    return { value, closed: false, expansion };
  }

  /** Reads `$(..)`, `$((..))`, `${..}`, `$name`, `$1`, `$@`, ... Returns the source text, or null for a lone `$`. */
  private readDollar(subs: Sub[], inDouble = false): string | null {
    const s = this.s;
    const start = this.i;
    const n = s[this.i + 1];
    if (n === "[") {
      // Old-style arithmetic $[ .. ]: never a here-doc or a command.
      let depth = 0;
      let end = -1;
      for (let j = this.i + 2; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]") { if (depth === 0) { end = j; break; } depth--; }
      }
      if (end === -1) {
        this.problems.push({ code: "unbalanced-paren", detail: "unterminated $[" });
        this.i = s.length;
        return s.slice(start);
      }
      const inner = s.slice(this.i + 2, end);
      if (inner.includes("$(") || inner.includes("`")) subs.push(...this.collectSubstitutions(inner));
      this.i = end + 1;
      return s.slice(start, this.i);
    }
    if (n === "(" && s[this.i + 2] === "(") {
      const end = findArithEnd(s, this.i + 3);
      if (end === -1) {
        this.problems.push({ code: "unbalanced-paren", detail: "unterminated $((" });
        this.i = s.length;
        return s.slice(start);
      }
      const inner = s.slice(this.i + 3, end);
      if (inner.includes("$(") || inner.includes("`")) subs.push(...this.collectSubstitutions(inner));
      this.i = end + 2;
      return s.slice(start, this.i);
    }
    if (n === "(") {
      const end = findParenEnd(s, this.i + 2);
      if (end === -1) {
        this.problems.push({ code: "unbalanced-paren", detail: "unterminated $(" });
        subs.push({ text: s.slice(this.i + 2), kind: "$()" });
        this.i = s.length;
        return s.slice(start);
      }
      subs.push({ text: s.slice(this.i + 2, end), kind: "$()" });
      this.i = end + 1;
      return s.slice(start, this.i);
    }
    if (n === "{") {
      const end = findBraceEnd(s, this.i + 2, inDouble);
      if (end === -1) {
        this.problems.push({ code: "unbalanced-quote", detail: "unterminated ${" });
        this.i = s.length;
        return s.slice(start);
      }
      const inner = s.slice(this.i + 2, end);
      if (inner.includes("'") || inner.includes("\"")) {
        this.problems.push({ code: "complex-parameter", detail: "quotes inside ${...} are read differently by bash and zsh" });
      }
      if (inner.includes("$(") || inner.includes("`")) subs.push(...this.collectSubstitutions(inner));
      this.i = end + 1;
      return s.slice(start, this.i);
    }
    if (isNameStart(n)) {
      let j = this.i + 1;
      while (j < s.length && isNameChar(s[j])) j++;
      this.i = j;
      return s.slice(start, j);
    }
    if (n !== undefined && ((n >= "0" && n <= "9") || "@*#?$!-".includes(n))) {
      this.i += 2;
      return s.slice(start, this.i);
    }
    return null;
  }
}

/** Nesting limit for the matching helpers below; deeper input is treated as unbalanced (uncertain). */
const MAX_SCAN_NESTING = 200;

/** End of a `$'..'` string whose body starts at `from`, or -1. */
function ansiCEnd(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    if (s[i] === "\\") { i += 2; continue; }
    if (s[i] === "'") return i;
    i++;
  }
  return -1;
}

/** Index of the `)` matching an already-consumed `(`, quote aware. -1 when unbalanced. */
function findParenEnd(s: string, from: number, nesting = 0): number {
  if (nesting > MAX_SCAN_NESTING) return -1;
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && s[i + 1] === "'") { const e = ansiCEnd(s, i + 2); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "\"") { const e = findDoubleQuoteEnd(s, i + 1, nesting + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "`") { const r = readBacktick(s, i + 1); if (r.end === -1) return -1; i = r.end + 1; continue; }
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function findDoubleQuoteEnd(s: string, from: number, nesting = 0): number {
  if (nesting > MAX_SCAN_NESTING) return -1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "\"") return i;
    if (c === "$" && s[i + 1] === "(") { const e = findParenEnd(s, i + 2, nesting + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "$" && s[i + 1] === "{") { const e = findBraceEnd(s, i + 2, true, nesting + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "`") { const r = readBacktick(s, i + 1); if (r.end === -1) return -1; i = r.end + 1; continue; }
    i++;
  }
  return -1;
}

function findArithEnd(s: string, from: number): number {
  let depth = 0;
  for (let i = from; i < s.length - 1; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) return s[i + 1] === ")" ? i : -1;
      depth--;
    }
  }
  return -1;
}

/**
 * Index of the `}` closing a `${`. Inside double quotes a single quote is an
 * ordinary character there (bash), so it must not be skipped as quoting.
 */
function findBraceEnd(s: string, from: number, inDouble = false, nesting = 0): number {
  if (nesting > MAX_SCAN_NESTING) return -1;
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (!inDouble && c === "$" && s[i + 1] === "'") { const e = ansiCEnd(s, i + 2); if (e === -1) return -1; i = e + 1; continue; }
    if (!inDouble && c === "'") { const e = s.indexOf("'", i + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "\"") { const e = findDoubleQuoteEnd(s, i + 1, nesting + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "$" && s[i + 1] === "(") { const e = findParenEnd(s, i + 2, nesting + 1); if (e === -1) return -1; i = e + 1; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function readBacktick(s: string, from: number): { text: string; end: number } {
  let text = "";
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1];
      if (n === "`" || n === "\\" || n === "$") { text += n; i += 2; continue; }
      text += c;
      i++;
      continue;
    }
    if (c === "`") return { text, end: i };
    text += c;
    i++;
  }
  return { text, end: -1 };
}

/** Decode a `$'...'` string starting after the opening quote. */
function readAnsiC(s: string, from: number): { value: string; end: number } {
  let value = "";
  let i = from;
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", "\"": "\"", "?": "?" };
  while (i < s.length) {
    const c = s[i]!;
    if (c === "'") return { value, end: i };
    if (c !== "\\") { value += c; i++; continue; }
    const n = s[i + 1];
    if (n === undefined) { i++; break; }
    if (simple[n] !== undefined) { value += simple[n]; i += 2; continue; }
    if (n === "x") {
      let j = i + 2;
      while (j < s.length && j < i + 4 && /[0-9a-fA-F]/.test(s[j]!)) j++;
      value += j > i + 2 ? String.fromCharCode(parseInt(s.slice(i + 2, j), 16)) : "\\x";
      i = j;
      continue;
    }
    if (n === "u" || n === "U") {
      const max = n === "u" ? 4 : 8;
      let j = i + 2;
      while (j < s.length && j < i + 2 + max && /[0-9a-fA-F]/.test(s[j]!)) j++;
      const cp = j > i + 2 ? parseInt(s.slice(i + 2, j), 16) : NaN;
      value += Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : `\\${n}`;
      i = j;
      continue;
    }
    if (n >= "0" && n <= "7") {
      let j = i + 1;
      while (j < s.length && j < i + 4 && s[j]! >= "0" && s[j]! <= "7") j++;
      value += String.fromCharCode(parseInt(s.slice(i + 1, j), 8) & 0xff);
      i = j;
      continue;
    }
    if (n === "c" && s[i + 2] !== undefined) {
      value += String.fromCharCode(s.charCodeAt(i + 2) & 0x1f);
      i += 3;
      continue;
    }
    value += `\\${n}`;
    i += 2;
  }
  return { value, end: -1 };
}

// ── Brace expansion ───────────────────────────────────────────────────────

/** Expand unquoted `{a,b,c}` lists (one level, nested lists are reported). Returns null when there is none. */
function braceExpand(w: Word, groups = 0): { values: string[]; nested: boolean } | null {
  const v = w.value;
  const m = w.quotedMask;
  if (groups > 8) return { values: [v], nested: true };
  let open = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "{" && !m[i]) { open = i; break; }
  }
  if (open === -1) return null;
  let depth = 0;
  let close = -1;
  const commas: number[] = [];
  let nested = false;
  for (let i = open; i < v.length; i++) {
    if (m[i]) continue;
    if (v[i] === "{") { depth++; if (depth > 1) nested = true; }
    else if (v[i] === "}") { depth--; if (depth === 0) { close = i; break; } }
    else if (v[i] === "," && depth === 1) commas.push(i);
  }
  if (close === -1 || commas.length === 0) return null;
  if (nested) return { values: [v], nested: true };
  const prefix = v.slice(0, open);
  const suffix = v.slice(close + 1);
  const parts: string[] = [];
  let last = open + 1;
  for (const c of [...commas, close]) {
    parts.push(v.slice(last, c));
    last = c + 1;
  }
  const values: string[] = [];
  const suffixWord: Word = { ...w, value: suffix, quotedMask: m.slice(close + 1) };
  const suffixExp = braceExpand(suffixWord, groups + 1);
  const suffixes = suffixExp && !suffixExp.nested ? suffixExp.values : [suffix];
  for (const p of parts) {
    for (const sfx of suffixes) {
      if (values.length >= MAX_BRACE_EXPANSION) return { values, nested: false };
      values.push(prefix + p + sfx);
    }
  }
  return { values, nested: false };
}

/** `-I R`, `-IR`, `-i[R]`, `--replace[=R]`: the replacement string of xargs, or null. */
function xargsReplaceString(opts: string[]): string | null {
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i]!;
    if (o === "-I" || o === "-J") return opts[i + 1] ?? null;
    if (o.startsWith("-I") || o.startsWith("-J")) return o.slice(2);
    if (o === "-i" || o === "--replace") return "{}";
    if (o.startsWith("-i")) return o.slice(2);
    if (o.startsWith("--replace=")) return o.slice(10);
  }
  return null;
}

const VAR_REF = /^(?:\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\})/;

/** Replace a leading `$NAME` / `${NAME}` whose literal value is known from an earlier assignment. */
function substituteKnownVar(w: Word, vars: ReadonlyMap<string, string>): Word {
  if (!w.expansion || vars.size === 0 || w.subs.length > 0) return w;
  const m = VAR_REF.exec(w.value);
  if (!m) return w;
  const name = m[1] ?? m[2]!;
  const known = vars.get(name);
  if (known === undefined) return w;
  const rest = w.value.slice(m[0].length);
  if (rest.includes("$") || rest.includes("`")) return w;
  const value = known + rest;
  return { ...w, value, quotedMask: Array.from({ length: value.length }, () => false), expansion: false };
}

/** Record `NAME=literal` assignments (bare, or through export/declare/local/readonly). */
function trackVars(seg: ShellSegment, vars: Map<string, string>): void {
  const record = (a: string): void => {
    const eq = a.indexOf("=");
    if (eq <= 0) return;
    const name = a.slice(0, eq).replace(/\+$/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    const value = a.slice(eq + 1);
    if (value.includes("$") || value.includes("`")) vars.delete(name);
    else vars.set(name, value);
  };
  if (seg.argv.length === 0 && seg.wrappers.length === 0) {
    for (const a of seg.assignments) record(a);
    return;
  }
  if (["export", "declare", "typeset", "local", "readonly"].includes(seg.cmd)) {
    for (const a of seg.argv.slice(1)) if (!a.startsWith("-")) record(a);
  }
  if (seg.cmd === "unset") for (const a of seg.argv.slice(1)) vars.delete(a);
}

/** Pipeline stages that decode their input (base64 -d, xxd -r, openssl -d, rev, tr, gunzip). */
function isDecoderSegment(seg: ShellSegment): boolean {
  const a = seg.argv;
  switch (seg.cmd) {
    case "base64": return a.some((x) => x === "-d" || x === "-D" || x === "--decode" || (/^-[a-zA-Z]+$/.test(x) && (x.includes("d") || x.includes("D"))));
    case "xxd": return a.some((x) => x === "-r" || x.startsWith("-r"));
    case "openssl": return a.includes("-d") || a.includes("-base64") && a.includes("-d");
    case "uudecode": case "rev": case "tr": case "gunzip": case "zcat": case "bzcat": case "xzcat": case "zstdcat": return true;
    case "gzip": case "bzip2": case "xz": case "zstd": return a.includes("-d") || a.includes("--decompress");
    default: return false;
  }
}

/** The literal text a pipeline stage prints (echo/printf words, or a here-doc fed to cat), when it is fully literal. */
function literalOutputOf(seg: ShellSegment | undefined): string | null {
  if (!seg) return null;
  if ((seg.cmd === "echo" || seg.cmd === "printf") && seg.args.slice(1).every((x) => !x.expansion)) {
    const words = seg.argv.slice(1).filter((x, i) => !(i === 0 && seg.cmd === "echo" && /^-[neE]+$/.test(x)));
    return words.join(" ") || null;
  }
  if (seg.cmd === "cat" && seg.argv.length === 1 && seg.stdinText !== undefined) return seg.stdinText;
  return null;
}

// ── Segments ──────────────────────────────────────────────────────────────

/** What earlier stages of one pipeline produced (kept so lookups stay O(1)). */
interface GroupInfo {
  decoder: boolean;
  /** First segment seen at each stage. */
  byStage: Map<number, ShellSegment>;
}

interface BuildState {
  groups: Map<number, GroupInfo>;
  segments: ShellSegment[];
  uncertain: ShellUncertainty[];
  functions: Set<string>;
  group: number;
  home: string;
  /** Unique pipeline ids across nesting levels. */
  nextGroup: () => number;
}

interface Meta {
  depth: number;
  via?: string;
  remote: boolean;
  sudo: boolean;
  parent?: number;
  dynamicArgs?: boolean;
}

function wordToArg(w: Word, value = w.value): ShellArg {
  const literalTilde = value.startsWith("~") && value === w.value && w.quotedMask[0] === true;
  return { value, expansion: w.expansion, glob: w.glob, quoted: w.quoted, ...(literalTilde ? { literalTilde: true } : {}) };
}

function isAssignment(w: Word): boolean {
  const v = w.value;
  if (!isNameStart(v[0]) || w.quotedMask[0]) return false;
  let i = 1;
  while (i < v.length && isNameChar(v[i])) i++;
  if (v[i] === "[") {
    const close = v.indexOf("]", i);
    if (close === -1) return false;
    i = close + 1;
  }
  if (v[i] === "+") i++;
  return v[i] === "=" && !w.quotedMask[i];
}

function normalizeCmd(word: string): string {
  let w = word;
  while (w.startsWith("\\")) w = w.slice(1);
  // zsh: =cmd expands to the full path of cmd.
  if (w.startsWith("=") && w.length > 1) w = w.slice(1);
  let b = basename(w).toLowerCase();
  if (b.length > 1 && b.startsWith("g") && G_PREFIXED.has(b.slice(1))) b = b.slice(1);
  if (/^python[0-9.]*$/.test(b)) return b.startsWith("python3") ? "python3" : b === "python2" || b.startsWith("python2.") ? "python2" : "python";
  if (/^pypy[0-9.]*$/.test(b)) return "pypy";
  if (/^perl[0-9.]+$/.test(b)) return "perl";
  if (/^ruby[0-9.]+$/.test(b)) return "ruby";
  if (/^php[0-9.]+$/.test(b)) return "php";
  if (/^node[0-9]+$/.test(b)) return "node";
  if (/^lua[0-9.]+$/.test(b)) return "lua";
  return b;
}

/** Options that take a separate value, per wrapper. */
const WRAPPER_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t", "-D", "-R", "-T", "-a", "--user", "--group", "--prompt", "--chdir", "--host", "--close-from", "--role", "--type", "--command-timeout", "--other-user"]),
  doas: new Set(["-u", "-C"]),
  pkexec: new Set(["--user"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-P"]),
  exec: new Set(["-a"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "--class", "--classdata"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  caffeinate: new Set(["-t", "-w"]),
  flock: new Set(["-w", "--timeout", "-E", "--conflict-exit-code"]),
  arch: new Set(["-arch"]),
  chrt: new Set([]),
  taskset: new Set([]),
  watch: new Set(["-n", "--interval", "-d", "-q"]),
  xargs: new Set(["-I", "-J", "-R", "-n", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file", "--process-slot-var"]),
  ssh: new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w", "-B"]),
  dockerExec: new Set(["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys"]),
  kubectl: new Set(["-n", "--namespace", "--context", "--kubeconfig", "--cluster", "--user", "-s", "--server", "--token", "--as", "--as-group", "-c", "--container", "-f", "--filename", "--pod-running-timeout"]),
  shell: new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]),
};

/** Index of the first word after the options of a wrapper; value-taking options consume the next word. */
function skipOptions(words: Word[], from: number, valueOpts: ReadonlySet<string>, opts: { stopAtDoubleDash?: boolean; attachedLetters?: string } = {}): number {
  let i = from;
  while (i < words.length) {
    const v = words[i]!.value;
    if (v === "--") return opts.stopAtDoubleDash === false ? i : i + 1;
    if (!v.startsWith("-") || v === "-") return i;
    if (v.startsWith("--")) {
      const eq = v.indexOf("=");
      const name = eq === -1 ? v : v.slice(0, eq);
      i += eq === -1 && valueOpts.has(name) ? 2 : 1;
      continue;
    }
    // Short option cluster: a value-taking letter consumes the rest of the cluster or the next word.
    let consumed = false;
    for (let k = 1; k < v.length; k++) {
      const flag = `-${v[k]}`;
      if (valueOpts.has(flag)) {
        consumed = k === v.length - 1;
        break;
      }
    }
    if (valueOpts.has(v)) consumed = true;
    i += consumed ? 2 : 1;
  }
  return i;
}

/** The parser proper. */
class ShellParser {
  constructor(private readonly st: BuildState) {}

  parseText(text: string, meta: Meta, cwd: string | null): void {
    const st = this.st;
    if (meta.depth > SHELL_MAX_DEPTH) {
      st.uncertain.push({ code: "too-deep", detail: `nesting deeper than ${SHELL_MAX_DEPTH} levels`, ...(meta.parent !== undefined ? { segment: meta.parent } : {}) });
      return;
    }
    const scanner = new Scanner(text);
    try {
      scanner.run();
    } catch (err) {
      st.uncertain.push({ code: "parse-error", detail: err instanceof Error ? err.message : String(err) });
    }
    for (const p of scanner.problems) {
      st.uncertain.push({ ...p, ...(meta.parent !== undefined ? { segment: meta.parent } : {}) });
    }
    this.buildSegments(text, scanner.tokens, meta, cwd);
  }

  private buildSegments(text: string, tokens: Token[], meta: Meta, startCwd: string | null): void {
    const st = this.st;
    let words: Word[] = [];
    let redirects: Extract<Token, { t: "redir" }>[] = [];
    let segStart = -1;
    let segEnd = -1;
    let group = st.nextGroup();
    let stage = 0;
    let parenDepth = 0;
    let inCase = false;
    let cwd = startCwd;
    /** Shell variables assigned earlier in this text with a literal value (`X=/tmp; rm -rf $X`). */
    const vars = new Map<string, string>();

    const flush = (): void => {
      if (words.length === 0 && redirects.length === 0) return;
      const raw = segStart >= 0 ? text.slice(segStart, segEnd) : "";
      const idx = this.emitSegment(raw, words, redirects, meta, group, stage, cwd, vars);
      if (idx !== -1) trackVars(st.segments[idx]!, vars);
      if (idx !== -1 && !meta.remote) cwd = this.trackCd(st.segments[idx]!, cwd);
      words = [];
      redirects = [];
      segStart = -1;
    };

    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k]!;
      if (tok.t === "word") {
        // Function definition: NAME ( )
        const next = tokens[k + 1];
        const after = tokens[k + 2];
        if (words.length === 0 && next?.t === "op" && next.op === "(" && after?.t === "op" && after.op === ")") {
          st.functions.add(tok.w.value);
          k += 2;
          continue;
        }
        if (words.length === 0 && tok.w.value === "case" && !tok.w.quoted) {
          inCase = true;
          st.uncertain.push({ code: "case-statement", detail: "case statements are not analysed in full" });
        }
        if (words.length === 0 && tok.w.value === "esac" && !tok.w.quoted) inCase = false;
        if (segStart < 0) segStart = tok.w.start;
        segEnd = tok.w.end;
        words.push(tok.w);
        continue;
      }
      if (tok.t === "redir") {
        if (segStart < 0) segStart = tok.start;
        segEnd = tok.end;
        redirects.push(tok);
        continue;
      }
      switch (tok.op) {
        case "|":
        case "|&":
          flush();
          stage++;
          break;
        case "(":
          flush();
          parenDepth++;
          break;
        case ")":
          flush();
          if (inCase) break;
          parenDepth--;
          if (parenDepth < 0) {
            st.uncertain.push({ code: "unbalanced-paren", detail: "unexpected )" });
            parenDepth = 0;
          }
          break;
        default:
          flush();
          group = st.nextGroup();
          stage = 0;
      }
    }
    flush();
    if (parenDepth > 0) st.uncertain.push({ code: "unbalanced-paren", detail: "unclosed (" });
  }

  private trackCd(seg: ShellSegment, cwd: string | null): string | null {
    if (seg.cmd !== "cd" && seg.cmd !== "pushd") return cwd;
    const target = seg.args.slice(1).find((a) => !a.value.startsWith("-") || a.value === "-");
    if (!target) return this.st.home || null;
    if (target.value === "-" || target.expansion && !/^(\$HOME|\$\{HOME\})(\/|$)/.test(target.value)) return null;
    const expanded = expandApprovalHome(target.value, this.st.home);
    if (isAbsolute(expanded)) return normalize(expanded);
    return cwd === null ? null : resolve(cwd, expanded);
  }

  /** Builds one segment (and its nested ones). Returns its index, or -1 when nothing was emitted. */
  private emitSegment(
    raw: string,
    inWords: Word[],
    redirTokens: Extract<Token, { t: "redir" }>[],
    meta: Meta,
    group: number,
    stage: number,
    cwd: string | null,
    vars: ReadonlyMap<string, string> = new Map(),
  ): number {
    const st = this.st;
    let words = inWords.map((w) => substituteKnownVar(w, vars));

    // Reserved words in command position.
    for (let guard = 0; guard < 64 && words.length > 0 && !words[0]!.quoted; guard++) {
      const v = words[0]!.value;
      if (RESERVED_PREFIX.has(v) || RESERVED_SKIP.has(v)) {
        words = words.slice(1);
        if (v === "time") while (words[0] && (words[0].value === "-p" || words[0].value === "--")) words = words.slice(1);
        continue;
      }
      break;
    }
    if (words[0] && !words[0].quoted && words[0].value === "function") {
      // `function NAME { body` : the body starts a command of its own.
      if (words[1]) st.functions.add(words[1].value);
      words = words.slice(2);
      while (words.length > 0 && !words[0]!.quoted && RESERVED_PREFIX.has(words[0]!.value)) words = words.slice(1);
    }
    const first = words[0];
    if (first && !first.quoted && (first.value === "for" || first.value === "select" || first.value === "case")) {
      this.recurseSubs(words, redirTokens, meta, cwd, undefined);
      return -1;
    }
    if (words.length === 0 && redirTokens.length === 0) return -1;
    const wordsWithAssignments = words;

    const assignments: string[] = [];
    let i = 0;
    while (i < words.length && isAssignment(words[i]!)) {
      assignments.push(words[i]!.value);
      i++;
    }
    words = words.slice(i);

    const redirects: ShellRedirect[] = redirTokens.map((r) => {
      const t = r.target ? substituteKnownVar(r.target, vars) : undefined;
      return {
      op: r.op,
      ...(r.fd !== undefined ? { fd: r.fd } : {}),
      target: t?.value ?? "",
      dynamic: t?.expansion ?? false,
      ...(r.body !== undefined ? { body: r.body } : {}),
      };
    });
    const stdinParts = redirects.filter((r) => r.body !== undefined).map((r) => r.body!);

    const index = st.segments.length;
    const segment: ShellSegment = {
      raw,
      argv: [],
      args: [],
      cmd: "",
      fullArgv: [],
      assignments,
      redirects,
      wrappers: [],
      sudo: meta.sudo,
      depth: meta.depth,
      ...(meta.via !== undefined ? { via: meta.via } : {}),
      remote: meta.remote,
      dynamicArgs: meta.dynamicArgs ?? false,
      group,
      stage,
      cwd,
      ...(stdinParts.length > 0 ? { stdinText: stdinParts.join("\n") } : {}),
      ...(meta.parent !== undefined ? { parent: meta.parent } : {}),
    };
    st.segments.push(segment);

    for (const a of assignments) {
      const name = a.slice(0, a.search(/[[+=]/));
      if (isDangerousEnvName(name)) {
        st.uncertain.push({ code: "env-override", detail: `${name} is set for the command`, segment: index });
      }
    }

    // Brace expansion and argument list.
    const expanded: Array<{ w: Word; value: string }> = [];
    for (const w of words) {
      const b = braceExpand(w);
      if (b?.nested) st.uncertain.push({ code: "brace-expansion", detail: "nested brace expansion", segment: index });
      if (b && !b.nested) {
        if (expanded.length === 0) st.uncertain.push({ code: "brace-expansion", detail: "brace expansion in command position", segment: index });
        for (const v of b.values) expanded.push({ w, value: v });
      } else {
        expanded.push({ w, value: w.value });
      }
    }

    this.recurseSubs(wordsWithAssignments, redirTokens, meta, cwd, index);
    this.unwrap(segment, expanded, meta, cwd, index);
    let info = st.groups.get(segment.group);
    if (!info) {
      info = { decoder: false, byStage: new Map() };
      st.groups.set(segment.group, info);
    }
    if (!info.byStage.has(segment.stage)) info.byStage.set(segment.stage, segment);
    if (isDecoderSegment(segment)) info.decoder = true;
    return index;
  }

  private recurseSubs(words: Word[], redirTokens: Extract<Token, { t: "redir" }>[], meta: Meta, cwd: string | null, parent: number | undefined): void {
    const all = [...words, ...redirTokens.map((r) => r.target).filter((w): w is Word => w !== undefined)];
    for (const w of all) {
      for (const sub of w.subs) {
        this.parseText(sub.text, { depth: meta.depth + 1, via: sub.kind, remote: meta.remote, sudo: false, ...(parent !== undefined ? { parent } : {}) }, cwd);
      }
    }
  }

  /** Strips wrappers off `segment` and recurses into nested command text. */
  private unwrap(segment: ShellSegment, initial: Array<{ w: Word; value: string }>, meta: Meta, cwd: string | null, index: number): void {
    const st = this.st;
    let items = initial;
    segment.fullArgv = items.map((x) => x.value);
    const nested = (text: string, via: string, extra: Partial<Meta> = {}): void => {
      const remote = meta.remote || (extra.remote ?? false);
      this.parseText(text, { depth: meta.depth + 1, via, remote, sudo: segment.sudo || (extra.sudo ?? false), parent: index, ...(extra.dynamicArgs ? { dynamicArgs: true } : {}) }, remote ? null : cwd);
    };
    const nestedWords = (ws: Array<{ w: Word; value: string }>, via: string, extra: Partial<Meta> = {}): void => {
      if (ws.length === 0) return;
      const child: ShellSegment = {
        raw: ws.map((x) => x.value).join(" "),
        argv: [], args: [], cmd: "", fullArgv: [], assignments: [], redirects: [], wrappers: [],
        sudo: segment.sudo || (extra.sudo ?? false),
        depth: meta.depth + 1,
        via,
        remote: meta.remote || (extra.remote ?? false),
        dynamicArgs: extra.dynamicArgs ?? false,
        group: segment.group,
        stage: segment.stage,
        cwd: meta.remote || extra.remote ? null : cwd,
        parent: index,
      };
      const childIndex = st.segments.length;
      st.segments.push(child);
      if (child.depth > SHELL_MAX_DEPTH) {
        st.uncertain.push({ code: "too-deep", detail: `nesting deeper than ${SHELL_MAX_DEPTH} levels`, segment: childIndex });
        return;
      }
      this.unwrap(child, ws, { ...meta, depth: child.depth, via, remote: child.remote, sudo: child.sudo, parent: index }, cwd, childIndex);
    };
    const chdir = (dir: string | undefined, dynamic: boolean): void => {
      if (dir === undefined) return;
      if (dynamic) { segment.cwd = null; cwd = null; return; }
      const expanded = expandApprovalHome(dir, st.home);
      const next = isAbsolute(expanded) ? normalize(expanded) : segment.cwd === null ? null : resolve(segment.cwd, expanded);
      segment.cwd = next;
      cwd = next;
    };
    const uncertain = (code: string, detail: string, extra: Partial<ShellUncertainty> = {}): void => {
      st.uncertain.push({ code, detail, segment: index, ...extra });
    };
    const wordsOf = (xs: Array<{ w: Word; value: string }>): Word[] => xs.map((x) => ({ ...x.w, value: x.value }));

    for (let guard = 0; guard < MAX_UNWRAP && items.length > 0; guard++) {
      const head = items[0]!;
      if (head.w.expansion || head.w.glob) {
        uncertain("dynamic-command", `the command name "${head.value}" is computed at run time`);
        break;
      }
      const cmd = normalizeCmd(head.value);
      const ws = wordsOf(items);

      if (cmd === "sudo" || cmd === "doas" || cmd === "pkexec" || cmd === "run0") {
        segment.wrappers.push(cmd);
        segment.sudo = true;
        const vo = WRAPPER_VALUE_OPTS[cmd === "run0" ? "sudo" : cmd] ?? new Set<string>();
        let j = skipOptions(ws, 1, vo);
        const optWords = ws.slice(1, j).map((w) => w.value);
        for (let k = 0; k < optWords.length; k++) {
          const o = optWords[k]!;
          if (o === "-D" || o === "--chdir") chdir(optWords[k + 1], ws[k + 2]?.expansion ?? false);
          else if (o.startsWith("--chdir=")) chdir(o.slice(8), ws[k + 1]?.expansion ?? false);
          else if (/^-D./.test(o)) chdir(o.slice(2), ws[k + 1]?.expansion ?? false);
        }
        if (optWords.some((o) => o === "-e" || o === "--edit")) {
          items = [{ w: { ...head.w, value: "sudoedit" }, value: "sudoedit" }, ...items.slice(j)];
          break;
        }
        // NAME=value assignments after sudo options.
        while (j < ws.length && isAssignment(ws[j]!)) { segment.assignments.push(ws[j]!.value); j++; }
        items = items.slice(j);
        continue;
      }
      if (cmd === "su") {
        segment.wrappers.push("su");
        segment.sudo = true;
        const cIdx = ws.findIndex((w, k) => k > 0 && (w.value === "-c" || w.value === "--command"));
        if (cIdx !== -1 && ws[cIdx + 1]) {
          const cw = ws[cIdx + 1]!;
          if (cw.expansion) uncertain("shell-c-dynamic", "su -c with a computed command");
          nested(cw.value, "su -c", { sudo: true });
        }
        items = [];
        break;
      }
      if (cmd === "env") {
        segment.wrappers.push("env");
        let j = 1;
        let split: string | null = null;
        while (j < ws.length) {
          const v = ws[j]!.value;
          if (v === "--") { j++; break; }
          if (v === "-S" || v === "--split-string") { split = ws[j + 1]?.value ?? ""; j += 2; break; }
          if (v.startsWith("--split-string=")) { split = v.slice(15); j++; break; }
          if (/^-[A-Za-z0-9]*S/.test(v)) {
            const rest = v.slice(v.indexOf("S") + 1);
            if (rest) { split = rest; j++; } else { split = ws[j + 1]?.value ?? ""; j += 2; }
            break;
          }
          if (v === "-C" || v === "--chdir") { chdir(ws[j + 1]?.value, ws[j + 1]?.expansion ?? false); j += 2; continue; }
          if (v.startsWith("--chdir=")) { chdir(v.slice(8), ws[j]!.expansion); j++; continue; }
          if (/^-C./.test(v)) { chdir(v.slice(2), ws[j]!.expansion); j++; continue; }
          if (isAssignment(ws[j]!)) { segment.assignments.push(v); j++; continue; }
          if (v.startsWith("-")) { j += WRAPPER_VALUE_OPTS.env!.has(v) ? 2 : 1; continue; }
          break;
        }
        for (const a of segment.assignments) {
          const name = a.slice(0, a.search(/[[+=]/));
          if (isDangerousEnvName(name)) uncertain("env-override", `${name} is set for the command`);
        }
        if (split !== null) {
          const rest = ws.slice(j).map((w) => w.value).join(" ");
          nested(`${split} ${rest}`.trim(), "env -S");
          items = [];
          break;
        }
        if (j >= ws.length) {
          // Bare env prints the environment; keep it as the command.
          items = [head];
          break;
        }
        items = items.slice(j);
        continue;
      }
      if (cmd === "repeat" && items.length > 2) {
        segment.wrappers.push("repeat");
        items = items.slice(2);
        continue;
      }
      if ((cmd === "pnpm" || cmd === "yarn" || cmd === "npm" || cmd === "bun") && items[1]?.value === "exec") {
        segment.wrappers.push(`${cmd} exec`);
        let j = 2;
        while (j < items.length && items[j]!.value.startsWith("-")) { const dd = items[j]!.value === "--"; j++; if (dd) break; }
        if (j >= items.length) break;
        items = items.slice(j);
        continue;
      }
      if (cmd === "script") {
        const cIdx = ws.findIndex((w, k) => k > 0 && (w.value === "-c" || w.value === "--command"));
        if (cIdx !== -1 && ws[cIdx + 1]) { nested(ws[cIdx + 1]!.value, "script -c"); items = [head]; break; }
        let j = skipOptions(ws, 1, new Set(["-F", "-t", "-T", "-I", "-O", "-B", "-E", "-m"]));
        if (j < ws.length) j++;                                   // the typescript file
        if (j >= ws.length) break;
        segment.wrappers.push("script");
        items = items.slice(j);
        continue;
      }
      if (cmd === "ssh-agent") {
        const j = skipOptions(ws, 1, new Set(["-a", "-t", "-E", "-P", "-O"]));
        if (j >= ws.length) break;
        segment.wrappers.push("ssh-agent");
        items = items.slice(j);
        continue;
      }
      if (cmd === "command" || cmd === "builtin" || cmd === "nocorrect" || cmd === "noglob" || cmd === "exec" ||
          cmd === "nohup" || cmd === "time" || cmd === "nice" || cmd === "ionice" || cmd === "timeout" ||
          cmd === "stdbuf" || cmd === "caffeinate" || cmd === "setsid" || cmd === "unbuffer" || cmd === "arch" ||
          cmd === "chrt" || cmd === "taskset" || cmd === "flock" || cmd === "busybox" || cmd === "then" || cmd === "do") {
        if (cmd === "command" && ws.slice(1).some((w) => w.value === "-v" || w.value === "-V")) break;
        segment.wrappers.push(cmd);
        let j = skipOptions(ws, 1, WRAPPER_VALUE_OPTS[cmd] ?? new Set<string>());
        if (cmd === "timeout" && j < ws.length) j++;            // the duration
        if (cmd === "chrt" && j < ws.length) j++;               // the priority
        if (cmd === "taskset" && j < ws.length) j++;            // the mask
        if (cmd === "flock") {
          const cIdx = ws.findIndex((w, k) => k > 0 && (w.value === "-c" || w.value === "--command"));
          if (cIdx !== -1 && ws[cIdx + 1]) { nested(ws[cIdx + 1]!.value, "flock -c"); items = []; break; }
          if (j < ws.length) j++;                               // the lock file
        }
        items = items.slice(j);
        continue;
      }
      if (SHELLS.has(cmd)) {
        let j = 1;
        let hasC = false;
        let readsStdin = false;
        while (j < ws.length) {
          const v = ws[j]!.value;
          if (v === "--" || v === "-") { j++; break; }
          if (!(v.startsWith("-") || v.startsWith("+")) || v.length < 2) break;
          if (v.startsWith("--")) { j += WRAPPER_VALUE_OPTS.shell!.has(v) ? 2 : 1; continue; }
          const letters = v.slice(1);
          if (letters.includes("c")) hasC = true;
          if (letters.includes("s")) readsStdin = true;
          j += letters.endsWith("o") || letters.endsWith("O") ? 2 : 1;
        }
        if (hasC) {
          const cw = ws[j];
          segment.wrappers.push(cmd);
          if (!cw) { uncertain("shell-c-dynamic", `${cmd} -c without a command`); items = []; break; }
          if (cw.expansion) uncertain("shell-c-dynamic", `${cmd} -c with a computed command`);
          nested(cw.value, `${cmd} -c`);
          items = [head];
          break;
        }
        const scriptArg = ws[j];
        if (!scriptArg || readsStdin) {
          if (segment.stdinText !== undefined) {
            uncertain("heredoc-to-shell", `a here-document is run by ${cmd}`);
            nested(segment.stdinText, `${cmd} <<`);
          } else if (segment.stage > 0) {
            const info = st.groups.get(segment.group);
            if (info?.decoder) uncertain("decode-to-shell", `decoded input is run by ${cmd}`);
            else uncertain("pipe-to-shell", `input piped into ${cmd} is run as commands`);
            const literal = literalOutputOf(info?.byStage.get(segment.stage - 1));
            if (literal) nested(literal, `${cmd} <|`);
          } else if (!scriptArg && segment.redirects.some((r) => r.op === "<")) {
            uncertain("source-file", `${cmd} runs commands from a file`);
          }
        }
        break;
      }
      if (cmd === "eval") {
        segment.wrappers.push("eval");
        const rest = items.slice(1);
        if (rest.some((x) => x.w.expansion)) uncertain("eval-dynamic", "eval of computed text");
        nested(rest.map((x) => x.value).join(" "), "eval");
        items = [head];
        break;
      }
      if (cmd === "source" || cmd === ".") {
        const target = items[1];
        if (!target || !target.w.subs.length) uncertain("source-file", `${cmd} runs commands from a file`);
        break;
      }
      if (cmd === "alias" || cmd === "unalias") {
        if (items.length > 1) uncertain("alias", "aliases change what later commands run");
        break;
      }
      if (cmd === "export" || cmd === "declare" || cmd === "typeset" || cmd === "readonly" || cmd === "local") {
        for (const x of items.slice(1)) {
          const name = x.value.split("=")[0] ?? "";
          if (x.value.includes("=") && isDangerousEnvName(name)) {
            uncertain("env-override", `${name} is changed for later commands`);
          }
        }
        break;
      }
      if (cmd === "xargs") {
        const j = skipOptions(ws, 1, WRAPPER_VALUE_OPTS.xargs!);
        const sub = items.slice(j);
        const literal = segment.stage > 0 ? literalOutputOf(st.groups.get(segment.group)?.byStage.get(segment.stage - 1)) : null;
        if (literal && sub.length > 0) {
          const repl = xargsReplaceString(ws.slice(1, j).map((w) => w.value));
          const literalWord = (value: string): { w: Word; value: string } => ({ w: { ...head.w, value, quotedMask: [], raw: value, quoted: true, expansion: false, glob: false, subs: [] }, value });
          if (repl !== null) {
            const line = literal.split("\n")[0]!.trim();
            nestedWords(sub.map((x) => (x.value.includes(repl) ? literalWord(x.value.split(repl).join(line)) : x)), "xargs", { dynamicArgs: true });
          } else {
            nestedWords([...sub, ...literal.split(/\s+/).filter(Boolean).map(literalWord)], "xargs", { dynamicArgs: true });
          }
        } else {
          nestedWords(sub, "xargs", { dynamicArgs: true });
        }
        break;
      }
      if (cmd === "find") {
        for (let k = 1; k < items.length; k++) {
          const v = items[k]!.value;
          if (v === "-exec" || v === "-execdir" || v === "-ok" || v === "-okdir") {
            let e = k + 1;
            while (e < items.length && items[e]!.value !== ";" && items[e]!.value !== "+") e++;
            nestedWords(items.slice(k + 1, e), "find -exec", { dynamicArgs: true });
            k = e;
          }
        }
        break;
      }
      if (cmd === "watch") {
        const j = skipOptions(ws, 1, WRAPPER_VALUE_OPTS.watch!);
        const rest = items.slice(j);
        if (rest.length > 0) nested(rest.map((x) => x.value).join(" "), "watch");
        break;
      }
      if (cmd === "ssh" || cmd === "scp" || cmd === "sftp" || cmd === "rsync") {
        for (let k = 1; k < ws.length; k++) {
          const v = ws[k]!.value;
          if (cmd === "rsync" && (v === "-e" || v === "--rsh") && ws[k + 1]) nested(ws[k + 1]!.value, "rsync -e");
          if (cmd === "rsync" && v.startsWith("--rsh=")) nested(v.slice(6), "rsync -e");
          const opt = v === "-o" ? (ws[k + 1]?.value ?? "") : v.startsWith("-o") ? v.slice(2) : "";
          const m = /^\s*(ProxyCommand|LocalCommand|KnownHostsCommand|RemoteCommand)\s*[= ]\s*(.*)$/i.exec(opt);
          if (m) {
            uncertain("ssh-local-command", `${cmd} -o ${m[1]} runs a command`);
            nested(m[2] ?? "", `${cmd} -o ${m[1]}`);
          }
        }
      }
      if (cmd === "git") {
        for (let k = 1; k < ws.length; k++) {
          const v = ws[k]!.value;
          if (!v.startsWith("-")) break;
          const kv = v === "-c" ? (ws[k + 1]?.value ?? "") : v.startsWith("--config-env") ? v : "";
          if (!kv) continue;
          const key = kv.split("=")[0]!.toLowerCase();
          const value = kv.slice(kv.indexOf("=") + 1);
          if (/^(alias\..*|core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass|gitproxy)|pager\..*|diff\..*\.(textconv|command)|diff\.external|filter\..*|credential\..*|sequence\.editor|gpg\..*program|ssh\.variant|uploadpack\..*|receivepack\..*|protocol\..*\.allow|init\.templatedir|include\.path|includeif\..*)$/.test(key) || v.startsWith("--config-env")) {
            uncertain("git-config-exec", `git -c ${key} can run a command`);
            if (key.startsWith("alias.") && value.startsWith("!")) nested(value.slice(1), "git alias");
          }
        }
      }
      if (cmd === "ssh") {
        const j = skipOptions(ws, 1, WRAPPER_VALUE_OPTS.ssh!);
        const rest = items.slice(j + 1);                        // after the host
        if (rest.length > 0) {
          if (rest.some((x) => x.w.expansion)) uncertain("ssh-dynamic", "ssh remote command contains local expansions");
          nested(rest.map((x) => x.value).join(" "), "ssh", { remote: true });
        }
        break;
      }
      if ((cmd === "kubectl" || cmd === "oc" || cmd === "kubecolor") && items.some((x) => x.value === "exec")) {
        const dd = items.findIndex((x) => x.value === "--");
        if (dd !== -1 && dd + 1 < items.length) nestedWords(items.slice(dd + 1), "kubectl exec", { remote: true });
        break;
      }
      if ((cmd === "docker" || cmd === "podman" || cmd === "nerdctl") && items[1]?.value === "exec") {
        const j = skipOptions(ws, 2, WRAPPER_VALUE_OPTS.dockerExec!);
        if (j + 1 < items.length) nestedWords(items.slice(j + 1), "docker exec", { remote: true });
        break;
      }
      break;
    }

    segment.argv = items.map((x) => x.value);
    segment.args = items.map((x) => wordToArg(x.w, x.value));
    segment.cmd = items.length > 0 ? normalizeCmd(items[0]!.value) : "";
    if (segment.wrappers.length === 0 && segment.fullArgv.length === 0) segment.fullArgv = [...segment.argv];

    this.inlineCode(segment, index);
  }

  /** Inline interpreter code and interpreters fed from stdin. */
  private inlineCode(segment: ShellSegment, index: number): void {
    const st = this.st;
    const cmd = segment.cmd;
    const args = segment.argv;
    const flags = INTERPRETER_CODE_FLAGS[cmd];
    if (flags) {
      for (let k = 1; k < args.length; k++) {
        const v = args[k]!;
        const lower = v.toLowerCase();
        const cluster = /^-[A-Za-z]{2,}$/.test(v);
        const hit = flags.find((f) => lower === f.toLowerCase() ||
          (f.length === 2 && !lower.startsWith("--") && (cluster ? v.slice(1).includes(f[1]!) : lower.startsWith(f.toLowerCase()) && lower.length > 2)));
        if (hit) {
          const nextIsCode = lower === hit.toLowerCase() || cluster;
          const code = nextIsCode ? (args[k + 1] ?? "") : v.slice(hit.length);
          st.uncertain.push({ code: "inline-code", detail: `${cmd} ${hit} runs inline code`, segment: index, code_text: code });
          return;
        }
        if (!v.startsWith("-")) break;
      }
    }
    if (cmd === "deno" || cmd === "bun") {
      if (args[1] === "eval") {
        st.uncertain.push({ code: "inline-code", detail: `${cmd} eval runs inline code`, segment: index, code_text: args.slice(2).join(" ") });
        return;
      }
    }
    if (cmd === "awk" || cmd === "gawk" || cmd === "mawk" || cmd === "nawk") {
      const program = args.slice(1).find((a) => !a.startsWith("-")) ?? "";
      if (program.includes("system") || program.includes("|") || /print[^;}]*>\s*"/.test(program)) {
        st.uncertain.push({ code: "inline-code", detail: `${cmd} program can run commands or write files`, segment: index, code_text: program });
      }
      return;
    }
    if (INTERPRETERS_READING_STDIN.has(cmd)) {
      const positional = args.slice(1).filter((a) => !a.startsWith("-"));
      const fromStdin = positional.length === 0 || args.includes("-");
      if (fromStdin && (segment.stdinText !== undefined || segment.stage > 0)) {
        st.uncertain.push({
          code: "inline-code",
          detail: segment.stdinText !== undefined ? `${cmd} runs a here-document as code` : `${cmd} runs piped input as code`,
          segment: index,
          code_text: segment.stdinText ?? "",
        });
      }
    }
  }
}

/** Fork bomb shapes: a function whose body pipes itself into itself in the background. */
function detectForkBomb(raw: string, functions: ReadonlySet<string>): boolean {
  let stripped = "";
  for (const ch of raw) if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") stripped += ch;
  let checked = 0;
  for (const name of functions) {
    if (!name) continue;
    if (++checked > 50) break;
    if (stripped.includes(`${name}|${name}&`) || stripped.includes(`${name}&${name}`)) return true;
  }
  return false;
}

/**
 * Parse a shell command for the approval gate. Never throws: an internal
 * error becomes one `parse-error` uncertainty.
 */
export function parseShell(command: string, opts: ParseShellOptions = {}): ParsedShell {
  const segments: ShellSegment[] = [];
  const uncertain: ShellUncertainty[] = [];
  const functions = new Set<string>();
  let groups = 0;
  const st: BuildState = {
    segments,
    uncertain,
    functions,
    group: 0,
    home: opts.home ?? "",
    nextGroup: () => groups++,
    groups: new Map(),
  };
  try {
    if (typeof command !== "string") {
      return { segments, uncertain: [{ code: "parse-error", detail: "command is not a string" }], forkBomb: false, functions: [] };
    }
    if (command.length > SHELL_MAX_CERTAIN_LENGTH) {
      uncertain.push({ code: "too-long", detail: `command is ${command.length} characters (over ${SHELL_MAX_CERTAIN_LENGTH})` });
    }
    const hidden = countHiddenShellChars(command);
    if (hidden > 0) uncertain.push({ code: "hidden-char", detail: `${hidden} control, invisible or direction-changing character(s)` });
    new ShellParser(st).parseText(command, { depth: 0, remote: false, sudo: false }, opts.cwd ? normalize(opts.cwd) : null);
    const forkBomb = detectForkBomb(command, functions);
    return { segments, uncertain, forkBomb, functions: [...functions] };
  } catch (err) {
    uncertain.push({ code: "parse-error", detail: err instanceof Error ? err.message : String(err) });
    return { segments, uncertain, forkBomb: false, functions: [...functions] };
  }
}
