# Plugins (hooks)

Kirie can load small JavaScript plugins that **observe** what it does: incoming
messages, replies, tool calls, errors and channel connects/disconnects. With one
extra capability a plugin may also rewrite the text of an incoming message
before the agent sees it. That is all a plugin can do. Plugins cannot block or
change tool calls, add MCP tools, or add channels.

Plugins are **off by default**. Nothing is loaded until you turn the feature on
**and** approve a specific plugin's files.

## Read this first: what a plugin can do to you

> A plugin is JavaScript loaded into the Kirie daemon with `import()`. It runs
> with the daemon's full privileges: the decrypted bot tokens and credentials in
> memory, every database, and the filesystem and network as your user. The
> capability list limits what Kirie passes to and accepts from the plugin; it
> does not confine the plugin's code. Timeouts cannot stop a synchronous
> infinite loop. The hash pin makes later changes visible (tamper-evident), but
> it is not tamper-proof: the agent runs shell commands as the same user. Only
> enable a plugin whose source you have read.

The same statement is shown in the `/plugins enable` confirmation, in
`/help plugins`, and at the top of `packages/core/src/plugins/types.ts`.

Concretely:

- **In-process code is fully trusted.** Kirie hands plugins scrubbed, frozen
  copies of events and ignores what they return, but a plugin can still
  `import("node:fs")`, read `~/.kirie`, open sockets, or read `process.env`.
  The static scan shown at enable time is a hint, not a control.
- **Timeouts are best effort.** A hook that takes too long is skipped and keeps
  running in the background. A synchronous infinite loop or a blocking call in
  a plugin freezes the whole daemon; only an out-of-process design could prevent
  that, and Kirie does not have one.
- **The hash pin is tamper-evident, not tamper-proof.** The agent has a shell as
  your user, so it can write into `~/.kirie/plugins` and could edit the
  approvals file. What makes a self-installed or edited plugin visible or stops
  it: the approval must match the exact files (SHA-256 over the whole tree,
  checked on every load); approvals that appear or change in the file while
  Kirie runs are not trusted until you approve again; at start, an approvals
  file that does not match the seal `/plugins` wrote next to it is not trusted
  at all; every load at start is announced to you; every load, approval, refusal
  and failure is written to the audit log. **None of this stops a determined
  attacker with your shell:** something that reads Kirie's source can write a
  plugin, a matching approval and a matching seal, then restart Kirie, and the
  plugin runs before you can react. You would see "Plugins loaded: …" in your
  DM and the audit entry, but only afterwards. Running approvals in `ask` mode
  (`/approvals`) with its protected paths raises the bar further.
- **Separate from Claude Code hooks.** Your personal Claude Code settings hooks
  in `~/.claude/settings.json` already run inside Kirie's agent sessions (Kirie
  loads user settings). That is a different system and is not affected by
  anything on this page.

## Turning it on

1. Put the plugin in its own directory: `~/.kirie/plugins/<name>/`. Kirie never
   installs, downloads or `npm install`s anything. If the plugin has
   dependencies, vendor them into its directory yourself (`node_modules`
   included; it is hashed like every other file).
2. Read the code.
3. In your DM with the bot: `/plugins info <name>` to see the manifest, file
   count, hash and static-scan findings.
4. `/plugins enable <name>` shows the same summary plus the trust statement and
   asks you to confirm. Confirming approves **exactly those files**. If the scan
   found a blocking pattern (for example `eval`), you must add `force`.
5. `/plugins on` turns the feature on (it asks to confirm too) and loads every
   approved, enabled plugin. It stays on across restarts until `/plugins off`.

Every `/plugins` subcommand is owner-only and works only in your DM. There is no
MCP tool and no HTTP route that can approve, enable, disable or reload a plugin.
The agent has one read-only tool, `plugins_list`.

## Commands

| Command | What it does |
|---|---|
| `/plugins` or `/plugins list` | Master switch and each plugin's state: `not approved`, `approved, not loaded`, `loaded`, `disabled`, `CHANGED since approval`, `approval not verified`, `not in plugins.allow`, `FAILED`, `SUSPENDED` |
| `/plugins info <name>` | Manifest, events, capabilities, files, current and approved hash, last error, static-scan findings |
| `/plugins enable <name> [force]` | Directory checks, static scan, trust statement, confirm, then record the approval pinned to the hash and load it if plugins are on |
| `/plugins disable <name>` | Unload now and stop loading it. The approval record is kept with `enabled: false` |
| `/plugins reload [name]` | Check the hash again and reload one or all approved plugins. Clears a suspension |
| `/plugins on` / `/plugins off` | Master switch (a runtime override of `plugins.enabled`). `off` unloads everything |

## When a plugin loads

All of these must hold, every time (at start, `/plugins on`, `/plugins enable`,
`/plugins reload`):

