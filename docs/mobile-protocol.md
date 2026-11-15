# Dispatch mobile protocol, version 1

How a phone app talks to Dispatch on a Mac. The Mac side is open source (`app/cli/mobile.py`,
`app/cli/mobile_api.py`, tests in `app/cli/test_mobile.py`); a client can be written against this
document alone.

## The pieces

- **The service** runs on the Mac inside chatd (Dispatch's resident chat process) as soon as one
  phone is paired or a pairing code is waiting; `dispatch mobile serve` runs the same thing in the
  foreground. It answers from the same functions the CLI prints, in process, and reaches sessions
  through chatd's door like `dispatch agent` and `dispatch reply` do.
- **Two listeners.** HTTPS on every interface, port `P` (default 7788, `dispatch mobile config port`),
  for a phone on the same network; plain HTTP on `127.0.0.1:P+1` for a helper on the same Mac that
  forwards requests the phone sent through a remote channel. Both require the same signature.
- **Discovery.** The service publishes a Bonjour record `_dispatch._tcp` with TXT `mac=<mac id>`,
  `v=1`, `model=<Mac | MacBook | Mac mini>`, `host=<local host name>.local`, `port=<P>`, `name=<Mac name>`, so a paired phone finds the Mac again after its address
  changes, and an unpaired phone can list Macs on the network.
- **Remote channels** (a relay, iCloud) are not part of the service. A client carries each request,
  unchanged and still signed, inside an end-to-end encrypted envelope; a helper on the Mac opens the
  envelope and replays the request against the loopback listener. The service cannot tell the
  difference and needs no knowledge of the channel.

## Pairing

`dispatch mobile pair` creates a pending pair and prints a QR code and six digits. A pending pair
expires after 10 minutes if no phone uses it. The first correctly signed request binds the pair to
the phone that sent it (its `X-Dispatch-Device`); after that other devices are refused with the same
pair. `dispatch mobile revoke <pair id | device id>` forgets it.

### Pairing payload

The QR code is the URL `dispatch://pair?d=<base64url(JSON)>` (base64url without padding). JSON:

| field | | meaning |
|---|---|---|
| `v` | int | protocol version, 1 |
| `mac` | string | this Mac's id (stable, random, `mac-<16 hex>`) |
| `name` | string | the Mac's name, for display |
| `model` | string | `Mac`, `MacBook` or `Mac mini` |
| `pair` | string | the pair id (`p-<12 hex>`) |
| `secret` | string | 32 random bytes, base64url: the pairing secret |
| `port` | int | the HTTPS port `P` |
| `lan` | [string] | the Mac's IPv4 addresses on its local networks (not a VPN's tunnel) |
| `fp` | string | SHA-256 of the service's TLS certificate (DER), lowercase hex |
| `direct` | [string] | optional: other direct addresses (for example an overlay network) |
| `relay` | string | optional: the relay's base URL, when one is configured |
| `cloud` | string | optional: the cloud container the helper uses, when one is configured |

The payload is everything a client needs, so one scan is enough to reach the Mac on the same
network and, through a relay or cloud channel configured before pairing, from anywhere.

### Pairing with six digits

For a client that found the Mac by Bonjour instead of scanning: `POST /v1/pair/code` with
`{"code": "123456"}` (no signature) returns `{"ok": true, "url": "dispatch://pair?d=…"}`, the same
payload. Each code works once; five wrong codes disable the pending pair's code.

## Keys

Keys are derived from the pairing secret with HKDF-SHA256 (RFC 5869), salt `dispatch-link-v1`,
32 bytes each, `info` naming the purpose:

| info | used for |
|---|---|
| `dispatch/lan-auth` | signing requests to the service (both listeners) |
| `dispatch/relay-auth` | proving the pair to a relay; the relay learns this key and nothing else |
| `dispatch/box` | end-to-end encryption of remote envelopes (never known to the service or a relay) |

## Signing requests

Every request except `/v1/health` and `/v1/pair/code` carries:

| header | value |
|---|---|
| `X-Dispatch-Pair` | the pair id |
| `X-Dispatch-Device` | a stable id of the phone (random, kept by the app) |
| `X-Dispatch-Device-Name` | optional, percent-encoded display name |
| `X-Dispatch-Time` | unix seconds |
| `X-Dispatch-Nonce` | random, a new one per request (so two identical requests in one second differ) |
| `X-Dispatch-Sig` | base64url(HMAC-SHA256(lan-auth key, canonical)) |

