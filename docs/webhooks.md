# Webhook triggers

Kirie can receive signed webhooks from GitHub, Sentry, Prometheus Alertmanager or any system you control, and tell you about them in your DM. By default a delivery becomes a short message built from the payload fields, with **no model call**. You can also have a model summarize it or investigate it with read-only tools.

Webhooks are **off by default**. Nothing listens on a public port until you turn them on and enable at least one hook.

## How it fits together

```
provider --HTTPS--> Cloudflare --tunnel--> cloudflared --> 127.0.0.1:18787  (public ingress, POST /hooks/<id> only)
                                                           127.0.0.1:18789  (control plane: never tunnel this)
```

- The public ingress is a separate listener on `127.0.0.1:18787` (`ingress.port`). It always binds loopback; there is no setting that binds another address.
- It answers `GET /healthz` (`ok`) and `POST /hooks/<id>`. Every other path returns 404. Nothing from the control plane (`/status`, `/restart`, `/api/*`, ...) is reachable through it.
- The control plane on 18789 rejects any `Host` header that is not loopback, so a tunnel pointed at it by mistake gets 403. Still: **never point a tunnel at 18789.**
- The old `/webhooks/<path>` route on 18789 is gone.

## Quick start

All `/webhook` commands are owner-only and work only in your DM with the bot.

1. Create the tunnel (below) and set `ingress.publicBaseUrl` in `~/.kirie/config.yaml`, then restart Kirie.
2. `/webhook add deploys github events=workflow_run -- Tell me only when a deploy fails, with the failing job.`
   Kirie creates the hook **disabled**, generates a 256-bit secret, and writes it to `~/.kirie/secrets/webhook-<id>.txt` (mode 0600). The file is deleted after 10 minutes. Copy it with `pbcopy < ~/.kirie/secrets/webhook-<id>.txt`. The secret is never sent in chat.
3. Configure the provider with the URL and the secret (the reply has the steps).
4. `/webhook test <id>` signs a sample payload with the real secret and runs it through the real ingress code in process. Nothing is stored and nothing runs; the reply shows each stage and the rendered message or prompt.
5. `/webhook enable <id>` and `/webhook on`. The listener binds now.
6. `/webhook test <id> run` performs the action once, end to end.

## Commands

| Command | What it does |
|---|---|
| `/webhook` or `/webhook status` | On or off, listener, public URL, tunnel `/healthz` check, hook count, deliveries and refusals in the last 24 h |
| `/webhook list` | Every hook: id, source, enabled, action, events, verified, last delivery. Never secrets |
| `/webhook add <name> <github\|sentry\|alertmanager\|generic\|bearer> [events=a,b] [action=notify\|task] [tools=summarize\|investigate] [fields=a.b,c] [-- instructions]` | Create a disabled hook and write its secret to a 0600 file |
| `/webhook show <id>` | The full definition (no secret) and provider setup steps |
| `/webhook set <id> key=value ... [-- instructions]` | Keys: `events` (`all` clears), `action`, `tools`, `fields` (`default` clears), `ip` (CIDRs, `any` clears), `rate` (per minute), `daily`, `raw` (`on`/`off`: include the raw payload in prompts), `instructions` |
| `/webhook enable <id>`, `/webhook disable <id>` | Accept or refuse deliveries for one hook |
| `/webhook remove <id>` | Asks to confirm, then deletes the hook and its secret. Its delivery log stays for the retention period |
| `/webhook test <id> [run]` | Dry run (default) or one real run through the ingress, in process |
| `/webhook rotate-secret <id> [grace=<minutes>] [from-file]` | New secret. With `grace` (up to 60) the old one keeps working that long. `from-file` imports a secret the provider generated (see Sentry) |
| `/webhook secret <id>` | Write the current secret to the 0600 file again |
| `/webhook log [id] [n]` | Recent deliveries, and sampled refusals with their reason |
| `/webhook forget <delivery>` | Drop one delivery's replay row, so the provider's "redeliver" of the same body is accepted again |
| `/webhook on`, `/webhook off` | Global switch (a runtime override of `webhooks.enabled`). Off unmounts `/hooks`; the listener closes when nothing else uses it |

