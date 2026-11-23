# Voice calls (Twilio or Plivo)

Kirie can phone you (and allowlisted contacts) and, if you allow it, take calls from your own number. It works with **Twilio** or **Plivo**. Exactly one provider is active at a time.

**Status: built and tested with mocked provider APIs only. No real call has been placed on either provider.** Work through the [first-call checklist](#first-call-checklist) before you rely on it, and treat everything in [Not verified against a live account](#not-verified-against-a-live-account) as unknown until that checklist passes.

## What it does, and what it does not

- Turn-based calls over plain HTTPS webhooks. The provider does speech-to-text and text-to-speech; Kirie answers each spoken turn with markup (TwiML for Twilio, Plivo XML for Plivo). No WebSocket, no audio processing, no extra speech vendor keys.
- While the agent thinks, the caller hears "One moment." and a short silence loop. After `voice.limits.maxThinkSeconds` (default 60 s) Kirie says the answer will come on Telegram and keeps listening.
- Outbound:
  - `/call <alias> <message>` speaks a one-way message, captures one optional spoken reply, and reports it back to you in Telegram as an *unverified transcript*.
  - `/call me --talk [goal]` starts a spoken conversation with Kirie. This works only with your own number.
- Inbound is **off** by default (`inbound.mode: reject`). With `agent` mode, only your own number gets through, and only after a DTMF PIN. Anyone else is rejected, or leaves one voicemail that you get as quoted text. Voicemails and one-way replies never reach the agent: they are sent only to your DM, and the agent's call tools say only that a reply was captured, never what it says.
- Kirie records no audio. Your speech is processed by the provider and its speech vendors, and transcripts are stored in Kirie's chat history like any other chat.

## Off by default

With the default config nothing voice-related is constructed, registered, mounted or callable, and that includes the owner commands: `/voice` and `/call` exist only once `voice.enabled: true` is set in `config.yaml` and the daemon is restarted. Until then `/voice status` is not a command; it goes to the agent as ordinary text, and `/help` does not list it.

Once `voice.enabled: true` and the active provider is ready (the list below), voice is **active from boot**: there is no `/voice on` step. `/voice off` is the runtime switch that turns it off again (and `/voice on` turns it back on).

Even with `voice.enabled: true`, voice does nothing until:

1. The active provider has its credentials (see [Credentials](#credentials)).
2. `voice.<provider>.fromNumber` is the provider number in E.164 (`+14155550100`).
3. `ingress.publicBaseUrl` is an `https://` URL that reaches the public listener.
4. `voice.ownerNumbers` lists your phone number(s) in E.164.
5. If `inbound.mode: agent` with `requirePin: true` (the default), a 4 to 10 digit PIN exists.

If any of these is missing, the daemon starts normally and logs one line such as:

```
voice: enabled in config but NOT started on plivo, missing: plivo.authToken, ingress.publicBaseUrl. See docs/voice-setup.md
```

`/voice status` shows the same list for both providers. It never shows a credential or the PIN.

## Shared requirement: a public HTTPS URL (the tunnel)

Voice uses the same public listener as webhooks: `127.0.0.1:18787` (`ingress.port`). It is bound only while something is mounted, and only the active provider's prefix (`/voice/twilio` or `/voice/plivo`) is mounted. **Never point a tunnel at the control plane, port 18789.**

A cloudflared ingress rule that exposes only the public paths:

```yaml
ingress:
  - hostname: kirie.example.com
    path: ^/(hooks|voice)/
    service: http://127.0.0.1:18787
  - service: http_status:404
```

Then set the URL in `~/.kirie/config.yaml`:

```yaml
ingress:
  publicBaseUrl: "https://kirie.example.com"   # no trailing slash
```

Use a stable hostname. A random quick-tunnel URL changes on every restart, and the provider console would need updating each time.

Signatures are computed over the exact public URL. `publicBaseUrl` must therefore match what you configure in the provider console character for character: same scheme, same host, no trailing slash, no extra path.

## Credentials

Voice secrets come from exactly two places, in this order. Nothing else is read: no environment variable, and no plaintext value in `config.yaml`.

1. **`~/.kirie/secrets/voice.env`** (wins when both define a name). The file must be a regular file you own with mode `0600`. If it is group- or world-readable, a symlink, or owned by someone else, it is **ignored**, and `/voice status` says why.

   ```sh
   mkdir -p ~/.kirie/secrets && chmod 700 ~/.kirie/secrets
   touch ~/.kirie/secrets/voice.env && chmod 600 ~/.kirie/secrets/voice.env
   # then edit it:
   ```
   ```
   # Twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   # Plivo
   PLIVO_AUTH_ID=MA...
   PLIVO_AUTH_TOKEN=...
   # Only for inbound agent mode
   VOICE_PIN=482615
   ```

2. **The encrypted credential store**, referenced from config with `$credential:`. Leave the value off the command line, and the CLI asks for it with hidden input so it stays out of shell history:

   ```sh
   pnpm cli credentials set twilio.account_sid
   pnpm cli credentials set twilio.auth_token
   pnpm cli credentials set plivo.auth_id
   pnpm cli credentials set plivo.auth_token
   pnpm cli credentials set voice.pin
   ```
   ```yaml
   voice:
     twilio:
       accountSid: "$credential:twilio.account_sid"
       authToken: "$credential:twilio.auth_token"
     plivo:
       authId: "$credential:plivo.auth_id"
       authToken: "$credential:plivo.auth_token"
     inbound:
       pin: "$credential:voice.pin"
   ```

A provider you do not use needs no credentials. Phone numbers are not secrets and stay in config. Both sources are registered with the secret scrubber, so their values are redacted from logs, chat messages and audit records.

## Config

A minimal block (Twilio active, outbound only):

```yaml
voice:
  enabled: true
  provider: twilio                # or plivo; /voice provider switches at runtime
  twilio:
    fromNumber: "+14155550100"    # your Twilio number
  plivo:
    fromNumber: "+14155550111"    # your Plivo number (only needed if you use Plivo)
  ownerNumbers: ["+201001234567"] # you; only these numbers can talk to the agent
  contacts:                       # outbound allowlist; "me" is implicit (first owner number)
    mom: "+201112223333"
  outbound:
    enabled: true
    agentCalls: ask               # off | ask (default: you approve every call the agent places) | allow
  inbound:
    mode: reject                  # reject (default) | voicemail | agent
    unknownCallers: reject        # reject | voicemail
  limits:                         # shared by both providers
    maxCallSeconds: 300
    maxCallsPerDay: 10
    maxMinutesPerDay: 20
    maxUnverifiedCallsPerDay: 5  # voicemails and calls still at the PIN prompt
    maxUnverifiedMinutesPerDay: 5
    maxConcurrentCalls: 1
    maxTurnsPerCall: 30
    maxThinkSeconds: 60
  speech:
    language: en-US
  agent:
    toolProfile: chat             # chat (default, reduced tools) | full
```

Optional: `twilio.voice` (default `Polly.Joanna-Neural`) and `plivo.voice` (default `WOMAN`) choose the voice. `speech.hints` lists words the recognizer should expect.

Config changes to `voice` need a daemon restart. The two owner overrides, `/voice on|off` and `/voice provider`, apply immediately and survive restarts.

## Twilio

1. **Account and number.** Use an upgraded account. Trial accounts can only call verified numbers and play a trial announcement. Buy a voice-capable number. If no local number exists for your country, a foreign number works best with Kirie calling you (outbound).
2. **Credentials.** From the Twilio console home page, copy the Account SID (`AC...`) and the Auth Token into `voice.env` or the credential store (see above).
3. **Number configuration** (Phone Numbers > Manage > Active numbers > your number > Voice configuration):
   - "A call comes in": Webhook, `https://kirie.example.com/voice/twilio/inbound`, HTTP POST.
   - "Call status changes": `https://kirie.example.com/voice/twilio/status`, HTTP POST. Recommended: without it, Kirie only learns that an inbound call ended from its own watchdog. Kirie sets per-call status callbacks for outbound calls itself.
4. **Geographic permissions** (Voice > Settings > Geo permissions): enable only the countries you will dial.
5. Twilio signs every webhook with `X-Twilio-Signature`. Kirie checks it and the posted `AccountSid` on every request.

## Plivo

1. **Account and number.** Buy a voice-capable number in the Plivo console (Phone Numbers > Buy Numbers). Check that one is offered for your country.
2. **Credentials.** From the console overview, copy the Auth ID (`MA...` or `SA...` for a subaccount) and the Auth Token into `voice.env` or the credential store.
3. **Application** (Voice > Applications > Add New Application):
   - Answer URL: `https://kirie.example.com/voice/plivo/inbound`, method POST.
   - Hangup URL: `https://kirie.example.com/voice/plivo/status`, method POST.
   - Save, then attach the application to your number (Phone Numbers > your number > Application Type: XML Application > choose it).
4. Plivo signs every webhook with `X-Plivo-Signature-V3` and a nonce header. Kirie checks it on every request. It also accepts `X-Plivo-Signature-Ma-V3`, the same signature made with the main account's token, so a main-account token works for a subaccount number.
5. Kirie never calls Plivo's hangup endpoint without a call id. Plivo documents that such a request would disconnect every call on the account, so `endCall("")` throws before any request is made. A Plivo outbound call learns its id only when it is answered, so `/voice hangup` on a call that is still ringing marks it to be cancelled when it answers.

## Switching provider

```
/voice provider            # shows the active provider and both providers' readiness
/voice provider plivo      # switch; refused while a call is live or if Plivo is not ready
/voice provider reset      # back to voice.provider from config
```

On success, Kirie unmounts the old provider's routes from the public listener and mounts the new one's. Calls to the old provider's number are then refused: its webhooks get 404 because nothing is mounted for them. The conversation with you stays the same: the voice session is keyed by your phone number (`voice:dm:+20...`), not by the provider.

## Commands (owner only, in your Telegram DM)

| Command | What it does |
|---|---|
| `/voice status` | Readiness of both providers, switch, public URL and time of the last valid webhook, inbound and outbound policy, today's usage against the caps, live and recent calls |
| `/voice on` / `/voice off` | Runtime switch. `off` also ends live calls; inbound is rejected and outbound refused |
| `/voice hangup` | End all live calls now |
| `/voice provider [twilio\|plivo\|reset]` | Show or switch the active provider |
| `/call` | List contact aliases |
| `/call <alias> <message>` | One-way call; the reply is reported here |
| `/call me --talk [goal]` | Spoken conversation with Kirie |

Speech can never run a command: a leading `/` is stripped from transcripts, and phone numbers are not owner identities for commands.

## The agent's call tools

When voice is active, the agent gets `voice_call_initiate`, `voice_call_status`, `voice_call_list` and `voice_call_hangup`. Every call goes through the daemon's loopback API, where the rules are enforced:

- Calls go only to aliases in `voice.contacts`, plus `me`. Raw numbers are refused.
- `voice_call_status` and `voice_call_list` (and the loopback routes behind them) never return a transcript. A one-way call's reply and a voicemail show only as `replyCaptured: true`; the text goes to your DM when the call ends and is not written to chat history. It is kept in the call log (`~/.kirie/voice-calls/calls.jsonl`), which no tool hands to the agent; an agent with shell access could still open that file itself.
- `talk` mode works only with your own number. Messages are limited to 1000 characters.
- With `outbound.agentCalls: ask` (the default), you get an Approve / Deny card for each call. It shows the alias, the last 4 digits, the provider and the exact words. No answer within `outbound.approvalTimeoutSeconds` (120 s) means deny.
- During a call, the agent runs with a reduced tool set (`agent.toolProfile: chat`): no shell, no file edits, no subagents, no browser, no restarts, no MCP-server changes, no background tasks, no placing calls, and never computer use. It also gets nothing that would run later with full tools: no relaying into another session, no scheduling, no background-task messages, no proactive triggers, and no external MCP servers from `config.yaml`. A misheard sentence must not become a command. The claude.ai connectors that load from your user settings are only excluded when `agent.strictMcpConfig` is on.

## Costs and caps

Caps apply across both providers:

- seconds per call: the provider's own time limit on outbound calls, plus a watchdog that ends any call 10 s after its deadline
- calls per day
- minutes per day
- concurrent calls
- turns per call

Inbound calls that nobody has verified yet (voicemails, and calls from your number that are still at the PIN prompt) have their own daily budget, `maxUnverifiedCallsPerDay` and `maxUnverifiedMinutesPerDay`. So strangers leaving voicemails, or someone spoofing your number at the PIN prompt, cannot use up the calls and minutes that `/call`, the agent and your own verified calls need. A call moves to the main caps once its PIN is right, and a PIN prompt is only offered while the main caps still have room. Worst case per day is therefore the main caps plus the unverified budget (25 minutes and 15 calls with the defaults, against 20 minutes and 10 calls before this budget existed). They can still use up the unverified budget, which also blocks your own calls in for the rest of the day, because a call is unverified until its PIN is entered; `/call me` keeps working.

Caps are checked before a call is answered or dialled, and the defaults are low. When a cap refuses a call, you get one notice per day for each budget.

A signed `/inbound` webhook for a call id Kirie already knows, and that has ended, is refused without using any cap: a captured request cannot be replayed to open a new call.

## First-call checklist

Do this once per provider, cheapest first:

1. `/voice status` says the provider is ready, and `Voice: on.`
2. `curl https://kirie.example.com/healthz` returns `ok`. Through the tunnel, `curl -X POST https://kirie.example.com/voice/<provider>/inbound` must return **403**: it is unsigned. `https://kirie.example.com/status` must **not** answer; the control plane must not be reachable.
3. `/call me This is a test.` Your phone rings, you hear the announcement and the message, you say something, and the reply appears in Telegram. `/voice status` then shows "last valid webhook: … ago".
4. `/call me --talk` Have a two-turn conversation. Then ask something slow and check that you hear "One moment.", and that the answer still arrives.
5. Inbound, if you want it: set `inbound.mode: agent`, restart, call your provider number from your phone, enter the PIN and press `#`. Then test a wrong PIN three times: you should get a Telegram alert, and for `pinLockoutMinutes` your number should be refused. Wrong PINs are counted per number over 24 hours across calls, so hanging up between guesses does not help, and a lockout does not reset that count: after one, each further wrong PIN within the 24 hours locks the number again. Lockouts within 7 days escalate, each twice as long as the one before (30, 60, 120 minutes and so on with the default, at most 24 hours). Only the right PIN clears the count and the escalation. Lockouts are stored in `~/.kirie/voice-calls/pin-guard.json` (0600), so a restart does not clear them; to unlock your number early, delete that file and restart. Silence at the PIN prompt only ends the call.
6. Call from a number that is not yours. It must be rejected, or must reach voicemail if you set `unknownCallers: voicemail`.
7. On Plivo, also run the checks in the next section.

## Not verified against a live account

These are design assumptions to confirm on the first real calls.

**Plivo:**

- Whether `<GetInput>` falls through to the next element when there is no input. Plivo documents this for the older `GetDigits`, and the GetInput example implies it. Kirie places a `<Redirect>` after every GetInput as the fall-through. Check: during step 4, stay silent after a question. You should hear "Sorry, I did not catch that."
- The full list of standard params Plivo posts with a GetInput action request. Kirie needs the token in the URL, and once a call's `CallUUID` is known it requires every later webhook of that call to carry the same `CallUUID`. If Plivo's GetInput posts omit it, every turn after the PIN gets 403. If turns are refused with 403 after the first answer, look at the "voice webhook refused" log lines.
- Plivo's timeout for action URLs. Kirie holds each webhook at most 9 s, which is within Twilio's documented 15 s limit; Plivo's limit is unknown.
- Whether Plivo retries a webhook with the same nonce. Nonces are not treated as single-use; replay protection rests on the per-call token, the call id and the call phase.
- Whether numbers must be sent without `+`. Kirie sends them without `+` and reads them back with `+` added. If outbound calls fail with a number-format error, this is why.
- Whether `<Hangup reason="rejected"/>` on an inbound call is unbilled.
- Polly voice names on Plivo. Plivo lists only `WOMAN` and `MAN` as `voice` values; `Polly.*` appears in its SSML examples. The default is `WOMAN`.
- Whether numbers are available in your country.

**Twilio:**

- Whether speaking over a nested `<Say>` interrupts it (barge-in).
- Whether chained `<Redirect>`s have a limit, and what the caller hears when a webhook fails.
- Whether `<Reject>` calls are unbilled.
- Trial-account restrictions.
- Number availability in your country, and recognition quality for languages other than English. The default is `en-US`.

The Plivo signature check was tested against a fixture generated with Plivo's own Node SDK, `plivo` 4.79.0 `validateV3Signature` (`packages/voice/src/plivo/__fixtures__/signature-v3.json`). The Twilio check reproduces Twilio's published example.

## Troubleshooting

- **403 in the logs ("voice webhook refused", reason "signature")**: almost always `ingress.publicBaseUrl` differs from the URL configured in the console (scheme, host, trailing slash, a path prefix). It can also mean the auth token in `voice.env` or the credential store is wrong, or (Twilio) that the `AccountSid` does not match.
- **"not ready"**: `/voice status` lists exactly what is missing per provider. A note such as "voice.env has mode 0644" means the file is ignored: run `chmod 600 ~/.kirie/secrets/voice.env`.
- **Twilio debugger error 11200, or Plivo "answer URL unreachable"**: the tunnel is down, or the hostname changed.
- **Inbound calls get "busy"**: a call is already live (`maxConcurrentCalls: 1`), or an earlier call never reported its hangup. A live call from your own number that has had no webhook for 30 seconds is treated as ended. Set the Twilio status callback URL as described above.
- **Call records**: `~/.kirie/voice-calls/calls.jsonl` (mode 0600). Non-owner numbers are stored masked. Audit records: `~/.kirie/logs/audit.jsonl`, feature `voice`.

## Turning it off

- `/voice off`: immediate, persistent, and ends live calls.
- Or set `voice.enabled: false` and restart.
- To be certain nothing can be billed, also clear the number's webhook (Twilio) or detach the application (Plivo) in the console, or release the number.