`canonical` is five lines joined by `\n`: the method in upper case, the path with its query string
exactly as sent, the time, the nonce, and the SHA-256 of the body in lowercase hex (of the empty
string when there is no body). The service refuses a time more than 300 seconds off its clock (`clock_skew`) and
a signature it has already seen (`replayed`).

Errors are JSON `{"ok": false, "code": …, "message": …}` with status 401 (`unknown_pair`,
`pair_expired`, `bad_signature`, `clock_skew`, `replayed`), 403 (`other_device`, `bad_code`),
404 (`not_found`), 413 (`too_large`, bodies over 20 MB) or 500 (`internal`).

## Endpoints

All bodies are JSON (UTF-8). Times are unix seconds. A session key is `<engine>:<session id>`
with engine `claude-code`, `codex` or `opencode`. Query parameters and JSON body fields are
interchangeable for the GET and POST endpoints below.

| | path | in | out |
|---|---|---|---|
| GET | `/v1/health` | | `{ok, protocol, mac}` (unsigned) |
| GET | `/v1/hello` | | `{protocol, mac, name, model, time, waiting, only_you, device, relay, cloud}` |
| GET | `/v1/sessions` | `project?` | `{sessions: [Session], chats: [Session], more_projects}`; with `project` the whole history of that project (newest first, up to 200) and no chats |
| GET | `/v1/session` | `key` | `{key, title, project, cwd, engine, items: [Item], offset, running, files, added, deleted, branch}` |
| GET | `/v1/session/changes` | `key` | `{rounds: [{id, title, files: [File]}], files, added, deleted}` |
| POST | `/v1/session/send` | `key, text, request_id?, mode?` | `{ok, state, note, request_id}` (`mode`: `queue` or `interrupt`) |
| POST | `/v1/session/stop` | `key` | `{ok}` |
| POST | `/v1/session/permission` | `key, decision, item?` | `{ok}` (`decision`: `allow`, `allow_session`, `deny`) |
| POST | `/v1/session/answer` | `key, option, text?, item?` | `{ok}` (option is 0-based) |
| POST | `/v1/session/new` | `engine, project? \| cwd?, text, request_id?` | `{ok, key, cwd}` |
| GET | `/v1/waiting` | | `{items: [Wait], counts, host_name}` |
| POST | `/v1/waiting/act` | `id, op, option?, reason?` | the `dispatch waiting <op> --json` answer plus `ok` |
| GET | `/v1/assistant` | | `{key, items: [Item], running, engine}` |
| POST | `/v1/assistant/send` | `text, request_id?` | `{ok, state, key?}` |
| GET | `/v1/tasks` | `project? \| session?` | `{tasks: [Task]}` |
| GET | `/v1/docs` | `project, session?` | `{docs: [Doc]}` |
| GET | `/v1/doc` | `project, id, max?` | `{title, meta, parts: [Part]}` for Markdown, `{title, meta, html, skipped_images}` for a page (its local pictures inlined as data URIs while they fit in `max` bytes, default 12 MB), `{title, meta, html}` for a picture, `{title, meta, file: {mime, data}}` for a PDF (`data` is a data URI) |
| GET | `/v1/projects` | | `{projects: [{name, label, dir, archived, running, waiting, last_at, summary, now}]}` |
| GET | `/v1/customizations` | | `{skills: {dispatch, yours}, hooks, instructions}` (read-only) |
| GET | `/v1/machines` | | `{machines: [{id, name, local, online, running, waiting}]}` |
| GET | `/v1/knowledge` | | `{preferences, wiki, counts}` |
| GET | `/v1/home` | | `{quota: [Quota], tasks: {active: [Task], done_today: [Task], done_count}, active_hours, sessions_today}` |
| GET | `/v1/notify` | | `{kinds: {finished, stopped, needs_you}, away_only, relay, remote, foreground, last_push}`, below |
| POST | `/v1/notify` | `finished?, stopped?, needs_you?, away_only?, remote?, foreground?` (booleans) | the same as GET |
| POST | `/v1/notify/test` | `kind?, delay?` | `{ok, kind, delay}`: a test notice after `delay` seconds (at most 30) |
| GET | `/v1/events` | | Server-Sent Events, below |

`waiting/act` ops: `read` (`id` or `all`), `unread`, `done`, `reopen`, `snooze`, `pick`
(`option` is a letter for a design decision, with an optional `reason` that becomes a preference),
`allow`, `deny`.

### Shapes

- **Session** `{id, title, project, cwd, engine, state, unread, last_at, model, mode, branch}`;
  `state` is `run`, `wait` (waiting for the person), `idle` or `err`; `project` is empty for a chat.