The agent has two read-only tools, `webhook_list` and `webhook_deliveries`. It cannot create, change, enable, rotate or reveal a hook. If you ask it to set one up, it should tell you the `/webhook add` line to send.

## What a delivery does

| Hook setting | What happens | Model | Tools |
|---|---|---|---|
| `action=notify` (default) | A message built from the payload's fields (`fields=`, or the source's defaults) | none | none |
| `action=task tools=summarize` (default for tasks) | One model call turns the event into a short message | `proactive.tier2Model` | none |
| `action=task tools=investigate` | A background task that may read local files and Kirie's memory and chat history, then reports | the agent model | `Read`, `Grep`, `Glob`, `memory_search`, `memory_recall`, `memory_semantic_search`, `memory_list`, `chat_history_search` |
| `action=task tools=full` | A background task with every tool Kirie has | the agent model | all |

`full` needs **two** opt-ins: `webhooks.allowFullProfile: true` in `config.yaml`, and `/webhook set <id> tools=full`, which asks you to confirm. If either is withdrawn later, deliveries fall back to `summarize`. Webhook tasks run with the SDK call kind `webhook`, so the approvals gate can treat them as unattended.

The result always goes to the DM the hook was created from. Nothing in a payload can choose the recipient. Every webhook message is sent with link previews disabled (Telegram `link_preview_options.is_disabled`), because a chat client that previews a link fetches it: an injected task could otherwise put file contents into a URL that Telegram fetches for the preview. As a second layer, reports from `investigate` and `full` tasks have their links defanged (`https[:]//host[.]example/...`): any `scheme://`, bare schemes such as `mailto:` and `tg:`, ASCII, non-ASCII (IDN) and punycode host names, and IPv4 and IPv6 addresses.

### The payload is untrusted

A valid signature proves who sent the request, not that its content is safe. Kirie therefore:

- never parses payload text as a command and never treats it as coming from you;
- keeps your instructions separate: payload values are never inserted into them;
- puts the fields and the raw payload in `untrusted_fields` / `untrusted_payload` blocks with a random per-delivery boundary, escapes every `<` in payload text (so a payload cannot close the block), strips control, zero-width and bidi characters, caps each field (`maxFieldChars`, 500) and the raw block (`maxPayloadChars`, 8000);
- redacts secrets in the payload before it reaches a message or a prompt;
- checks the payload for instruction-like text. With `webhooks.onSuspiciousPayload: downgrade` (default) such a delivery is summarized with no tools and the message starts with a warning; `drop` sends only the field message with a warning; `proceed` does nothing special.

## Sources and signatures

The source is pinned per hook: a request is only checked against its own hook's scheme. All checks run over the raw body bytes with constant-time comparison.

