# Self-hosted Telegram Bot API server (2 GB downloads)

Telegram's cloud Bot API (`api.telegram.org`) refuses `getFile` for anything over
**20 MB** (`400: Bad Request: file is too big`). A self-hosted
[`telegram-bot-api`](https://github.com/tdlib/telegram-bot-api) server running
with `--local` lifts that to **2 GB** and hands back an absolute file path on
disk instead of a download URL. Kirie's Telegram adapter handles both.

Even without the local server, an attachment that fails to download is never
dropped silently: the agent receives a note such as
`[📎 Video attached but could NOT be downloaded: file is too big (Telegram bot limit 20 MB). File: IMG_4021.MOV, 48.0 MB. ...]`.

## Pieces

| What | Where |
|------|-------|
| Server binary | `~/.local/bin/telegram-bot-api` (built from source, see below) |
| Credentials | `~/.kirie/secrets/telegram-bot-api.env` (chmod 600): `TELEGRAM_API_ID=...` and `TELEGRAM_API_HASH=...` from https://my.telegram.org → API development tools |
| Launcher | `~/.kirie/telegram-bot-api.sh` (sources the env file; the server reads both vars from the environment, so the hash never shows up in `ps`) |
| launchd job | `~/Library/LaunchAgents/com.codingjet.telegram-bot-api.plist` (label `com.codingjet.telegram-bot-api`) |
| Data / downloaded files | `~/.kirie/telegram-bot-api/` |
| Logs | `~/.kirie/logs/telegram-bot-api.log` (+ `.out.log` / `.err.log` from launchd) |

The server listens on `127.0.0.1:8081` only.

## Build (macOS)

```bash
brew install gperf cmake openssl
git clone --recursive https://github.com/tdlib/telegram-bot-api.git ~/src/telegram-bot-api
cd ~/src/telegram-bot-api && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR="$(brew --prefix openssl@3)" \
      -DCMAKE_INSTALL_PREFIX:PATH="$HOME/.local" ..
cmake --build . --target install -j 6
~/.local/bin/telegram-bot-api --version
```

## Activation

1. **Credentials.** Create an app at https://my.telegram.org, put `TELEGRAM_API_ID` and
   `TELEGRAM_API_HASH` in `~/.kirie/secrets/telegram-bot-api.env`, `chmod 600` it.
2. **Smoke test** (optional): run `~/.kirie/telegram-bot-api.sh` in a terminal and call
   `curl -s http://127.0.0.1:8081/bot<TOKEN>/getMe`. Stop it afterwards.
3. **Log the bot out of the cloud API, once.** Mandatory before moving a bot to a
   local server, otherwise updates may keep going to the cloud server:
   ```bash
   curl -s https://api.telegram.org/bot<TOKEN>/logOut   # -> {"ok":true,"result":true}
   ```
   After this, the bot **cannot log back in to the cloud API for 10 minutes**.
4. **Start the server under launchd:**
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codingjet.telegram-bot-api.plist
   lsof -nP -iTCP:8081 -sTCP:LISTEN
   ```
5. **Point Kirie at it** in `~/.kirie/config.yaml`:
   ```yaml
   channels:
     telegram:
       apiRoot: http://127.0.0.1:8081
   ```
6. **Restart Kirie for real:** `launchctl kickstart -k gui/$(id -u)/com.codingjet.kirie`, then
   `curl -s http://127.0.0.1:18789/status` should show Telegram `connected`.

## Switching back to the cloud API

1. Remove `apiRoot` from the config.
2. Optionally call `logOut` on the local server (`curl -s http://127.0.0.1:8081/bot<TOKEN>/logOut`),
   then `launchctl bootout gui/$(id -u)/com.codingjet.telegram-bot-api`.
3. Restart Kirie. If the cloud `logOut` happened less than **10 minutes** ago, cloud
   calls fail until the lockout expires; Kirie's channel health monitor keeps
   retrying, so it reconnects on its own once the window passes.

## Housekeeping

In `--local` mode the server keeps every downloaded file under
`~/.kirie/telegram-bot-api/<bot-token>/`. Kirie copies what it needs into
`~/.kirie/media/`, so old files there can be pruned, e.g.
`find ~/.kirie/telegram-bot-api -type f -path '*/videos/*' -mtime +7 -delete`.