- **Item** (a block of a conversation), by `kind`:
  `user {text}`, `assistant {text}` (Markdown), `steps {summary, count, items: [Step]}` (a turn's
  tool calls folded, summary like `Worked for 3m 40s`), `working {verb, arg}` (the call running
  now), `thinking {seconds}`, `permission {title, command, detail, item}`,
  `question {question, options, item}`. Every item has an `id`.
- **Step** `{id, icon, verb, arg, running, ok, added?, deleted?}`; `icon` is one of `file`, `pen`,
  `term`, `search`, `agent`, `book`, `chat`, `tasks`, `zap`.
- **File** `{path, added, deleted, hunks: [{id, header, lines: [{n, k, t}]}]}`, `k` is `ctx`,
  `add` or `del`.
- **Wait**, by `kind`: `approve {title, command, tool, can_act}`, `decide {title, proposal,
  directions: [{key, title}], doc}`, `question {title, options, can_act}`, `unread {title, detail}`,
  `only_you {title, detail}`; all have `id, project, session, session_title, at, task`.
- **Task** `{id, title, state, at, note, plan: [{text, state}], deliverables: [{icon, title, doc,
  url, commit}], commit, session}`; `state` is `wait`, `active`, `done` or `todo`.
- **Quota** `{agent, plan, five_hour, weekly, updated_at, note}` for `claude-code` and `codex`; `five_hour` and `weekly` are
  `{used_percent, resets_at}` or null (from `dispatch quota`). In `/v1/home` a Task also carries `project`; `active` holds
  tasks in progress or waiting, `done_today` those finished since midnight with their deliverables; `active_hours` is how many
  hours of today an agent wrote something (the transcripts keep messages per hour, not working time).
- **Doc** `{id, title, icon, at, unread, in_session, delivered_for, ext, project}`.
- **Part** `{k: "p" | "h" | "code", t}` or `{k: "ul" | "ol", items}`.

### Events

`GET /v1/events` answers `text/event-stream`. Event types:

- `hello {mac, time}` first;
- `chat` with one chatd event of a session (`turn_started`, `text_delta`, `text_done`,
  `tool_start`, `tool_end`, `permission_request`, `permission_resolved`, `state`, `queued`,
  `queue`, `turn_done`, `diff_updated`, `opened`, `closed`, `error`; fields as in
  `app/cli/chat_protocol.py`), large fields trimmed;
- `changed {what: "waiting", counts}` when the Waiting list moved (fetch it again);
- `notice {id, kind, title, body, session, project, at, sound, mac, test?}` when a session finished,
  stopped or waits for you, only the kinds this phone asked for (Notifications, below);
- `ping {time}` every 15 seconds.

## Notifications

The Mac tells the phone when a session **finished** (its turn ended on its own), **stopped** (an
error, a usage limit, the process died; stopping it yourself is not news) or **waits for you** (a
permission or a question): kinds `finished`, `stopped`, `needs_you`, the same three as the bell in
the Agents window (`app/cli/inbox.py`), from the same file (`<DISPATCH_DIR>/inbox.json`, written by
chatd, the Agents window and the terminal hooks). Source: `app/cli/mobile_push.py`.

- **Choices per phone**, `POST /v1/notify`: each kind on or off (all on by default), `away_only`
  (only while nobody has touched the Mac's keyboard or mouse for two minutes; off by default),
  `foreground` (the app is in front: `true` counts for 120 seconds and is renewed by the app every
  minute, `false` when it goes to the background), `remote` (the phone registered for remote
  notifications with the relay, below).
- **While connected** (same Wi-Fi, an overlay network or the relay): the event stream carries a
  `notice`; the app shows it as a local notification. Nothing to set up, no Apple service involved.
- **With the app closed**: when the Mac has a relay, the phone registered with it and is not in
  front (it said so, its last `foreground: true` is older than 120 seconds, or it has no event
  stream open), the Mac also sends `POST <relay>/v1/push`. The relay holds the phone's device token and the
  Apple key; the Mac never sees either. A phone in front gets only the stream (no double banner);
  a notice has a stable `id` that the app and Apple use to drop repeats.
- With a relay set, the Mac makes every pair known to it (`POST <relay>/v1/register`, the same call
  the Mac helper makes) as soon as the pair exists, and again before a push the relay refused with
  `not_paired`; so the phone can register its token right after pairing with nothing else running.
- `last_push {at, status, code, kind}` is the relay's answer to the last remote push: `ok`,
  `no_token` (the phone has not registered), `push_not_set_up` (the relay has no Apple key yet),
  `gone` (the app was removed from that phone) or `unreachable`. After `no_token` or `gone` the Mac
  sets `remote` to false until the phone registers again.

- **Allow and Deny on the notice**: a `needs_you` for a permission that a session in Dispatch
  (chatd) or in the Agents window waits on carries `item` (the Waiting row: `chat:<key>` or
  `ide:<resource>`) and `permission` (chatd's permission id, or the window's tool call id); the
  relay passes both on. The phone shows Allow and Deny on that notification (on the lock screen
  too, without opening the app) and answers with `POST /v1/session/permission {item, key,
  decision, permission}`. With `permission` the Mac answers only that request: one answered on the
  Mac already, or replaced by a newer one, is left alone (`not_waiting`). A question, a terminal
  session, or a request the Mac could not read in time has neither field; its notice opens the
  session. `dispatch waiting allow|deny <id> --request <id>` is the same on the command line.
- The title is the session's name at the time: a session renamed on the Mac (by hand, or named
  after its first turn) is told under its new name.