| Source | Headers | Signed bytes | Replay key |
|---|---|---|---|
| `github` | `X-Hub-Signature-256: sha256=<hex>` (the SHA-1 header is ignored) | raw body | hook + SHA-256 of the body |
| `sentry` | `Sentry-Hook-Signature: <hex>` | raw body; if that fails, the re-serialised JSON (Sentry's documented example). Needs one real delivery to confirm which | hook + SHA-256 of the re-serialised JSON, so a whitespace edit of a captured delivery is still a duplicate |
| `generic` | `X-Kirie-Timestamp: <unix seconds>`, `X-Kirie-Signature: v1=<hex>`, optional `X-Kirie-Event`, `X-Kirie-Delivery` | `v1:<timestamp>:<raw body>`; the timestamp must be within `timestampToleranceSeconds` (300) | the verified signature |
| `alertmanager` | `Authorization: Bearer <secret>` | none | hook + SHA-256 of the body |
| `bearer` | `Authorization: Bearer <secret>` or `X-Kirie-Token` | none | hook + SHA-256 of the body |

Signing a generic delivery, for your own scripts:

```sh
ts=$(date +%s)
body='{"event":"backup.finished","title":"Nightly backup","status":"ok"}'
sig=$(printf 'v1:%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$(cat ~/.kirie/secrets/webhook-<id>.txt)" -hex | sed 's/^.* //')
curl -sS https://hooks.example.com/hooks/<id> -H 'Content-Type: application/json' \
  -H "X-Kirie-Timestamp: $ts" -H "X-Kirie-Signature: v1=$sig" --data "$body"
```

Provider notes:

- **GitHub**: set Content type to `application/json` (form encoding fails verification and shows up in `/webhook log`). GitHub's first request is a ping; Kirie answers `pong`, marks the hook verified and tells you. Events: `events=workflow_run`, `events=issues,pull_request`. An entry also matches its sub-events (`issues` matches `issues.opened`).
- **Sentry**: Sentry generates its own client secret. Create the hook with `/webhook add <name> sentry`, write Sentry's secret to `~/.kirie/secrets/webhook-<id>.import`, `chmod 600` it, then `/webhook rotate-secret <id> from-file`. Kirie imports it into the credential store and deletes the file. Never paste it into a chat.
- **Alertmanager**: it cannot sign bodies, so it uses a bearer token (`http_config.authorization` with `credentials_file`). Anyone holding the token can send any body; keep such hooks on `action=notify`.

## Responses

| Response | When |
|---|---|
| `202 {"status":"accepted","delivery":N}` | Accepted; the action runs in the background |
| `200 {"status":"duplicate"}` | Same delivery seen before (persisted replay cache: the log row is kept 30 days, the replay key a year) |
| `200 {"status":"pong"}` / `{"status":"ignored"}` | Provider ping / event not in the hook's filter |
| `404 {"status":"not_found"}` | Unknown hook, disabled hook, secret unavailable, IP not allowed, missing or bad signature, stale timestamp. Byte-identical in every case, so the response says nothing about which |
| `429` | Too many requests: per client IP (60/min) and global (300/min) before authentication; per hook (10/min), per day (100) and task queue after |
| `411` / `413` / `400` | No `Content-Length` / body over `maxBodyBytes` (512 KB) / authenticated body that is not JSON |

No response contains payload data, hook names, model output or error text. The reason for a refusal is visible to you only, in `/webhook log` (sampled) and the audit trail. Many refusals in an hour (`authFailureAlertThreshold`, 20) produce one message to you.

## Secrets

- Generated by Kirie (32 random bytes, base64url) and stored only in the encrypted credential store as `webhook.<id>.secret` (`~/.kirie/credentials`, 0600). Never in `config.yaml`, never in `webhooks.db`, never in a log line, a tool result or a chat message. Outbound messages are scrubbed of every loaded hook secret.
- Delivered to you as a 0600 file under `~/.kirie/secrets/` that is removed after 10 minutes, or at daemon stop, whichever comes first; a file a crashed process left behind is removed at the next start. `secretDelivery: chat` is accepted in the config but treated as `file`.
- Each secret is decrypted once at start (one PBKDF2 per hook, a few hundred ms each). If the credential store cannot be read, that hook answers 404 and you are told once.
- Rotation: `/webhook rotate-secret <id> grace=10` keeps the old secret valid for 10 minutes while you update the provider.

## Source IP allowlist (defense in depth only)

`/webhook set <id> ip=192.30.252.0/22,2001:db8::/32` refuses other addresses with the same 404. Behind cloudflared every connection comes from `127.0.0.1`, so the client address is read from the `CF-Connecting-IP` header (`ingress.trustedIpHeader`). If you set a list-valued header such as `x-forwarded-for`, Kirie uses its last entry (the hop the nearest proxy added), never the client-supplied first one. That header is only as trustworthy as the loopback bind: **any process on this Mac can connect to 127.0.0.1:18787 and set it to anything.** The allowlist narrows what reaches the signature check; the HMAC is the authentication. For real source filtering, add a Cloudflare WAF rule at the edge (below).

## cloudflared tunnel (manual setup)

Kirie never starts, stops or configures cloudflared. Pick a hostname in a zone you control, then:

1. Create a named tunnel (cloudflared is already logged in on this Mac):
   ```sh
   cloudflared tunnel create kirie-hooks
   ```
   Note the tunnel UUID it prints; the credentials file is `~/.cloudflared/<tunnel-uuid>.json`.
2. Route the hostname to it:
   ```sh
   cloudflared tunnel route dns kirie-hooks hooks.<your-zone>
   ```
3. Write `~/.cloudflared/kirie-hooks.yml`. Only `/hooks/<id>` (and `/voice/...` if you use phone calls) reach the ingress; everything else is answered 404 by Cloudflare:
   ```yaml
   tunnel: <tunnel-uuid>
   credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json
   ingress:
     - hostname: hooks.<your-zone>
       path: ^/(hooks|voice)/
       service: http://127.0.0.1:18787
     - service: http_status:404
   ```
   The service must be `127.0.0.1:18787`. Never `18789`.
4. Run it at login with a LaunchAgent, e.g. `~/Library/LaunchAgents/com.codingjet.kirie-hooks-tunnel.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.codingjet.kirie-hooks-tunnel</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/cloudflared</string>
       <string>tunnel</string>
       <string>--config</string>
       <string>/Users/<you>/.cloudflared/kirie-hooks.yml</string>
       <string>run</string>
     </array>
     <key>RunAtLoad</key><true/>
     <key>KeepAlive</key><true/>
   </dict>
   </plist>
   ```
   Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codingjet.kirie-hooks-tunnel.plist`.
5. Set the public URL and restart Kirie:
   ```yaml
   ingress:
     publicBaseUrl: "https://hooks.<your-zone>"
   ```
6. `/webhook on`, enable a hook, then `/webhook status`: it reports whether `https://hooks.<your-zone>/healthz` answers.
7. Optional edge hardening: a Cloudflare WAF custom rule that blocks requests to `hooks.<your-zone>` unless the method is `POST` (or the path is `/healthz`), and, for GitHub-only hooks, unless the source is in GitHub's published hook ranges (`https://api.github.com/meta`, key `hooks`).

Quick tunnels (`cloudflared tunnel --url http://127.0.0.1:18787`, a `trycloudflare.com` URL) work for a test but the URL changes on every start, so providers break; do not use them for real hooks.

## Config

```yaml
ingress:
  port: 18787                      # loopback only; bound only while something is mounted
  publicBaseUrl: "https://hooks.example.com"
  trustedIpHeader: "cf-connecting-ip"   # "" to ignore client IP headers
webhooks:
  enabled: false                   # /webhook on|off overrides this at runtime
  maxBodyBytes: 524288
  timestampToleranceSeconds: 300
  deliveryRetentionDays: 30
  rateLimit: { perIpPerMinute: 60, globalPerMinute: 300, perHookPerMinute: 10, perHookPerDay: 100 }
  maxConcurrentTasks: 2            # model calls and webhook tasks running at once
  maxQueuedTasks: 20
  defaultAction: notify
  defaultToolProfile: summarize    # summarize | investigate
  allowFullProfile: false          # first of two keys for tools=full
  onSuspiciousPayload: downgrade   # downgrade | drop | proceed
  maxFieldChars: 500
  maxPayloadChars: 8000
  authFailureAlertThreshold: 20
```

Hook definitions live in `~/.kirie/webhooks.db` (0600), not in YAML.

## Delivery semantics and limits

- **At most once.** The replay row is written before any action. A restart between accepting and finishing a delivery marks it `failed` (you are told); it is not re-run. Use the provider's redeliver button after `/webhook forget <delivery>` if you want it again. Payload bodies are not stored, so Kirie cannot replay one itself.
- A delivery refused by a post-auth limit (`429 throttled`) can be retried by the provider and is accepted once the limit allows.
- A webhook task that is cancelled (by you or by the agent) frees its slot within 30 seconds.
- Residual risks: bearer hooks have no body integrity; a GitHub, Sentry or bearer delivery replayed more than a year later would be accepted again (no signed timestamp); a refused request to a Sentry hook costs a little more work than one to an unknown id, a small timing difference (ids carry 32 random bits, so they cannot be enumerated anyway); an `investigate` task can read any file your user can read and its report reaches your chat; with `full` an external system can start a task with every tool, so keep it for sources you control.
