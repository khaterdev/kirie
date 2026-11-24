import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SecretScrubber,
  SCRUB_WITHHELD,
  configureScrubber,
  getScrubber,
  resetScrubberForTesting,
  scrubSecrets,
  scrubSecretsWithCount,
} from "./secret-scrubber.js";
import { DEFAULT_SECRET_RULES, DEFAULT_SECRET_RULE_NAMES, isSecretAssignmentName, validateScrubPattern, type SecretPatternRule } from "./secret-patterns.js";

// ---------------------------------------------------------------------------
// Synthetic secrets: built at run time from fragments and a seeded generator, so the
// repository never contains a real-looking token literal.
// ---------------------------------------------------------------------------

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;
const HEX = "0123456789abcdef";
const TOKEN = ALNUM + "_-";

let seed = 1;
function synth(len: number, alphabet = ALNUM): string {
  let x = (seed++ * 2654435761) >>> 0 || 1;
  let s = "";
  for (let i = 0; i < len; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    s += alphabet[x % alphabet.length];
  }
  return s;
}
/** Alphanumeric with at least one digit and one letter. */
const mixed = (len: number): string => `${synth(len - 2)}7q`;
const marker = (rule: string): string => `«redacted:${rule}»`;

function fresh(cfg?: ConstructorParameters<typeof SecretScrubber>[0]): SecretScrubber {
  return new SecretScrubber(cfg);
}