`dispatch mobile notify` lists what each phone gets; `dispatch mobile notify test [--kind K]` asks
the running service for a test notice (through `<DISPATCH_DIR>/mobile/notify-test.json`, so the
Mac's own bell does not ring).

## Remote envelopes (for relay and cloud channels)

Not spoken by the service; defined here so a Mac helper and a client agree. An envelope is
`{v: 1, pair, dir: "up" | "down", seq, id, ch, box}`: `dir` up is phone to Mac; `seq` increases per
direction (milliseconds since 1970 times 1000 plus a counter, so it keeps increasing across
restarts); `id` is the request id a response or event answers; `ch` is a channel label derived per
session (HMAC-SHA256 of the session key under the box key, first 16 bytes, base64url; `main` when
the request names no session) so a store can shard by session without learning it; `box` is
AES-256-GCM under the `dispatch/box` key, base64url of nonce (12 bytes), ciphertext and tag, with
associated data `<pair>|<dir>|<seq>` (an envelope cannot be moved to another pair, direction or
position). A receiver drops an envelope it has already seen.

The plaintext is JSON, one of:

- `{"request": {id, method, path, headers, body}}` (up): a request signed as above, `body` base64url;
  the Mac replays it unchanged against the loopback listener;
- `{"response": {status, body}}` (down), `body` base64url;
- `{"event": {event, data}}` or `{"batch": [{event, data}, …]}` (down) for a `GET /v1/events`
  request: the events of that stream, several coalesced into one envelope;
- `{"ack": seq}`, `{"hello": id}` (either way, housekeeping).

### Relay

A relay passes envelopes between the two ends of a pair and sees nothing but ciphertext, the pair
id and sizes.

- `POST /v1/register` `{pair, key, ts, sig}`: the Mac gives the relay the pair's relay-auth key;
  `sig` is base64url(HMAC-SHA256(key, "register|<pair>|mac|<ts>")). The first registration stores
  the key; later ones must bring the same key.
- `GET /v1/ws?pair=&role=phone|mac&device=&ts=&sig=` upgrades to a WebSocket; `sig` is
  base64url(HMAC-SHA256(relay-auth key, "connect|<pair>|<role>|<ts>")). A pair nobody registered,
  a bad signature or a time more than 300 seconds off is refused.
- Text frames are envelopes, forwarded to the other role's sockets as they are (queued for a while
  when the other end is offline), or notices from the relay: `{"type": "limit", "state": "slow" |
  "blocked" | "too_large", "message"}`, `{"type": "peer", "state": "online" | "offline"}`. `ping` is
  answered `pong`.

- `POST /v1/push/token` `{pair, ts, sig, token, env}` (phone): the phone's Apple device token (hex)
  and `env` (`sandbox` for builds installed from Xcode, `production` for TestFlight and the App
  Store); `sig` is over `"pushtoken|<pair>|phone|<ts>"`. An empty `token` removes it.
- `POST /v1/push` `{pair, ts, sig, notice: {id, kind, title, body, session, sound, mac}}` (Mac): `sig`
  is over `"push|<pair>|mac|<ts>"`. The relay sends the notice to Apple for the pair's phone and
  answers `{ok}`, or 404 `no_token`, 410 `gone`, 429 `limit`, 503 `push_not_set_up`. The title and
  body pass the relay in the clear (Apple needs them); the conversation itself never does.

### Cloud store

Records of type `Envelope` in a zone `DispatchLink` of the app's private database, named
`<pair>.<dir>.<seq>`, fields `pair`, `dir`, `seq` (Int64), `id`, `ch`, `box` (bytes), `created`
(date). A zone subscription sends a silent push on changes; each end reads the other direction and
deletes what it read.
