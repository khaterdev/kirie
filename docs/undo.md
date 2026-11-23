# Undo file changes

`/undo` reverts the file edits Kirie made in its last turn (or last few turns), using the Claude Agent SDK's file checkpoints. It restores files to their content from before the turn and deletes files the turn created. The conversation itself is not rewound.

Undo is **off by default**. It needs `agent.sessionMode: v2` (the default). In v1 mode `/undo` answers "Undo needs agent.sessionMode v2."

## Turning it on

```
/undo on
```

or in `config.yaml`:

```yaml
undo:
  enabled: true
```

Only turns that run **after** undo is on can be undone. `/undo on` and `/undo off` close idle sessions, so the next turn starts with checkpointing on or off. A session that is busy at that moment keeps its old setting until it closes. `/undo reset` drops the on/off override and goes back to the config value.

## Commands

All are owner-only and work in your DM with Kirie.

| Command | What it does |
|---|---|
| `/undo` | Previews undoing the file edits of the last turn, then asks you to Confirm or Cancel |
| `/undo <n>` | The same for the last `n` turns that edited files (at most `undo.maxTurnsPerUndo`, default 5) |
| `/undo preview [n]` | Only shows what an undo would do |
| `/undo list` | Recent turns: time, prompt, files, shell commands, undone or not |
| `/undo task <id>` | Undoes a finished background task's file edits |
| `/undo on`, `off`, `reset` | Turns undo on or off, or back to the config value |
| `/undo help` | What undo covers and what it does not |

The preview lists the files that will be restored, the files that will be deleted (created in that turn, so no earlier version exists), and a "Not reverted" line for the shell commands that ran. Nothing changes until you press Confirm. The preview expires after `undo.confirmTimeoutSeconds` (default 120 s).

After an undo, the chat history gets a note, and Kirie's next turn is told which files were reverted, so it re-reads a file before editing it again.

## What can be undone

- Files Kirie changed with its file tools: `Write`, `Edit`, `MultiEdit` and `NotebookEdit`. They go back to their content from before the turn.
- Files those tools created in the turn. They are deleted.
- With `undo.backgroundTasks: true` (the default), a finished background task's file edits, through `/undo task <id>`.

## What cannot be undone

- **Anything done through Bash**: deletes, moves, `sed -i`, redirects, `git commit`, `git reset`, `git push`, installs and builds. Much of Kirie's work goes through Bash, so read the "Not reverted" line of every preview.
- Anything outside this computer: remote hosts, Kubernetes, pushed commits, sent messages.
- Effects of MCP tools: memories, schedules, daily notes and channel actions.
- Creating, deleting or moving directories.
- Files reached through symlinks or hard links. The preview reports them as skipped.
- Edits made by subagents, when the SDK did not track them. The preview names them.
- Turns from before undo was on, and turns whose backups Claude Code has already cleaned up.
- Several turns at once when they span an account switch or a `/clear`. Undo them one at a time, newest first.
- A background task's edits from the chat's `/undo`. Use `/undo task <id>`.

Edits that you or another agent made to the same files after Kirie's turn are overwritten. The preview warns when a file has changed since the turn.

## Safety

- There is no agent tool for undo, and no HTTP route. Only your own `/undo` command, followed by your Confirm, can trigger a rewind.
- An undo is refused while a turn is running in that chat. While the preview and the rewind run, the chat is held: new messages wait and run after it finishes, and scheduled and loop messages retry later.
- A task undo is refused while the task is pending or running.
- Previews and replies are scrubbed for secrets.

## Where the data lives

- `~/.kirie/checkpoints.db` (mode 0600) keeps a small ledger per turn: paths, prompt previews and shell command samples (scrubbed). It never stores file contents. Rows are pruned after `undo.retentionDays` (default 14) and beyond `undo.maxTurnsPerSession` (default 50) per session.
- The file backups themselves are Claude Code's, under `<config dir>/file-history/` of the account that ran the turn. They hold full copies of edited files, which can include secrets such as `.env` contents, the same as in any Claude Code session.

## Config keys

```yaml
undo:
  enabled: false            # record per-turn file checkpoints and allow /undo
  backgroundTasks: true     # also checkpoint background tasks
  maxTurnsPerSession: 50    # ledger rows kept per session
  retentionDays: 14         # ledger rows older than this are pruned
  confirmTimeoutSeconds: 120
  maxTurnsPerUndo: 5        # largest number of turns one /undo may cover
```
