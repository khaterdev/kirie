# Sandboxed execution

Kirie can run the agent's shell commands in one of three places. You choose with the owner-only Telegram command `/sandbox` (in your DM with the bot). The choice is stored in `~/.kirie/state/runtime-settings.json`; `config.yaml` is never rewritten.

| Mode | Where shell commands run | Host tools (kubectl, gh, git with your keys, pnpm in your repos) | Needs |
|---|---|---|---|
| `off` (default) | directly on this Mac, as before | yes | nothing |
| `native` | on this Mac, inside the macOS sandbox (Seatbelt) | yes, but writes only in allowed folders | nothing (passes a self-test first) |
| `docker` | inside an isolated Linux container | no | Docker Desktop running and the image built once |

## Why the default is `off`

- **Kirie's value is acting on your Mac.** Every day it runs `kubectl` against the cluster, `git` and `gh` with your credentials, `pnpm` in local repositories, `launchctl`. A container sees none of that, so docker mode by default would break most real tasks.
- **Docker mode needs the Docker Desktop VM.** Kirie starts from launchd at login, often before Docker Desktop is up. Docker mode fails closed (no shell at all while the container is down), so "docker by default" would mean "no shell" after every login until the VM is ready.
- **Native mode restricts writes you may expect to work.** With native on, a command that writes outside Kirie's workspace (`~/.kirie`), `/tmp` and the folders you allow fails with "Operation not permitted" until you add the folder with `/sandbox allow-write`. Tools that keep state in your home directory (`~/.kube/cache`, `~/.npm`, `~/Library/pnpm`, `~/.cache`) need their folder allowed too.
- Risky or behaviour-changing capabilities in Kirie ship off, with a switch you control.

Recommended path: `/sandbox native`, then `/sandbox allow-write ~/dev` (and the two or three project roots you use), live with it for a few days, and pair it with `/approvals mode ask`. Use `/sandbox docker` for untrusted work.

## Commands

| Command | What it does |
|---|---|
| `/sandbox` | Mode, readiness, what is writable, network policy, what is never sandboxed |
| `/sandbox off` | Run on this Mac again. Asks you to confirm first |
| `/sandbox native` | Runs a short self-test (one turn on the utility model, about one cent), then switches |
| `/sandbox docker` | Checks the Docker binary, the daemon, the image, the workspace and the container (with its own self-test), then switches |
| `/sandbox allow-write <path>` | Let native mode write in a folder (for example `~/dev`). Refuses `/`, your home directory, system folders, protected paths and folders that contain them (`~/Library`, `~/.config`) |
| `/sandbox disallow-write <path>` | Remove a folder you added (entries from `config.yaml` stay; remove them there) |
| `/sandbox recreate` | Remove and rebuild the docker container, then run its self-test |
| `/sandbox reset` | Drop every override made with `/sandbox`; asks to confirm if the mode changes |

A switch restarts idle chat sessions at once, so the next message gets the new mode and continues the same conversation. A chat that is busy restarts after its current turn. **Running background tasks keep the mode they started with**; the path guard still applies the stricter of the two modes to their file tools, and a task started before a switch to docker loses its host shell immediately.

No MCP tool and no HTTP route can change the mode, the write list or the container. The agent can only read the state with the `sandbox_status` tool.

## Native mode

Uses the Claude Agent SDK's own sandbox (`Options.sandbox`, Seatbelt on macOS) for every command Bash spawns, subagents included. Verified to work when Kirie runs under launchd (experiment E6).

