# Approval gates

Kirie checks every tool call (from chats, background tasks, schedules, goals,
webhooks, and every subagent) with one classifier before it runs. You choose
how much it asks with `/approvals` in your DM.

## Modes

- **yolo** (default): nothing is asked. This is Kirie's behaviour from before
  the gate existed, with two exceptions that block in every mode:
  - the **hardline list**: catastrophic, irrecoverable commands only:
    recursive delete of `/`, your home folder, `/Users` or a system root
    (also `find <root> -delete`), disk formatting and raw device writes, fork
    bombs, recursive chmod/chown of those roots;
  - your own **deny list** (`/approvals deny <pattern>`), empty by default.

  `/approvals hardline off` (or `approvals.hardline: false` in config.yaml)
  turns the hardline list off and restores the exact old behaviour.
- **ask**: risky actions wait for your Approve or Deny on a card in your DM.
  - scope **dangerous** (default): only commands that match a dangerous rule,
    sensitive tools, protected paths, and commands Kirie cannot read with
    confidence ask.
  - scope **all**: everything that is not on your allow list asks.

No answer in `approvals.timeoutSeconds` (5 minutes) means deny. Only you can
answer, only in your own DM, only on the card that was sent (or with
`/approve <code>` / `/deny <code>`). Deny + stop also ends the agent's turn.

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
`bash -c` of computed text, here-documents fed to a shell, piped input run as
code, unbalanced quotes, invisible or direction-changing characters, very long
commands) are treated as **uncertain**: they ask in `ask` mode and run in
`yolo`. For an enforced boundary combine `ask` mode with the sandbox
(`/sandbox`).

The agent cannot change any of this: there is no tool or HTTP route that
approves, changes the mode or edits the lists (the `approval_status` tool only
reads the mode, scope and pending count), scheduled or injected text never
runs a command, and Kirie's own settings, config and state files are on the
protected-write list.
