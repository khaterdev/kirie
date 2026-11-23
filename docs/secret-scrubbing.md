# Secret scrubbing

Kirie replaces secrets (API keys, bot tokens, passwords, private keys) with a
marker such as `«redacted:github-token»` before text leaves the process or is
written to one of its stores. Scrubbing is **on by default** and reduces
accidental spread. It is not a containment boundary: the agent has a shell and
can still send a value anywhere on purpose.

For secrets that were stored **before** scrubbing existed, there is a separate
owner-only audit: `/secrets scan` finds them (read-only) and `/secrets redact`
removes them after you confirm. Rotating a key that was found is still your
job: see [Rotate what was found](#rotate-what-was-found).

## What is scrubbed, and where

Two passes run on every scrubbed text:

1. **Known values.** Values Kirie itself holds, matched exactly in raw,
   URL-encoded, base64 and JSON-escaped form: every credential in the
   credential store, resolved secret fields of `config.yaml`, environment
   variables with secret-shaped names, and the `KEY=VALUE` lines of
   `~/.kirie/secrets/*.env`. Values shorter than 12 characters are skipped
   unless they are at least 8 and mix letters and digits.
2. **Patterns.** Provider formats (`private-key`, `anthropic-key`,
   `openai-key`, `github-token`, `gitlab-token`, `aws-access-key-id`,
   `slack-token`, `telegram-bot-token`, `discord-token`, `google-api-key`,
   `stripe-key`, `linear-key`, `sentry-token`, `vendor-prefixed`,
   `twilio-account-sid`, `jwt`) and context rules that keep the name and
   redact only the value (`auth-header`, `url-password`,
   `secret-query-param`, `secret-assignment`). There is no generic
   "high-entropy string" rule, so git SHAs, UUIDs, message ids and base64
   images pass untouched.

Sinks:

| Sink | Where it is applied |
|---|---|
| Channel sends and edits | Every adapter is wrapped at registration: `sendText`, `editMessage`, media captions, button labels, `sendInteractive`, `updateInteractive`. This covers agent replies, command output, errors, task results, proactive notifications, schedule announcements and `/api/channel-action` |
| Logs | Every module logger scrubs the serialized log line |
| Memory and daily notes | `MemoryStore.store()`, in the daemon and in the tools subprocess. The tool result tells the agent that something was redacted and to use `kirie credentials set` |
| Chat history | `ChatHistoryStore.append()`. The live turn still sees what you typed; only the stored copy is scrubbed |
| Heartbeat logs | `HeartbeatLogStore.log()` |
| Background tasks | `result` and `error` (not `prompt`: a task may need the value to do its job) |
| Gateway JSON | `lastError` in `/status`, the `/api/channel-action` error |
| Audit trail, owner prompt cards, command replies | through the shared scrubber |
| Webhook payloads, approval prompts, plugin events, proposals | in the features that produce them |

`security.scrubbing.enabled` is read **once at start**. A config reload or a
runtime setting cannot turn it off, and there is deliberately no
`/secrets off`. When it is off, Kirie logs a warning and tells you at start.

## What is not scrubbed

- **Pixels.** Screenshots and images are never inspected. A key visible in a
  screenshot stays in that screenshot.
- **Values the scrubber cannot recognise**: a secret with no known prefix and
  no secret-looking name next to it (for example a bare random password), and
  transformed values (split across messages, reversed, spelled out, hex).
  Only values Kirie itself holds are caught in base64 or URL-encoded form.
- **Files the agent writes** with `Write`, `Edit` or `Bash`, including
  `MEMORY.md`, `SOUL.md`, `TOOLS.md` and anything in the workspace.
- **SDK transcripts** under `~/.claude*/projects/`, which hold full turns.
- **`background_tasks.prompt`** (see above).
- **Tool output the model reads.** `sinks.toolOutputToModel` exists but is off
  and not wired: rewriting tool output would break flows where the agent
  reads a key in order to use it.

`/secrets scan` reads some of these (Markdown files, task prompts, and with
`full` the log files) and lists the transcript and backup directories it
cannot clean.

## Configuration and adding patterns

All keys live under `security.scrubbing` in `~/.kirie/config.yaml` and take
effect at the next start:

```yaml
security:
  scrubbing:
    enabled: true
    disabledRules: []          # e.g. ["secret-assignment"] if it misfires
    customPatterns:            # your own provider formats
      - name: "acme"           # rule name, /^[a-z0-9-]{1,40}$/; the marker becomes «redacted:acme»
        pattern: "acme_[a-z0-9]{32}"
        flags: ""              # any of i, m, s, u
    allowPatterns: []          # a match that fully matches one of these is kept
    mask: "label"              # "partial" keeps the first and last 4 chars of long values
```

Custom and allow patterns must stay linear-time, because there is no regex
engine with that guarantee in Node and every outbound message runs them:

- every quantifier is bounded, `{n}` or `{n,m}` with `m <= 256`; no `*`, `+`
  or `{n,}`;
- no quantified groups and no backreferences;
- at most one variable-length quantifier;
- a custom pattern starts with at least 2 literal characters (its prefix).

A pattern that breaks a rule fails config validation; at runtime it would be
skipped with a warning. To find a false positive, `/secrets status` shows
redaction counters by rule and by sink; disable the rule that misfires.

A new **built-in** rule goes in `packages/core/src/security/secret-patterns.ts`
(`DEFAULT_SECRET_RULES`), with a positive test built from fragments at run
time and a check that the negative corpus in `secret-scrubber.test.ts` stays
byte-identical. Features never write their own patterns; they call
`scrubSecrets()`.

## /secrets commands (owner only, in your DM)

| Command | What it does |
|---|---|
| `/secrets` or `/secrets status` | On or off, scrubbed sinks, active rule count, known secrets (labels only, such as `credential:telegram.bot_token`), redaction counters since start, the last scan |
| `/secrets scan [quick\|full]` | Read-only audit. `quick` (default): `memory.db` (memories, schedules, webhooks), `chat-history.db`, `background-tasks.db`, `heartbeat-logs.db`, the workspace Markdown files (`MEMORY.md`, `SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`, `USER.md`) and `config.yaml`. `full` adds `~/.kirie/logs/*.log` and `*.jsonl` and lists `~/.claude*/projects` and `~/.kirie/backups` without opening them. Replies with counts by store and rule and the report path |
| `/secrets report [n]` | The first `n` findings (default 20, max 100) of the last scan: id, store, location, rule, fingerprint |
| `/secrets redact <id\|all> [vault]` | Shows what will change and asks Confirm/Cancel. Only then changes stored data |

The agent has one related tool, `secrets_scan`. It runs a quick scan with
read-only handles and returns **counts only** (by store and by rule): no
locations, no fingerprints, no values. It writes no report and cannot redact.

### How a scan stays value-free

Every store is opened read-only (SQLite `readonly: true`, files with `r`); a
scan changes no file, not even a WAL or SHM file. SQLite creates `-wal` and
`-shm` even for a read-only handle when no other connection has the database
open, so an idle database (no `-wal` next to it) is read into memory and
scanned from that copy instead; one over 1 GB is reported as unreadable. A finding holds the store,
a location built from row ids and column names (a memory key or schedule name
shown in a location is itself masked first), the rule, and a fingerprint.
The fingerprint is an HMAC-SHA256 of the value under a random key that exists
only in the daemon's memory for the latest scan: the same secret in two places
gets the same fingerprint, and the report cannot be used to recover or confirm
a value. The report is written to `~/.kirie/reports/secrets-scan-<time>.json`,
mode 0600 in a 0700 directory. Scan and redact each write one audit record
(`feature: "secrets"`) with ids and counts, never values.

`auth-header` findings are shown as `auth-header (Authorization)` or
`auth-header (bare Bearer)`, so you can tell which form fired.

### What redact does

- It works only on findings of the **latest scan in this run of Kirie**
  (the fingerprint key is never stored). After a restart, scan again.
- Each location is re-read and redacted only if the HMAC of what is there now
  still equals the fingerprint. A row or line that changed since the scan is
  skipped and reported, never damaged.
- Databases: `PRAGMA secure_delete = ON`, then the update in one transaction
  (memory rows get a new `content_hash`), a full-text index rebuild
  (`memories_fts`, `messages_fts`, `heartbeat_logs_fts`), stale vectors
  removed (chat-history and heartbeat vectors of changed rows are deleted;
  redacted memories are re-embedded from the redacted text when embeddings
  are on, otherwise their vector is deleted), `PRAGMA wal_checkpoint(TRUNCATE)`
  and `VACUUM` (skipped for a file over 256 MB, because it blocks Kirie and
  needs that much free disk again; secure delete has already zeroed the freed
  pages). The reply says if a checkpoint was only partial (another
  process was reading): old pages can then survive until the next restart, so
  scan again afterwards.
- Log and Markdown files: each match is overwritten **in place** with a
  same-length mask (`«redacted:<rule>»` padded with `*`, or only `*` when the
  match is shorter than the marker). Size and inode do not change, so the log
  launchd keeps open goes on working, and lines appended meanwhile are kept.
- `vault`: for memory content, the value moves into the encrypted credential
  store as `vault.<memory-key>` (or `vault.memory-<row id>` when the memory
  key itself matches a rule, so no part of a secret becomes a key name) and
  the row gets `«stored in credential store: vault.<…>»`. The agent can still use
  it on purpose with `kirie credentials get vault.<memory-key>`. The report
  marks memories tagged `credential` with "vault suggested". Other findings
  get the normal marker.
- No backup is taken, because a backup would keep the secret. This cannot be
  undone.

Not redactable, with the reason in the report: `config.yaml` lines (move the
value into the credential store and use a `$credential:` reference), a memory
whose **key** is the secret (rename or delete it by hand), a memory tag, a
schedule or webhook name or path (delete and recreate it), the
prompt of a task that is still pending or running, and a log line that is not
valid UTF-8. A redacted schedule message takes effect for the running
scheduler after the next restart.

Scan and redact run on the daemon's main thread. A `full` scan reads about
60 MB of log per second on this machine, and replies wait while it runs.

## Rotate what was found

Redaction stops further spread. It does not make a leaked key safe: the value
has been on disk, in backups, and probably in SDK transcripts Kirie cannot
clean. The scan and redact replies end with rotation advice for every
provider rule that fired. The rotation itself is yours:

1. Revoke the key with its provider (for a Telegram bot token, `/revoke` in
   @BotFather; for Linear, Settings, Security & access, API keys; for
   GitHub, github.com/settings/tokens).
2. Store the new value in the credential store:
   `kirie credentials set <key> <new value>`, using the key your `config.yaml`
   references (`$credential:<key>`). The value is a command-line argument, so
   keep it out of shell history (in zsh, `setopt HIST_IGNORE_SPACE` and start
   the line with a space).
3. Restart Kirie so the new value is loaded and registered as a known secret.
4. `/secrets scan full` again to confirm nothing new turned up.