- **Writable:** the agent's working directory (`~/.kirie`), `/tmp`, `/private/tmp`, `~/.kirie/media`, and the folders you allow. `/tmp` is listed on purpose: outside the working directory it is not writable by default, and many tools write to `/tmp` directly.
- **Never writable,** even though they sit inside the working directory: Kirie's `config.yaml` (and its backups), `state/`, `secrets/`, `credentials/`, its databases, plugins, `scripts/`, `node_modules/`, `kokoro-daemon/`, `telegram-bot-api/`, `backups/`, top-level `*.py`/`*.js`/`*.mjs`/`*.sh`, `USER.md`, the audit log, `.mcp.json`, the whole `.claude/` folder, plus the approval gate's protected list (`~/.ssh`, `~/.kube`, `~/.aws`, shell rc files, `~/Library/LaunchAgents`, `/etc`, `.git/hooks`, `.git/config`, `.env` files, ...).
- **Not readable by Bash:** Kirie's secrets, credentials, `state/`, `backups/`, `telegram-bot-api/` (its folder names carry the bot token) and `config.yaml` with its backups, private SSH keys, `~/.kube/config`, `~/.aws/credentials`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`, Claude credentials, the Keychain folder, `.env` files. **This means `kubectl`, `aws`, and `git` over SSH with key files do not work in native mode**; run those with the sandbox off, or list them in `sandbox.native.excludedCommands` (they then run outside the sandbox; not verified live).
- **Network:** open, unless you list domains in `sandbox.native.allowedDomains` (then only those). Unix sockets are blocked unless listed in `sandbox.native.allowUnixSockets`. Never list the Docker socket: a sandboxed command could then start a container with your disk mounted (`/sandbox` and the security audit warn about it).
- **No escape hatch:** `failIfUnavailable: true` (if the sandbox cannot start, the query fails instead of running unsandboxed) and `allowUnsandboxedCommands: false` (the model's `dangerouslyDisableSandbox` flag is ignored, and Kirie's gate denies calls that set it). `sandbox.native.allowUnsandboxed: true` turns the hatch back on; the audit flags it.
- **File tools** (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep`, `Glob`) are not covered by the SDK sandbox. Kirie's `sandbox-path-guard` gate holds them to the same folders and the same protected lists. A path with a `..` component is refused outright (a tool may apply `..` before opening while the kernel applies it after symlinks, so no single check is safe); other paths are resolved with every symlink followed, so a link out of an allowed folder is caught.
- `Monitor` (a tool that runs shell commands) and `PowerShell` are denied in native mode: the SDK sandbox is only documented for Bash.
- Adding an MCP server (`mcp_servers_add`) is denied in native and docker mode: the server's command would run on this Mac outside the sandbox.
- A background task or a busy session started before you switched to native keeps unsandboxed Bash until it ends (its options are fixed when it starts); file tools follow the new rules at once.
- The SDK creates a `.claude/` folder in the working directory when the sandbox is on. That is expected.

### The native self-test

`/sandbox native` first runs one utility turn with the real native settings in a fresh folder under `~/.kirie/tmp/sandbox-probe/`. The model is asked to run one fixed command with five `touch` calls; the result is read from the disk, never from the model's answer:

| Write | Must |
|---|---|
| inside the working folder | succeed |
| outside it | fail |
| into a denied folder | fail |
| into the denied folder through a different letter case (`PROTECTED/`) | fail |
| through a symlink pointing outside | fail |

If anything differs, the switch is refused with the reason. The probe folder is deleted afterwards. With `/approvals scope all`, the probe's command asks you first like every other command; approve it within three minutes.

## Docker mode

Shell commands run in one long-lived container, `kirie-sandbox-shared`, through the MCP tool `mcp__kirie-tools__sandbox_bash` (same input as Bash). Built-in `Bash`, `Monitor` and `PowerShell` are removed from every session (`disallowedTools`), and `Bash` is aliased to the MCP tool. Experiment E5 showed that subagents inherit this and get the container shell too. The alias redirect of a literal `Bash` call was never observed, so the gate also denies any call named `Bash` while docker mode is on; that is the binding control.

**Fails closed.** If the binary is missing, Docker is not running, the image is not built, the workspace cannot be mounted or the container fails its self-test, shell commands are disabled, the agent is told why, and you get one message. Nothing ever falls back to running on the host. Kirie checks the container every five minutes (every minute while it is down), recreates it when it is missing, and tells you when it is back.

### Setup (once)

1. Start Docker Desktop.
2. From the repository: `scripts/sandbox-setup.sh` (builds `kirie-sandbox:latest` from `Dockerfile.sandbox`; Kirie never pulls the image from a registry).
3. In your DM: `/sandbox docker`.

The docker binary is taken from `sandbox.docker.binary`, else the first of `/usr/local/bin/docker`, `/opt/homebrew/bin/docker`, `/Applications/Docker.app/Contents/Resources/bin/docker`. `PATH` is never used (launchd's PATH often lacks `/usr/local/bin`).

### What the container gets

`docker create` always includes:

- `--user <your uid>:<gid>` (not root), `--init`, `--read-only` root filesystem, `--cap-drop ALL`, `--security-opt no-new-privileges`
- `--pids-limit` (256), `--memory` (1g), `--cpus` (2), a size-capped `/tmp` tmpfs (256 MB, executable, `nosuid,nodev`)
- `--network none` (or `bridge` if you set `sandbox.docker.network: bridge`; `host` is rejected by the config schema)
- exactly one bind mount: the workspace (`sandbox.docker.workspaceDir`, default `~/.kirie/sandbox-workspace`, created 0700) at the **same absolute path** inside, so paths mean the same thing on both sides
- `HOME=/tmp` and no other environment variable; `docker exec` never passes `-e`, and the docker client itself runs with a minimal environment, so no secret the daemon holds reaches the container

Never mounted, whatever the config says: `/`, your home directory or any folder containing it, `~/.kirie` itself, the agent's working directory or any folder containing it, `.claude/`, `.mcp.json` and `skills/` in the working and data directories (the SDK loads settings, hooks and MCP servers from them), `~/.kirie/secrets`, `credentials`, `state`, `config.yaml`, `~/.ssh`, `~/.claude*`, `~/.kube`, `~/.docker`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/Library`, `/var/run/docker.sock`, system folders. The check runs on the path as written and with symlinks resolved, so a workspace symlinked to `~/.ssh` is refused. `sandbox.docker.readOnlyRoot: false` and a `capDrop` without `ALL` are ignored.

A container found by name is never adopted: the first time a Kirie process needs the container it removes anything called `kirie-sandbox-shared` and creates a fresh one (something with Docker access could have planted a weaker container with the same name and labels), then addresses it only by its id, for health checks, the self-test and every command. A container whose configuration changed (image, limits, network, mount, user) is never reused either. `docker create` runs with `--pull never`, and the image name must be a plain reference (a value starting with `-` is refused). Containers labelled `kirie.sandbox=1` left over from earlier runs are removed. With `stopOnShutdown: true` (default) the container is removed when Kirie stops.

The container self-test checks: not root, the workspace writable inside and the file visible on the host, the root filesystem read-only, and with `network: none` no interface but `lo`.

### Each command

`docker exec -i -w <workspace> kirie-sandbox-shared timeout -k 5 <secs> bash -lc <command>`, started without a shell; the command is one argument. The `timeout` inside the container is what stops the process (killing the docker client would not). Default 120 s (`sandbox.docker.execTimeoutSeconds`), maximum 600 s. Output is capped at 30,000 characters, keeping the start and the end. `run_in_background` is refused.

### File tools in docker mode

Built-in file tools run on the host, so the gate confines them. The container can create or swap symlinks in the workspace at any time, so no host file tool follows a symlink inside it (checked on every call; a swap in the instant between the check and the open is still possible, so treat this as best effort and prefer the shell tool inside the container). Writes only inside the workspace; reads only inside the workspace, `~/.kirie/media` (incoming attachments) and `sandbox.docker.readPaths`. `Grep`/`Glob` without a path default to `~/.kirie` and are denied; the agent passes the workspace as the path.

## What is never sandboxed

Say this to yourself before you rely on a mode:

- **MCP tools.** Kirie's own `kirie-tools` (messaging, browser, web fetch, memory, schedules) and every external MCP server run on this Mac in every mode.
- **Files produced in docker mode land on your Mac** through the workspace mount. Anything the agent writes there could later be run by you or by the agent in `off` or `native` mode. Treat the workspace as untrusted.
- Approvals still apply in every mode: the approval gate sees every sandboxed command with the same classifier, the hardline list and your deny list included. In docker mode with `network: none` (and only while the container is healthy) the gate skips its other dangerous-command rules for `sandbox_bash`, because the container is the boundary.
- Skills or hooks configured in `~/.claude` that run commands are outside Kirie's control.
- Undo (file checkpoints) cannot see changes made inside the container.

## Config keys

```yaml
sandbox:
  mode: "off"                  # off | native | docker; /sandbox overrides it
  native:
    allowWrite: []             # folders writable in native mode (plus /sandbox allow-write additions)
    allowedDomains: []         # empty = network unrestricted
    allowUnixSockets: []
    excludedCommands: []       # command patterns that run OUTSIDE the sandbox
    allowUnsandboxed: false    # true lets the model opt out per command
  docker:
    binary: /usr/local/bin/docker   # optional
    image: "kirie-sandbox:latest"
    workspaceDir: "~/.kirie/sandbox-workspace"
    readPaths: []              # extra folders host file tools may read in docker mode
    network: "none"            # none | bridge
    memory: "1g"
    cpus: 2
    pidsLimit: 256
    tmpfsSizeMb: 256
    execTimeoutSeconds: 120    # per command; max 600
    stopOnShutdown: true
```

`scope` accepts `shared`, `agent` and `session`; only `shared` (one container) is implemented, and the others are treated as shared with a warning in the log.

## Manual checks before recommending native mode

Not done by the implementation (no live run against real folders):

1. `/sandbox native` on the live daemon: the self-test passes.
2. A day of normal use with `~/dev` and the project roots allowed: `git commit`, `git push` over HTTPS, `gh pr list`, `pnpm install` inside an allowed folder. Expect `kubectl` and SSH-key git to fail (see above).
3. `/sandbox docker` with Docker Desktop running and the image built: `sandbox_bash` runs `id`, `ls`, `python3 -c 'print(1)'`; `curl example.com` fails with `network: none`; a subagent's shell also runs in the container.
4. Stop Docker Desktop while in docker mode: you get one message, shell commands are refused, nothing runs on the host; start it again: you get the "running again" message.