1. `plugins.enabled` is on (config, overridden by `/plugins on|off`).
2. `plugins.allow` is empty or lists the name.
3. `~/.kirie/state/plugin-approvals.json` has a record for the name with
   `enabled: true`, and Kirie either wrote that record itself or read it at
   start from a file that matched its seal (`plugin-approvals.json.seal`).
4. The plugin's files hash to the approved SHA-256.

Before hashing, Kirie checks that the plugin directory is a real directory
directly inside the plugins directory, that every file and directory in it is
owned by you and is not group- or world-writable, that no symlink points outside
the tree, that there are no special files, and that the tree has at most 2000
files and 50 MB. The name must match `^[a-z0-9][a-z0-9._-]{0,63}$` and equal the
directory name, the `package.json` name, and the name the plugin's factory
returns.

The load sequence (all under `plugins.loadTimeoutMs`, default 10 s):

1. Hash the tree and compare with the approval.
2. Validate `package.json`. The capabilities and events it declares must be
   within what you approved.
3. Write the exact hashed bytes to a private copy under
   `~/.kirie/state/plugin-cache/<name>/<sha256>/` (0700) and import the entry
   from there. The plugin's own files that run are the files that were hashed,
   and an edited plugin always gets fresh modules. One gap: a bare import
   (`import x from "some-package"`) that is not in the plugin's own
   `node_modules` makes Node search parent directories
   (`~/.kirie/state/plugin-cache/node_modules`, `~/.kirie/node_modules`,
   `~/node_modules`, ...), and code found there is not covered by the hash.
   Vendor every dependency into the plugin directory.
4. Call the default export with `plugins.config.<name>`, check name and version.
5. Run `setup`.
6. Only then register hooks, and only for events declared in the manifest.
   `mcpTools` and `channelAdapters` in the definition are ignored with a warning.

Any failure leaves no hook registered, calls `teardown` if `setup` ran, records
the error, tells you once, and the other plugins still load. A hash mismatch is
never loaded; you get one message: *Plugin <name> changed since you approved it
and was not loaded. Review it, then /plugins enable <name>.*

On `/plugins disable`, `/plugins off`, `/restart` and shutdown, hooks are removed
first, then `teardown` runs under a timeout; a hanging teardown is abandoned.
Node cannot unload ES modules, so each reload of new content leaves the old
module in memory (a small leak per reload).

## Writing a plugin

```
~/.kirie/plugins/reply-timer/
  package.json
  index.js
```

`package.json`:

```json
{
  "name": "reply-timer",
  "version": "1.0.0",
  "type": "module",
  "kirie": {
    "entry": "index.js",
    "events": ["afterMessage"],
    "capabilities": ["hooks:observe"]
  }
}
```

`index.js`:

```js
// The default export is a factory. It receives plugins.config["reply-timer"].
export default function replyTimer(config) {
  const slowMs = config.slowMs ?? 60_000;
  return {
    name: "reply-timer",        // must equal the directory and package.json name
    version: "1.0.0",           // must equal package.json version
    hooks: [
      {
        event: "afterMessage",
        handler(e) {
          // e is a frozen, scrubbed copy. The return value is ignored.
          if (e.durationMs > slowMs) console.error(`slow reply in ${e.sessionKey}: ${e.durationMs} ms`);
        },
      },
    ],
    setup() {},     // optional, runs once under the load timeout, before hooks are registered
    teardown() {},  // optional, runs on unload under a timeout
  };
}
```

```yaml
# config.yaml
plugins:
  enabled: false        # use /plugins on instead
  config:
    reply-timer:
      slowMs: 30000
```

Types for editors: `@kirie/plugin-sdk` (types only, no runtime dependency).

### Events

| Event | Payload (all copies) | Delivered |
|---|---|---|
| `beforeMessage` | `sessionKey, channel, senderId, chatId?, text, timestamp` | Observers: after the transforms, not awaited. Transforms: awaited, see below |
| `afterMessage` | `sessionKey, channel, senderId, chatId?, origin, inputText?, responseText, isError, durationMs` | After each turn, not awaited |
| `beforeToolUse` | `toolName, params, verdict ("allowed" \| "denied" \| "asked"), toolUseId, kind, sessionKey?` | After the tool gates decided, not awaited |
| `afterToolUse` | `toolName, params, result, toolUseId, kind, sessionKey?, durationMs?` | After the tool ran, not awaited |
| `onError` | `source, sessionKey?, name, message` (never the raw `Error`) | When a turn fails |
| `onChannelConnect` | `channel` | A channel adapter started |
| `onChannelDisconnect` | `channel, reason?` | A channel adapter stopped or errored |

`origin` is one of `owner_message`, `other_user`, `schedule`, `loop`, `webhook`,
`goal`, `background`, `system`. `kind` is the SDK call kind (`chat`,
`background`, `goal`, `webhook`, `utility`).