describe("SecretScrubber pattern rules (one positive per rule)", () => {
  const s = fresh();

  const cases: Array<{ rule: string; make: () => { input: string; expected: string } }> = [
    {
      rule: "private-key",
      make: () => {
        const block = ["-----BEGIN", " RSA PRIVATE KEY-----\n", synth(64, ALNUM + "+/"), "\n-----END RSA PRIVATE KEY-----"].join("");
        return { input: `key:\n${block}\ndone`, expected: `key:\n${marker("private-key")}\ndone` };
      },
    },
    {
      rule: "anthropic-key",
      make: () => {
        const t = ["sk", "-ant-", "api03-", synth(40, TOKEN)].join("");
        return { input: `key ${t} end`, expected: `key ${marker("anthropic-key")} end` };
      },
    },
    {
      rule: "openai-key",
      make: () => {
        const t = ["sk", "-proj-", mixed(40)].join("");
        return { input: `use ${t}.`, expected: `use ${marker("openai-key")}.` };
      },
    },
    {
      rule: "github-token",
      make: () => {
        const a = ["gh", "p_", synth(36)].join("");
        const b = ["github", "_pat_", synth(40, ALNUM + "_")].join("");
        return { input: `${a} and ${b}`, expected: `${marker("github-token")} and ${marker("github-token")}` };
      },
    },
    {
      rule: "gitlab-token",
      make: () => ({ input: `t=${["gl", "pat-", synth(20)].join("")}`, expected: `t=${marker("gitlab-token")}` }),
    },
    {
      rule: "aws-access-key-id",
      make: () => ({ input: `id ${["AK", "IA", synth(16, UPPER + DIGITS)].join("")} x`, expected: `id ${marker("aws-access-key-id")} x` }),
    },
    {
      rule: "slack-token",
      make: () => {
        const t = ["xo", "xb-", synth(11, DIGITS), "-", synth(24)].join("");
        const hook = ["https://hooks.", "slack.com/services/", "T", synth(8, UPPER + DIGITS), "/B", synth(8, UPPER + DIGITS), "/", synth(24)].join("");
        return {
          input: `${t} ${hook}`,
          expected: `${marker("slack-token")} https://hooks.slack.com/services/${marker("slack-token")}`,
        };
      },
    },
    {
      rule: "telegram-bot-token",
      make: () => {
        const id = `7${synth(9, DIGITS)}`;
        const t = `${id}:${["AA", synth(33, TOKEN)].join("")}`;
        return { input: `token ${t}`, expected: `token ${id}:${marker("telegram-bot-token")}` };
      },
    },
    {
      rule: "discord-token",
      make: () => {
        const t = ["M", synth(25, TOKEN), ".", synth(6), ".", synth(30, TOKEN)].join("");
        const hook = ["https://discord.com/api/webhooks/", synth(18, DIGITS), "/", synth(60, TOKEN)].join("");
        return {
          input: `bot ${t} hook ${hook}`,
          expected: `bot ${marker("discord-token")} hook ${hook.slice(0, hook.lastIndexOf("/") + 1)}${marker("discord-token")}`,
        };
      },
    },
    {
      rule: "google-api-key",
      make: () => {
        const a = ["AI", "za", synth(35, TOKEN)].join("");
        const b = ["ya29", ".", synth(40, TOKEN)].join("");
        const c = ["GOCSPX", "-", synth(28, TOKEN)].join("");
        return { input: `${a} ${b} ${c}`, expected: [1, 2, 3].map(() => marker("google-api-key")).join(" ") };
      },
    },
    {
      rule: "stripe-key",
      make: () => {
        const a = ["sk", "_live_", synth(24)].join("");
        const b = ["wh", "sec_", synth(32)].join("");
        return { input: `${a} ${b}`, expected: `${marker("stripe-key")} ${marker("stripe-key")}` };
      },
    },
    {
      rule: "linear-key",
      make: () => ({ input: `linear ${["lin", "_api_", synth(40)].join("")}`, expected: `linear ${marker("linear-key")}` }),
    },
    {
      rule: "sentry-token",
      make: () => ({ input: ["sntry", "s_", synth(40)].join(""), expected: marker("sentry-token") }),
    },
    {
      rule: "vendor-prefixed",
      make: () => {
        const ts = [
          ["npm", "_", synth(36)].join(""),
          ["hf", "_", synth(34)].join(""),
          ["SG", ".", synth(22, TOKEN), ".", synth(43, TOKEN)].join(""),
          ["SK", synth(32, HEX)].join(""),
        ];
        return { input: ts.join(" | "), expected: ts.map(() => marker("vendor-prefixed")).join(" | ") };
      },
    },
    {
      rule: "twilio-account-sid",
      make: () => ({ input: `sid ${["AC", synth(32, HEX)].join("")}`, expected: `sid ${marker("twilio-account-sid")}` }),
    },
    {
      rule: "voice-provider-credential",
      make: () => {
        const id = ["MA", synth(17, UPPER + DIGITS), "7"].join("");
        const token = ["Zx9", synth(36), "q7"].join("").slice(0, 40);
        const tw = ["4f", synth(29, HEX), "a"].join("");
        return {
          input: `Plivo auth id ${id}, token ${token}\ntwilio auth token: ${tw}`,
          expected: `Plivo auth id ${marker("voice-provider-credential")}, token ${marker("voice-provider-credential")}\ntwilio auth token: ${marker("voice-provider-credential")}`,
        };
      },
    },
    {
      rule: "jwt",
      make: () => {
        const t = ["ey", "J", synth(20, TOKEN), ".", "eyJ", synth(30, TOKEN), ".", synth(43, TOKEN)].join("");
        return { input: `jwt=${t};`, expected: `jwt=${marker("jwt")};` };
      },
    },
    {
      rule: "auth-header",
      make: () => {
        const bearer = mixed(32);
        const basic = Buffer.from(`user:${mixed(12)}`).toString("base64");
        return {
          input: `Authorization: Bearer ${bearer}\nProxy-Authorization: Basic ${basic}\nsend Bearer ${mixed(30)} now`,
          expected: `Authorization: Bearer ${marker("auth-header")}\nProxy-Authorization: Basic ${marker("auth-header")}\nsend Bearer ${marker("auth-header")} now`,
        };
      },
    },
    {
      rule: "url-password",
      make: () => ({
        input: `postgres://admin:${mixed(16)}@db.internal:5432/app`,
        expected: `postgres://admin:${marker("url-password")}@db.internal:5432/app`,
      }),
    },
    {
      rule: "secret-query-param",
      make: () => ({
        input: `https://x.example/cb?code=1&access_token=${mixed(24)}&state=ok`,
        expected: `https://x.example/cb?code=1&access_token=${marker("secret-query-param")}&state=ok`,
      }),
    },
    {
      rule: "secret-assignment",
      make: () => {
        const v = () => mixed(18);
        const lines = [
          [`DB_PASSWORD=${v()}`, `DB_PASSWORD=${marker("secret-assignment")}`],
          [`export AWS_SECRET_ACCESS_KEY="${v()}"`, `export AWS_SECRET_ACCESS_KEY="${marker("secret-assignment")}"`],
          [`  api_key: ${v()}`, `  api_key: ${marker("secret-assignment")}`],
          [`{"clientSecret": "${v()}"}`, `{"clientSecret": "${marker("secret-assignment")}"}`],
          [`run --token ${v()} --verbose`, `run --token ${marker("secret-assignment")} --verbose`],
          [`{"msg":"cfg {\\"apiKey\\":\\"${v()}\\"}"}`, `{"msg":"cfg {\\"apiKey\\":\\"${marker("secret-assignment")}\\"}"}`],
          [`password: ${v()}.`, `password: ${marker("secret-assignment")}.`],
        ];
        return { input: lines.map((l) => l[0]).join("\n"), expected: lines.map((l) => l[1]).join("\n") };
      },
    },
  ];

  for (const c of cases) {
    it(`redacts ${c.rule}`, () => {
      const { input, expected } = c.make();
      const result = s.scrubWithCount(input);
      expect(result.text).toBe(expected);
      expect(result.rules[c.rule]).toBeGreaterThan(0);
    });
  }

  it("covers every default rule with a positive case", () => {
    expect(new Set(cases.map((c) => c.rule))).toEqual(new Set(DEFAULT_SECRET_RULE_NAMES));
  });

  it("redacts an unterminated private key block up to the end of its body only", () => {
    const text = ["-----BEGIN", " PRIVATE KEY-----\n", synth(80, ALNUM + "+/")].join("");
    expect(s.scrub(`a\n${text}`)).toBe(`a\n${marker("private-key")}`);
    expect(s.scrub(`a\n${text}\n\nThat was the key, don't share it!`)).toBe(`a\n${marker("private-key")}\n\nThat was the key, don't share it!`);
  });

  it("an unterminated block inside a JSON log line keeps the line valid", () => {
    const header = ["-----BEGIN", " OPENSSH PRIVATE KEY-----"].join("");
    const line = `${JSON.stringify({ level: 30, msg: `${header}\n${synth(70, ALNUM + "+/")}\n${synth(70, ALNUM + "+/")}`, n: 1 })}\n`;
    const out = s.scrub(line, { sink: "log" });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ level: 30, msg: marker("private-key"), n: 1 });
  });

  describe("indented private keys (SCRUB-B1)", () => {
    const B64 = ALNUM + "+/";
    const begin = ["-----BEGIN", " PRIVATE KEY-----"].join("");
    const end = ["-----END", " PRIVATE KEY-----"].join("");
    const bodyLines = (): string[] => [synth(64, B64), synth(64, B64), `${synth(40, B64)}==`];
    const block = (indent: string, nl = "\n", lines = bodyLines()): { text: string; lines: string[] } => ({
      text: [indent + begin, ...lines.map((l) => indent + l), indent + end].join(nl),
      lines,
    });
    const noBody = (out: string, lines: string[]): void => {
      for (const l of lines) expect(out).not.toContain(l.slice(0, 32));
      expect(out).not.toContain(end);
    };

    for (const [label, indent] of [["2 spaces", "  "], ["4 spaces", "    "], ["8 spaces", "        "], ["16 spaces", " ".repeat(16)], ["a tab", "\t"], ["two tabs", "\t\t"]] as const) {
      it(`redacts the whole key indented by ${label}`, () => {
        const { text, lines } = block(indent);
        const out = s.scrub(`config:\n${text}\nnext: 1`);
        noBody(out, lines);
        expect(out).toBe(`config:\n${indent}${marker("private-key")}\nnext: 1`);
      });
    }

    it("a Kubernetes / Helm YAML block scalar (tls.key: |)", () => {
      const { text, lines } = block("    ");
      const yaml = `apiVersion: v1\nkind: Secret\nstringData:\n  tls.key: |\n${text}\n  tls.crt: x\n`;
      const out = s.scrub(yaml);
      noBody(out, lines);
      expect(out).toBe(`apiVersion: v1\nkind: Secret\nstringData:\n  tls.key: |\n    ${marker("private-key")}\n  tls.crt: x\n`);
    });

    it("a Markdown list item (3 spaces)", () => {
      const { text, lines } = block("   ");
      const out = s.scrub(`1. Paste this:\n\n${text}\n\n2. Save.`);
      noBody(out, lines);
      expect(out).toContain("2. Save.");
    });

    it("CRLF line endings with indentation", () => {
      const { text, lines } = block("  ", "\r\n");
      const out = s.scrub(`k: |\r\n${text}\r\nz: 1`);
      noBody(out, lines);
      expect(out).toBe(`k: |\r\n  ${marker("private-key")}\r\nz: 1`);
    });

    it("the JSON-escaped indented form in a log line", () => {
      const { text, lines } = block("    ");
      const line = `${JSON.stringify({ level: 30, msg: `values:\n${text}\nok` })}\n`;
      const out = s.scrub(line, { sink: "log" });
      noBody(out, lines);
      expect(JSON.parse(out)).toEqual({ level: 30, msg: `values:\n    ${marker("private-key")}\nok` });
    });

    it("the JSON-escaped tab-indented form", () => {
      const { text, lines } = block("\t");
      const out = s.scrub(JSON.stringify({ msg: text }), { sink: "log" });
      noBody(out, lines);
    });

    it("trailing blanks after body lines", () => {
      const lines = bodyLines();
      const text = [begin, ...lines.map((l) => `  ${l}   `), `  ${end}`].join("\n");
      const out = s.scrub(text);
      noBody(out, lines);
      expect(out).toBe(marker("private-key"));
    });

    it("an unterminated indented block stops at the first prose line", () => {
      const lines = bodyLines();
      const text = [`  ${begin}`, ...lines.map((l) => `  ${l}`)].join("\n");
      const out = s.scrub(`${text}\n\nThat was the key, don't share it!`);
      noBody(out, lines);
      expect(out).toBe(`  ${marker("private-key")}\n\nThat was the key, don't share it!`);
    });

    it("every sink (replies, logs, memory, chat history, task results, cards) redacts the indented body", () => {
      const sinks = ["channel", "log", "memory", "chat-history", "task-result", "heartbeat-log", "audit", "prompt-card", "proposal"] as const;
      for (const sink of sinks) {
        const { text, lines } = block("    ");
        noBody(s.scrub(`tls.key: |\n${text}`, { sink }), lines);
      }
    });

    it("indentation beyond the bound ends the body instead of scanning on", () => {
      const lines = bodyLines();
      const deep = " ".repeat(40);
      const text = [begin, lines[0], `${deep}prose after a very deep indent`].join("\n");
      const out = s.scrub(text);
      expect(out).not.toContain(lines[0]!.slice(0, 32));
      expect(out).toContain("prose after a very deep indent");
    });
  });

  it("a BEGIN header mentioned in prose redacts only the header", () => {
    const header = ["-----BEGIN", " RSA PRIVATE KEY-----"].join("");
    expect(s.scrub(`The file starts with ${header} and then base64.`)).toBe(`The file starts with ${marker("private-key")} and then base64.`);
  });
});