Every payload is scrubbed for secrets (`plugins.scrubEventPayloads`, default
on; the one exception is the text handed to a transform hook, see below), capped (strings at 8000 characters, arrays and objects at 100 entries, 2000 values in total,
depth 6), and deep-frozen; each handler gets its own copy, so a plugin cannot
change what Kirie or another plugin sees.

### Capabilities

| Capability | Meaning |
|---|---|
| `hooks:observe` | Always granted. Receive events; return values are ignored |
| `hooks:transform-message` | A `beforeMessage` hook registered with `mode: "transform"` may return `{ text }` to replace the text the agent sees. Requires `beforeMessage` in `events` |

```js
hooks: [{
  event: "beforeMessage",
  mode: "transform",
  handler: (e) => ({ text: e.text.replace(/\bASAP\b/g, "as soon as possible") }),
}]
```

Only `text` is taken from a transform's return value. `senderId`, `channel`,
`chatId` and the session come from the original message, so a plugin cannot
change who a message appears to be from. The transform changes what the agent
sees, not what chat history records. Because it may rewrite the message, a
transform hook receives the **raw** message text: not truncated and not
scrubbed (its other fields are scrubbed as usual). Observers of `beforeMessage`
get the scrubbed copy.

There is no tool-interception capability. Blocking and rewriting tool calls
belong to Kirie's tool gates (`/approvals`), never to plugins.

### Failure isolation

- A hook that throws, rejects or exceeds `plugins.hookTimeoutMs` (default 2 s)
  is skipped and counted as a failure.
- Observers never delay a reply: Kirie queues the event and returns at once.
  Each plugin has its own queue (`plugins.maxQueuedEventsPerPlugin`, default
  100); when it is full the oldest event is dropped and counted.
- Transforms are awaited with a total budget of `hookTimeoutMs` for all of them
  together. When the budget is spent the remaining transforms are skipped and
  the text so far continues. A message is never dropped because of a plugin.
- After `plugins.maxConsecutiveFailures` (default 5) failures in a row, the
  plugin's hooks are suspended and you get one message. `/plugins reload <name>`
  resumes it.

## Config keys

| Key | Default | Notes |
|---|---|---|
| `plugins.enabled` | `false` | Master switch. `/plugins on|off` overrides it (runtime setting `plugins.enabled`) |
| `plugins.dir` | `~/.kirie/plugins` | The only directory plugins load from |
| `plugins.allow` | `[]` | Optional outer bound: when non-empty, only these names can load |
| `plugins.config` | `{}` | Per-plugin settings, `config.<name>`, passed as a copy. Do not put secrets here: plugins can log them |
| `plugins.hookTimeoutMs` | `2000` | Per hook, and the total transform budget |
| `plugins.loadTimeoutMs` | `10000` | Import + factory + setup |
| `plugins.maxConsecutiveFailures` | `5` | Circuit breaker |
| `plugins.maxQueuedEventsPerPlugin` | `100` | Observer queue depth |
| `plugins.scrubEventPayloads` | `true` | Scrub secrets from payloads |
| `plugins.requireHashPin` | `true` | Kept for compatibility. `false` is ignored with a warning: the pin is always on |

The old array form (`plugins: [{ package, enabled, config }]`) is still accepted
and means "off". npm packages are never loaded.

A config hot reload does not change which plugins are loaded; use `/plugins`
commands or restart Kirie.

## Files

| Path | What |
|---|---|
| `~/.kirie/plugins/<name>/` | Your plugins. Kirie only reads here |
| `~/.kirie/state/plugin-approvals.json` | Approval records `{ name, version, sha256, capabilities, events, enabled, approvedAt, approvedBy }`, 0600, written atomically, only by `/plugins` |
| `~/.kirie/state/plugin-approvals.json.seal` | SHA-256 of the approvals file as `/plugins` last wrote it. At start, a file that does not match is not trusted |
| `~/.kirie/state/plugin-cache/` | Verified private copies that are actually imported (0700). Safe to delete; it is rebuilt on the next load |
| `~/.kirie/logs/audit.jsonl` | Audit records, feature `plugins`: `plugin.approved`, `plugin.loaded`, `plugin.load_failed`, `plugin.hash_mismatch`, `plugin.load_refused`, `plugin.suspended`, `plugin.disabled`, `plugin.reload`, `plugin.unloaded`, `plugin.approve_refused`, `approvals.changed_externally`, `approvals.unsealed`; feature `settings` for the master switch |

## Limits worth knowing

- `afterToolUse` needs a hook that is installed when an agent session starts.
  When you turn plugins on at runtime, Kirie restarts idle chat sessions so
  their next turn has it; a session that is busy at that moment gets it after
  its next restart. `beforeToolUse` works at once.
- `plugins_list` (the agent's read-only tool) shows approval state and whether
  files changed, but not the master switch or live failure counts; `/plugins`
  shows those.
- No plugin MCP tools and no plugin channel adapters, by design for now.