describe("the bot-token-in-URL incident", () => {
  const botId = `8${synth(9, DIGITS)}`;
  const secret = ["AA", synth(33, TOKEN)].join("");
  const url = `https://api.telegram.org/bot${botId}:${secret}/getUpdates`;

  class HttpError extends Error {
    constructor(message: string, readonly error: unknown) {
      super(message);
      this.name = "HttpError";
    }
  }

  it("redacts a grammY HttpError (message, stack, nested error) through scrubDeep", () => {
    const inner = Object.assign(new Error(`request to ${url} failed, reason: socket hang up`), { code: "ECONNRESET" });
    const err = new HttpError(`Network request for 'getUpdates' failed! (${url})`, inner);
    const out = getScrubber().scrubDeep({ reason: err }, { sink: "log" });
    const serialized = JSON.stringify(out, (_k, v: unknown) =>
      v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack } : v);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(`bot${botId}:${marker("telegram-bot-token")}/getUpdates`);
    expect(out.reason).toBeInstanceOf(HttpError);
    expect(err.message).toContain(secret); // input not mutated
  });

  it("redacts the URL inside a serialized log line", () => {
    const line = `${JSON.stringify({ level: 60, name: "daemon", reason: { message: `failed! (${url})` }, msg: "unhandled promise rejection" })}\n`;
    const out = scrubSecrets(line, { sink: "log" });
    expect(out).not.toContain(secret);
    expect(out.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

describe("negative corpus", () => {
  const s = fresh();
  const uuid = [synth(8, HEX), synth(4, HEX), `4${synth(3, HEX)}`, `a${synth(3, HEX)}`, synth(12, HEX)].join("-");
  const corpus = [
    synth(40, HEX), // git SHA
    `commit ${synth(7, HEX)} fixes token refresh`,
    synth(64, HEX), // sha256
    uuid,
    "max_tokens=4096",
    "input_tokens: 1234, output_tokens: 567",
    "token_count: 12345678",
    "https://host:8080/path@v2",
    "const token = getToken()",
    "let token = await refreshToken();",
    "password: <your-password>",
    "API_KEY=$OPENAI_API_KEY",
    "SECRET=${MY_SECRET}",
    "token: process.env.TELEGRAM_TOKEN",
    "password_reset_url: https://example.com/reset",
    "secret: false",
    "PWD=/Users/someone/project",
    "export PATH=/usr/local/bin:/usr/bin",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "Telegram message id 123456789 in chat -1001234567890",
    "message_id: 987654321",
    "the bearer of bad news arrived",
    "Token usage: 1500 tokens today",
    "ssh://git@github.com:org/repo.git and http://localhost:3000/api",
    "redis://localhost:6379/0",
    "scikit-learn is imported as sk-learn in some notes",
    "The secret: always be kind",
    "Password: Required",
    "user@example.com wrote at 2026-11-23T10:15:30Z",
    "*bold* _italic_ `code` [link](https://example.com/a?b=c)",
    JSON.stringify({ level: 30, time: 1_700_000_000_000, pid: 123, hostname: "mac", name: "pipeline", sessionKey: "telegram:dm:12345", msg: "turn complete" }),
    "see https://example.com/docs?page=2&sort=desc#top",
    "keyboard: qwerty12345",
    "token_type: Bearer",
    '{"passwordChangedAt":"2026-11-23T10:00:00Z","tokenExpiresAt":"2026-12-01T00:00:00Z"}',
    "maxTokenAge: 86400000, lastTokenRefresh=20261123101500",
    '{"apiKeyId":"key_20261123_abcdef","secretsCount":12345678}',
    "at Object.<anonymous> (/Users/dev/kirie/packages/core/src/security/secret-scrubber.ts:120:13)",
    "",
  ];

  for (const text of corpus) {
    it(`leaves ${JSON.stringify(text.slice(0, 50))} byte-identical`, () => {
      const result = s.scrubWithCount(text, { sink: "channel" });
      expect(result.text).toBe(text);
      expect(result.count).toBe(0);
      expect(s.detect(text)).toEqual([]);
    });
  }
});

describe("known secrets", () => {
  it("redacts raw, URL-encoded, base64 and JSON-escaped forms", () => {
    const s = fresh();
    const value = `${mixed(14)}/+&"x`;
    s.addKnownSecret(value, "credential:test.value");
    const forms = [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      JSON.stringify(value).slice(1, -1),
    ];
    for (const form of forms) {
      expect(s.scrub(`a ${form} b`)).toBe(`a ${marker("known-secret")} b`);
    }
    expect(s.stats().knownSecrets).toBe(1);
    expect(s.knownSecretLabels()).toEqual(["credential:test.value"]);
  });

  it("skips short values and accepts 8+ mixed values", () => {
    const s = fresh();
    s.addKnownSecret("abcdefgh", "short-letters");
    s.addKnownSecret("12345678", "short-digits");
    s.addKnownSecret("abcd1234", "short-mixed");
    expect(s.stats().knownSecrets).toBe(1);
    expect(s.scrub("abcdefgh 12345678 abcd1234")).toBe(`abcdefgh 12345678 ${marker("known-secret")}`);
  });

  it("matches the longest secret first when one contains another", () => {
    const s = fresh();
    const short = mixed(12);
    const long = `${short}${mixed(10)}`;
    s.addKnownSecret(short, "a");
    s.addKnownSecret(long, "b");
    const r = s.scrubWithCount(`x ${long} y ${short} z`);
    expect(r.text).toBe(`x ${marker("known-secret")} y ${marker("known-secret")} z`);
    expect(r.count).toBe(2);
  });

  it("stops redacting a removed secret", () => {
    const s = fresh();
    const v = mixed(16);
    s.addKnownSecret(v, "tmp");
    expect(s.scrub(v)).toBe(marker("known-secret"));
    s.removeKnownSecret(v);
    expect(s.scrub(v)).toBe(v);
  });

  it("honours knownSecrets.minLength", () => {
    const s = fresh({ knownSecrets: { minLength: 20 } });
    s.addKnownSecret(synth(16, LOWER), "letters-16");
    expect(s.stats().knownSecrets).toBe(0);
  });
});

describe("idempotency and markers", () => {
  const s = fresh();
  const samples = [
    `Authorization: Bearer ${mixed(30)}`,
    `DB_PASSWORD=${mixed(18)} and ${["gh", "p_", synth(36)].join("")}`,
    `postgres://u:${mixed(12)}@h/db`,
    `?token=${mixed(20)}`,
    `*bold* ${["sk", "-ant-", synth(30, TOKEN)].join("")} _x_ \`code\``,
  ];
  for (const text of samples) {
    it(`scrub(scrub(x)) === scrub(x) for ${JSON.stringify(text.slice(0, 24))}`, () => {
      const once = s.scrub(text);
      expect(once).not.toBe(text);
      const twice = s.scrubWithCount(once);
      expect(twice.text).toBe(once);
      expect(twice.count).toBe(0);
    });
  }

  it("keeps Markdown characters around the marker intact", () => {
    const t = ["gh", "p_", synth(36)].join("");
    // A leading "_" is a token character, so "_ghp_..._" (snake case) is deliberately not entered.
    expect(s.scrub(`*${t}* ~${t}~ ||${t}|| \`${t}\``)).toBe(
      `*${marker("github-token")}* ~${marker("github-token")}~ ||${marker("github-token")}|| \`${marker("github-token")}\``,
    );
  });

  it("supports the partial mask", () => {
    const p = fresh({ mask: "partial" });
    const t = ["gh", "p_", synth(36)].join("");
    const out = p.scrub(t);
    expect(out).toBe(`«redacted:github-token:${t.slice(0, 4)}…${t.slice(-4)}»`);
    expect(p.scrub(out)).toBe(out);
  });

  it("the partial mask needs 32+ characters and never applies to known values (SCRUB-N9)", () => {
    const p = fresh({ mask: "partial" });
    const short = mixed(24);
    expect(p.scrub(`DB_PASSWORD=${short}`)).toBe(`DB_PASSWORD=${marker("secret-assignment")}`);
    const known = mixed(40);
    p.addKnownSecret(known, "db");
    expect(p.scrub(`x ${known} y`)).toBe(`x ${marker("known-secret")} y`);
  });

  describe("voice provider credentials without a prefix (SCRUB-N2)", () => {
    it("only near the provider name", () => {
      const tw = ["4f", synth(29, HEX), "a"].join("");
      expect(s.scrub(`TWILIO auth token is ${tw}`)).toBe(`TWILIO auth token is ${marker("voice-provider-credential")}`);
      expect(s.scrub(`${tw} is the twilio token`)).toBe(`${marker("voice-provider-credential")} is the twilio token`);
      // Far from the name, or with no name at all: an MD5 or a hash is left alone.
      expect(s.scrub(`md5 ${tw}`)).toBe(`md5 ${tw}`);
      expect(s.scrub(`twilio${" filler".repeat(30)} ${tw}`)).toContain(tw);
      // A lower-case git SHA next to "plivo" is not a Plivo token.
      const sha = synth(40, HEX);
      expect(s.scrub(`plivo fix in ${sha}`)).toBe(`plivo fix in ${sha}`);
    });

    it("is linear on many keywords", () => {
      const text = `twilio ${synth(31, HEX)}g `.repeat(40_000);
      const t0 = performance.now();
      s.scrub(text);
      expect(performance.now() - t0).toBeLessThan(1500);
    });
  });

  it("a versioned model id next to token is not a secret; a password still is (SCRUB-N7)", () => {
    expect(s.scrub("token: claude-opus-5-5")).toBe("token: claude-opus-5-5");
    expect(s.scrub("model_key: llama-3.1-70")).toBe("model_key: llama-3.1-70");
    expect(s.scrub("password: correct-horse-battery-9")).toBe(`password: ${marker("secret-assignment")}`);
    const uuidish = "123e4567-e89b-12d3-a456-426614174000";
    expect(s.scrub(`token: ${uuidish}`)).toBe(`token: ${marker("secret-assignment")}`);
  });

  describe("tokens split by invisible characters or Markdown emphasis (SCRUB-N6)", () => {
    const tok = (): string => ["gh", "p_", synth(36)].join("");
    it("a zero-width character inside a token", () => {
      const t = tok();
      for (const zw of ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u00AD"]) {
        const out = s.scrub(`key ${t.slice(0, 10)}${zw}${t.slice(10)} end`);
        expect(out).not.toContain(t.slice(10));
        expect(out).toBe(`key ${marker("github-token")} end`);
      }
    });
    it("bold, italic, strike or code marks splitting a token", () => {
      const t = tok();
      for (const [open, close] of [["**", "**"], ["*", "*"], ["~~", "~~"], ["`", "`"], ["__", "__"]] as const) {
        const out = s.scrub(`${t.slice(0, 20)}${open}${t.slice(20)}${close} ok`);
        expect(out, open).not.toContain(t.slice(20));
        expect(out, open).toContain(marker("github-token"));
        expect(out, open).toMatch(/ ok$/);
      }
    });
    it("a known value split by a zero-width character", () => {
      const k = fresh();
      const v = mixed(24);
      k.addKnownSecret(v, "db");
      expect(k.scrub(`pw ${v.slice(0, 8)}\u200B${v.slice(8)}`)).toBe(`pw ${marker("known-secret")}`);
    });
    it("ordinary Markdown is untouched and scrubbing stays idempotent", () => {
      const md = "**Bold** and *italic*, `code`, ~~strike~~, __init__ and a zero\u200Bwidth word.";
      expect(s.scrub(md)).toBe(md);
      const t = tok();
      const once = s.scrub(`**${t.slice(0, 15)}**${t.slice(15)}`);
      expect(s.scrub(once)).toBe(once);
    });
  });

  it("a Telegram bot token with an 11 or 12 digit bot id (SCRUB-N10)", () => {
    const secret = ["AA", synth(33, TOKEN)].join("");
    expect(s.scrub(`12345678901:${secret}`)).toBe(`12345678901:${marker("telegram-bot-token")}`);
    expect(s.scrub(`123456789012:${secret}`)).toBe(`123456789012:${marker("telegram-bot-token")}`);
  });
});

describe("allow lists and rule configuration", () => {
  it("lets exactly the allowed value through", () => {
    const s = fresh();
    const a = ["gh", "p_", synth(36)].join("");
    const b = ["gh", "p_", synth(36)].join("");
    const known = mixed(16);
    s.addKnownSecret(known, "k");
    expect(s.scrub(`${a} ${b} ${known}`, { allow: new Set([a, known]) })).toBe(`${a} ${marker("github-token")} ${known}`);
  });

  it("disabledRules turns a rule off", () => {
    const s = fresh({ disabledRules: ["secret-assignment"] });
    const text = `PASSWORD=${mixed(16)}`;
    expect(s.scrub(text)).toBe(text);
  });

  it("allowPatterns keep a fully matching value", () => {
    const s = fresh({ allowPatterns: ["test-[a-z0-9]{1,32}"] });
    expect(s.scrub("PASSWORD=test-abc123xyz")).toBe("PASSWORD=test-abc123xyz");
    expect(s.scrub("PASSWORD=prod-abc123xyz")).toBe(`PASSWORD=${marker("secret-assignment")}`);
  });

  it("customPatterns add a rule, unsafe ones are rejected", () => {
    const s = fresh({
      customPatterns: [
        { name: "acme-key", pattern: "acme_[a-z0-9]{16}" },
        { name: "bad", pattern: "(a+)+b" },
      ],
    });
    expect(s.scrub(`k=${["acme", "_", synth(16, LOWER + DIGITS)].join("")}!`)).toBe(`k=${marker("acme-key")}!`);
    expect(s.scrub("aaaaab")).toBe("aaaaab");
  });

  it("validateScrubPattern accepts the bounded grammar", () => {
    expect(validateScrubPattern("acme_[a-z]{4}", "", { requirePrefix: true })).toBeNull();
    expect(validateScrubPattern("acme_[a-z0-9]{16,64}", "", { requirePrefix: true })).toBeNull();
    expect(validateScrubPattern("ac\\.me-[A-F0-9]{32}(?![A-F0-9])", "i", { requirePrefix: true })).toBeNull();
    expect(validateScrubPattern("test-[a-z0-9]{1,32}")).toBeNull();
  });

  it("validateScrubPattern rejects patterns that can backtrack or are broken", () => {
    for (const bad of ["(a+)+", "(x*)*y", "(a|aa)+$", "(?:a|a)+b", "\\w*\\w*x", "[a-z]+[a-z0-9]+=", "a{2,}",
      "ab[a-z]{1,9}[0-9]{1,9}", "ab[a-z]{1,999}", "(ab){2}"]) {
      expect(validateScrubPattern(bad), bad).not.toBeNull();
    }
    expect(validateScrubPattern("(a)\\1")).toMatch(/backreference/);
    expect(validateScrubPattern("[")).toMatch(/invalid/);
    expect(validateScrubPattern("a?")).toMatch(/empty/);
    expect(validateScrubPattern("a", "g")).toMatch(/flags/);
    expect(validateScrubPattern("[a-z]{16}", "", { requirePrefix: true })).toMatch(/literal/);
  });
});

describe("enabled switch and sinks", () => {
  const token = (): string => ["gh", "p_", synth(36)].join("");

  it("passes everything through when disabled", () => {
    const s = fresh({ enabled: false });
    const t = token();
    expect(s.scrub(t, { sink: "channel" })).toBe(t);
    expect(s.isEnabled()).toBe(false);
    expect(s.detect(t)).toHaveLength(1); // detect ignores the switch (used by /secrets scan)
  });

  it("respects per-sink switches", () => {
    const s = fresh({ sinks: { logs: false } });
    const t = token();
    expect(s.scrub(t, { sink: "log" })).toBe(t);
    expect(s.scrub(t, { sink: "channel" })).toBe(marker("github-token"));
    expect(s.scrub(t, { sink: "audit" })).toBe(marker("github-token"));
  });
});

describe("scrubDeep", () => {
  const s = fresh();
  const t = ["gh", "p_", synth(36)].join("");

  it("scrubs nested objects, arrays, Maps and Sets without mutating the input", () => {
    const input = { a: [t, { b: t }], m: new Map([["k", t]]), set: new Set([t]), n: 5, ok: true, nil: null };
    const out = s.scrubDeep(input);
    expect(out.a[0]).toBe(marker("github-token"));
    expect((out.a[1] as { b: string }).b).toBe(marker("github-token"));
    expect(out.m.get("k")).toBe(marker("github-token"));
    expect([...out.set]).toEqual([marker("github-token")]);
    expect(out.n).toBe(5);
    expect(out.ok).toBe(true);
    expect(out.nil).toBeNull();
    expect(input.a[0]).toBe(t);
  });

  it("handles Error with cause and own properties", () => {
    const cause = new Error(`inner ${t}`);
    const err = Object.assign(new TypeError(`outer ${t}`, { cause }), { detail: `d ${t}` });
    const out = s.scrubDeep(err);
    expect(out).toBeInstanceOf(TypeError);
    expect(out.message).toBe(`outer ${marker("github-token")}`);
    expect(out.stack).not.toContain(t);
    expect((out.cause as Error).message).toBe(`inner ${marker("github-token")}`);
    expect(out.detail).toBe(`d ${marker("github-token")}`);
  });

  it("is cycle-safe and caps depth", () => {
    const a: Record<string, unknown> = { v: t };
    a.self = a;
    const out = s.scrubDeep(a);
    expect(out.v).toBe(marker("github-token"));
    expect(out.self).toBe("[Circular]");

    let deep: Record<string, unknown> = { leaf: t };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    const json = JSON.stringify(s.scrubDeep(deep));
    expect(json).toContain("[Truncated]");
    expect(json).not.toContain(t);
  });
});

describe("detect and stats", () => {
  it("reports positions and fingerprints, never values", () => {
    const s = fresh();
    const t = ["gh", "p_", synth(36)].join("");
    const text = `a ${t} b ${t}`;
    const findings = s.detect(text);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.rule).toBe("github-token");
    expect(text.slice(findings[0]!.start, findings[0]!.end)).toBe(t);
    expect(findings[0]!.fingerprint).toBe(findings[1]!.fingerprint);
    expect(JSON.stringify(findings)).not.toContain(t);
    const keyed = s.detect(text, { fingerprintKey: "scan-key" });
    expect(keyed[0]!.fingerprint).not.toBe(findings[0]!.fingerprint);
  });

  it("counts redactions by sink and rule", () => {
    const s = fresh();
    s.scrub(["gh", "p_", synth(36)].join(""), { sink: "channel" });
    s.scrub(`PASSWORD=${mixed(16)}`, { sink: "memory" });
    s.scrub("nothing here", { sink: "memory" });
    const st = s.stats();
    expect(st.bySink).toEqual({ channel: 1, memory: 1 });
    expect(st.byRule).toEqual({ "github-token": 1, "secret-assignment": 1 });
  });
});

describe("fail closed", () => {
  const throwing: SecretPatternRule = {
    name: "boom",
    scan() {
      throw new Error("rule failure");
    },
  };

  it("uses the known-secret result when a rule throws", () => {
    const s = new SecretScrubber(undefined, { rules: [throwing, ...DEFAULT_SECRET_RULES] });
    const known = mixed(16);
    s.addKnownSecret(known, "k");
    const t = ["gh", "p_", synth(36)].join("");
    expect(s.scrub(`${known} ${t}`)).toBe(`${marker("known-secret")} ${marker("github-token")}`);
  });

  it("withholds the text when both passes fail", () => {
    const s = new SecretScrubber(undefined, { rules: [throwing] });
    // Make the known pass fail too.
    (s as unknown as { knownForms: Iterable<unknown> }).knownForms = {
      [Symbol.iterator]() {
        throw new Error("known failure");
      },
    };
    expect(s.scrub("hello", { sink: "channel" })).toBe(SCRUB_WITHHELD);
    expect(s.scrub("hello", { sink: "http" })).toBe(SCRUB_WITHHELD);
  });

  it("never throws on odd input", () => {
    const s = fresh();
    expect(s.scrub(undefined as unknown as string)).toBeUndefined();
    expect(s.scrubDeep(undefined)).toBeUndefined();
    expect(s.detect(42 as unknown as string)).toEqual([]);
  });
});

describe("timing on 1 MB adversarial input", () => {
  const MB = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
  const inputs: Record<string, string> = {
    "sk- repeated": fill("sk-"),
    "one character": fill("a"),
    "many =": fill("="),
    "token= repeated": fill("token="),
    "token: repeated": fill("token:"),
    "_token_ repeated": fill("_token_"),
    "apiKey camel": fill("apiKeyApiKey"),
    "password=value;": fill("password=abc123def;"),
    "eyJ repeated": fill("eyJ"),
    "digits": fill("1"),
    "digits and colons": fill("12345678:"),
    "BEGIN headers": fill("-----BEGIN PRIVATE KEY-----"),
    "url schemes": fill("https://a:"),
    "authorization": fill("authorization: "),
    "bearer": fill("Bearer "),
    "query params": fill("?token="),
    "dotted": fill("a."),
    "discord-ish": fill("M" + "a".repeat(25) + "."),
    "base64": Buffer.alloc(MB * 0.75, 7).toString("base64"),
    "spaces after keyword": fill("password" + " ".repeat(50)),
    "partial BEGIN headers": fill("-----BEGIN RSA "),
    "url users": fill("postgres://user:"),
    "marker starts": fill("«redacted"),
    "AKIA runs": fill("AKIA"),
    "quoted keyword values": fill('"secret": "'),
    "flags": fill("--token "),
    "BEGIN + indented short lines": fill(`-----BEGIN PRIVATE KEY-----\n${" ".repeat(16)}A\n`),
    "BEGIN + long blank runs": fill(`-----BEGIN PRIVATE KEY-----\n${" ".repeat(300)}`),
    "BEGIN + blank runs mid-line": fill(`-----BEGIN PRIVATE KEY-----\nAAAA${" ".repeat(15)}x`),
    "BEGIN + escaped tabs": fill(`-----BEGIN PRIVATE KEY-----\\n${"\\t".repeat(40)}`),
    "body of alternating blanks": `-----BEGIN PRIVATE KEY-----\n${fill(" \t\n")}`,
    "body of blank lines": `-----BEGIN PRIVATE KEY-----\n${fill(`${" ".repeat(15)}\n`)}`,
    "provider names": fill("plivo twilio "),
    "emphasis marks": fill("**"),
    "emphasis between prefixes": fill("gh*p_*sk-*"),
    "zero-width runs": fill("\u200B"),
    "zero-width in token chars": fill("ghp_\u200Babc"),
    "provider names and near-tokens": fill(`twilio ${"a1".repeat(15)}b plivo ${"Ab1".repeat(13)} `),
  };

  const known = fresh();
  for (let i = 0; i < 50; i++) known.addKnownSecret(mixed(24), `k${i}`);

  for (const [label, text] of Object.entries(inputs)) {
    it(`finishes quickly: ${label}`, () => {
      const t0 = performance.now();
      const out = known.scrub(text);
      const ms = performance.now() - t0;
      expect(typeof out).toBe("string");
      expect(ms).toBeLessThan(1000);
    });
  }
});

describe("process-wide singleton", () => {
  const savedEnv = process.env.KIRIE_SCRUB_CONFIG;
  beforeEach(() => {
    resetScrubberForTesting();
    delete process.env.KIRIE_SCRUB_CONFIG;
  });
  afterEach(() => {
    resetScrubberForTesting();
    if (savedEnv === undefined) delete process.env.KIRIE_SCRUB_CONFIG;
    else process.env.KIRIE_SCRUB_CONFIG = savedEnv;
  });

  it("scrubSecrets works with no configuration", () => {
    const t = ["gh", "p_", synth(36)].join("");
    expect(scrubSecrets(`x ${t}`)).toBe(`x ${marker("github-token")}`);
    expect(scrubSecretsWithCount(t)).toEqual({ text: marker("github-token"), count: 1 });
  });

  it("only the first configureScrubber call counts", () => {
    const first = configureScrubber({ enabled: true });
    const second = configureScrubber({ enabled: false });
    expect(second).toBe(first);
    expect(getScrubber().isEnabled()).toBe(true);
  });

  it("carries known secrets from an unconfigured instance", () => {
    const v = mixed(16);
    getScrubber().addKnownSecret(v, "early");
    configureScrubber({});
    expect(scrubSecrets(v)).toBe(marker("known-secret"));
  });

  it("reads KIRIE_SCRUB_CONFIG when unconfigured", () => {
    process.env.KIRIE_SCRUB_CONFIG = JSON.stringify({ disabledRules: ["github-token"] });
    const t = ["gh", "p_", synth(36)].join("");
    expect(scrubSecrets(t)).toBe(t);
  });

  it("ignores malformed KIRIE_SCRUB_CONFIG", () => {
    process.env.KIRIE_SCRUB_CONFIG = "not json";
    const t = ["gh", "p_", synth(36)].join("");
    expect(scrubSecrets(t)).toBe(marker("github-token"));
  });
});

describe("review regressions", () => {
  const s = fresh();
  const pw = (): string => mixed(14);

  it("finds secrets after JSON-escaped line breaks in a log line", () => {
    const a = pw();
    const b = pw();
    const t = ["gh", "p_", synth(36)].join("");
    const line = `${JSON.stringify({ msg: `config:\npassword=${a}\nFOO=1\napi_key=${b}\tsecret: ${pw()}\nline\n${t}` })}\n`;
    const out = s.scrub(line, { sink: "log" });
    expect(out).not.toContain(a);
    expect(out).not.toContain(b);
    expect(out).not.toContain(t);
    expect(JSON.parse(out).msg).toBe(
      `config:\npassword=${marker("secret-assignment")}\nFOO=1\napi_key=${marker("secret-assignment")}\tsecret: ${marker("secret-assignment")}\nline\n${marker("github-token")}`,
    );
  });

  it("merges overlapping findings instead of dropping the later one", () => {
    const id = `7${synth(9, DIGITS)}`;
    const body = ["AA", synth(20, TOKEN)].join("");
    const aws = ["AK", "IA", synth(16, UPPER + DIGITS)].join("");
    const text = `${id}:${body}-${aws}`;
    const once = s.scrub(text);
    expect(once).not.toContain(body);
    expect(once).not.toContain(aws);
    expect(once.startsWith(`${id}:`)).toBe(true);
    expect(s.scrub(once)).toBe(once);

    const bearer = `Bearer ${synth(12, LOWER)}${synth(8, DIGITS)}.${aws}`;
    const out = s.scrub(bearer);
    expect(out).toBe(`Bearer ${marker("aws-access-key-id")}`);
  });

  it("is idempotent on random concatenations of secret-like fragments", () => {
    const fragments = [
      () => ["gh", "p_", synth(36)].join(""), () => ["AK", "IA", synth(16, UPPER + DIGITS)].join(""),
      () => `${synth(9, DIGITS)}:${synth(32, TOKEN)}`, () => `password=${mixed(12)}`, () => `Bearer ${mixed(24)}`,
      () => `https://u:${mixed(10)}@h/`, () => "-", () => ":", () => " ", () => "=", () => "\\n", () => '"',
      () => ["sk", "-", synth(24, TOKEN), "9"].join(""), () => `?token=${mixed(12)}`, () => "eyJ", () => ".",
      () => synth(6, TOKEN), () => "`", () => "**", () => "|",
    ];
    for (let i = 0; i < 3000; i++) {
      let text = "";
      const parts = 2 + (i % 6);
      for (let j = 0; j < parts; j++) text += fragments[(i * 7 + j * 13 + (i >> 3)) % fragments.length]!();
      const once = s.scrub(text);
      expect(s.scrub(once), text).toBe(once);
    }
  });

  it("finds values in Markdown formatting", () => {
    const v = pw();
    for (const [input, expected] of [
      [`Your password: \`${v}\``, `Your password: \`${marker("secret-assignment")}\``],
      [`**Password:** ${v}`, `**Password:** ${marker("secret-assignment")}`],
      [`**API key**: ${v}`, `**API key**: ${marker("secret-assignment")}`],
      [`| password | ${v} |`, `| password | ${marker("secret-assignment")} |`],
      [`- \`DB_PASSWORD\`: \`${v}\``, `- \`DB_PASSWORD\`: \`${marker("secret-assignment")}\``],
    ] as const) {
      expect(s.scrub(input)).toBe(expected);
    }
  });

  it("leaves prose and code alone", () => {
    for (const text of [
      "My secret: everything changes.",
      "The secret: understanding yourself",
      "api_key = get_api_key_from_vault(name)",
      "token = await fetchToken(user)",
      "password: required_for_login",
      "Use a token | grep something_longer_here",
      "Secret: Happiness",
    ]) {
      expect(s.scrub(text), text).toBe(text);
    }
  });

  it("scrubDeep judges string values with their keys", () => {
    const v = pw();
    const out = s.scrubDeep({ apiKey: v, env: { DB_PASSWORD: v, HOME: "/Users/x" }, list: [{ token: v }], note: "hello", tokenCount: 123456789 });
    expect(out).toEqual({
      apiKey: marker("secret-assignment"),
      env: { DB_PASSWORD: marker("secret-assignment"), HOME: "/Users/x" },
      list: [{ token: marker("secret-assignment") }],
      note: "hello",
      tokenCount: 123456789,
    });
    expect(s.scrubDeep({ secret: "false", password: "$DB_PASS", max_tokens: "4096" })).toEqual({ secret: "false", password: "$DB_PASS", max_tokens: "4096" });
  });

  it("isSecretAssignmentName follows the assignment rule", () => {
    for (const n of ["apiKey", "DB_PASSWORD", "client_secret", "x-api-key", "token", "github.token", "API key"]) {
      expect(isSecretAssignmentName(n), n).toBe(true);
    }
    for (const n of ["tokenCount", "max_tokens", "keyboard", "secretName", "passwordChangedAt", "tokens", "author", ""]) {
      expect(isSecretAssignmentName(n), n).toBe(false);
    }
  });
});
