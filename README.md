# SpockChat

![SpockChat Logo](assets/logo_new.png)

> **Local-first, peer-to-peer AI chat. Zero cloud. Zero latency. Infinite logic.**

[![Version](https://img.shields.io/badge/version-3.0.0-6C5CE7?style=flat-square)](https://github.com/06pratyush/SpockChat)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-D62828?style=flat-square)](https://www.gnu.org/licenses/agpl-3.0)
[![Node](https://img.shields.io/badge/Node.js-22.5%2B-22C55E?style=flat-square)](https://nodejs.org)
[![Ollama](https://img.shields.io/badge/Ollama-compatible-1D7FD4?style=flat-square)](https://ollama.com)
[![Tests](https://img.shields.io/badge/tests-99%20passing-22C55E?style=flat-square)](#testing)

SpockChat runs group chats and 1v1 AI conversations entirely on your own hardware. No accounts, no servers, no data leaving your machine. Every message is local. Every AI call goes to your own Ollama instance. The only thing shared is your local network IP — or a temporary tunnel URL if you choose to go public.

---

## What's new in v3.0 — the resilience release

v3 is a rebuild of the backend around one question: **what happens when things go wrong?**

Networks drop packets. Laptops close mid-sentence. Ollama gets killed by the OOM reaper. A friend's machine is asleep when you add them. In v2 every one of those situations lost data silently or hung the UI. In v3 each has a defined, tested behaviour.

**Reliability**
- **Exactly-once message delivery.** Every message carries a client-generated idempotency key, is acknowledged before the sender considers it sent, and is retried until it lands. Retrying is always safe.
- **Gap-free ordering.** Every message has a per-chat sequence number. A reconnecting client asks for "everything after N" and can prove it missed nothing.
- **A persistent outbox on both ends.** The browser queues undelivered messages in `localStorage`; the server queues undeliverable peer calls in SQLite. Both survive a restart.
- **Circuit breakers** in front of Ollama and every peer server, so a dead dependency fails in milliseconds with an explanation instead of hanging for two minutes.
- **Self-healing tunnel** that reconnects automatically and tells every client when the public URL changes.
- **Graceful shutdown** with ordered teardown hooks, plus crash guards that keep an unhandled rejection from taking the process down.

**Failures you can act on**
- Every error carries a stable `code`, a plain-language message, and a **hint** telling you what to do about it.
- AI failures are stored as visible system messages in the chat rather than vanishing into a toast you may not have been looking at.
- Undelivered messages are shown in the UI with a retry button, not silently dropped.

**Fixed in v3 — features that did not actually work in v2**
| Area | What was wrong |
|---|---|
| Friend system / federation | The router was mounted twice, so the real endpoints were at `/api/federation/federation/…`. **Every friend add failed**, and the documented paths returned `index.html` with HTTP 200. |
| Accepting a friend | Only updated the accepter's database. The requester stayed "pending" forever because nothing ever told their server. |
| Chat history | `ORDER BY created_at ASC LIMIT 100` returned the **oldest** 100 messages, so past 100 messages a chat looked frozen in time. |
| 1v1 AI chat | Required an `@AI` mention that the UI never inserted, so 1v1 chats never replied at all. |
| Message loss | A send on a dead socket was discarded silently and the input box cleared anyway. |
| Message size | No limit. A 2 MB message was accepted, stored and broadcast to every member. |
| Malformed JSON | Returned an HTML page containing a stack trace; the client then died with `Unexpected token '<'`. |
| Multiple tabs | Presence stored one socket per user, so opening a second tab silently unsubscribed the first. |

---

## Architecture

### Layers

SpockChat is a layered monolith. Each layer may only call the one below it, which is what keeps the HTTP and WebSocket entry points from drifting apart — in v2 they enforced membership with two different pieces of code.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  client/index.html                                                       │
│  Single-file UI · outbox with retry · cursor tracking · connection state │
└───────────────┬──────────────────────────────────┬───────────────────────┘
                │ REST (fallback transport)        │ Socket.IO (primary)
┌───────────────▼──────────────────────────────────▼───────────────────────┐
│  api/                                    realtime/                       │
│  ├── middleware/                         ├── index.js    socket server   │
│  │   ├── context.js    request id        ├── presence.js user → sockets  │
│  │   ├── auth.js       JWT              ├── ai-responder.js             │
│  │   ├── rate-limit.js token bucket      └── registry.js façade          │
│  │   └── error-handler.js  JSON errors                                   │
│  └── routes/  auth · chats · friends · federation · ai · tunnel · health  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ services own ALL business rules
┌──────────────────────────────▼───────────────────────────────────────────┐
│  services/                                                               │
│  auth · chat · message · ai · friend · federation · tunnel · identity    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ repositories own ALL SQL
┌──────────────────────────────▼───────────────────────────────────────────┐
│  db/                                                                     │
│  index.js  connection · migrations · transactions · health               │
│  migrations.js  versioned, forward-only                                  │
│  repositories/  users · chats · messages · friends · invites · outbox    │
└──────────────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────────────┐
│  core/  (no domain knowledge — reusable primitives)                      │
│  errors · logger · http · retry · circuit-breaker · task-queue           │
│  rate-limiter · validate · lifecycle                                     │
├──────────────────────────────────────────────────────────────────────────┤
│  config/  every tunable, read once, validated, frozen                    │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why the `realtime/registry.js` façade exists:** HTTP routes need to push socket events ("you were invited"), but importing the socket module from a route would create a require cycle. The realtime layer registers itself with the façade at boot; before that every call is a no-op, so services can be exercised without a socket server at all.

### Directory map

```
spockchat/
├── server/
│   ├── index.js                    boot sequence, banner, listen, fatal-error messages
│   ├── app.js                      Express assembly (middleware order is deliberate)
│   ├── config/index.js             all env parsing + validation, frozen at boot
│   ├── core/
│   │   ├── errors.js               AppError + the error-code taxonomy
│   │   ├── logger.js               levelled structured logging
│   │   ├── http.js                 outbound fetch: deadlines, size caps, error classification
│   │   ├── retry.js                exponential backoff with full jitter
│   │   ├── circuit-breaker.js      per-host breakers (closed → open → half-open)
│   │   ├── task-queue.js           bounded concurrency + bounded backlog
│   │   ├── rate-limiter.js         token buckets
│   │   ├── validate.js             input validation + SSRF host guard
│   │   └── lifecycle.js            crash guards + ordered graceful shutdown
│   ├── db/
│   │   ├── index.js                WAL, busy_timeout, checkpointing, transactions
│   │   ├── migrations.js           v1 → v5, forward-only
│   │   └── repositories/           the only files containing SQL
│   ├── services/                   all business rules and authorisation
│   ├── api/
│   │   ├── middleware/
│   │   └── routes/
│   └── realtime/
│       ├── index.js                socket server, acks, backfill
│       ├── presence.js             username → Set<socketId>
│       ├── ai-responder.js         AI turns, with failures persisted
│       └── registry.js             façade used by HTTP routes
├── client/index.html               the whole UI, no build step
├── tests/
│   ├── helpers/
│   │   ├── harness.js              spawns real servers + a fake Ollama
│   │   ├── chaos-proxy.js          TCP proxy that severs, refuses and delays
│   │   └── reliable-client.js      headless copy of the browser outbox algorithm
│   ├── smoke · auth · chat · reliability · federation · ai · chaos
└── .env.example                    every tunable, documented
```

### Message flow

```
 Browser                          Server                        SQLite
    │                                │                             │
    │ 1. write to outbox             │                             │
    │    (localStorage, BEFORE send) │                             │
    │                                │                             │
    │ 2. message:send ──────────────▶│                             │
    │    {chatId, content,           │ 3. membership + validation  │
    │     clientMsgId}               │                             │
    │                                │ 4. append ─────────────────▶│
    │                                │    seq = MAX(seq)+1         │
    │                                │    UNIQUE(chat, clientMsgId)│
    │                                │◀────── {message, duplicate} │
    │ 5. ◀───── ack {ok, message}    │                             │
    │    remove from outbox          │ 6. broadcast to the room    │
    │                                │                             │
    │ 7. if no ack in 8s ────────────┼─▶ retry (backoff + jitter)  │
    │    over socket, or over HTTP   │    step 4 returns the SAME   │
    │    if the socket is down       │    row → duplicate: true     │
```

The acknowledgement is what makes this safe. Because step 4 is idempotent, step 7 can happen any number of times, over either transport, and still store exactly one message.

### Reconnect recovery

```
 Client holds cursors: { chatA: 41, chatB: 7 }
    │
    │ socket reconnects
    │ chats:sync { cursors } ─────────▶ server
    │                                   for each chat the user belongs to:
    │                                     latest = MAX(seq)
    │                                     missed = messages WHERE seq > cursor
    │ ◀───── { chatA: {latestSeq: 46, missed: [42..46], complete: true}, … }
    │
    │ render missed, advance cursors, flush outbox
```

Cursors live in the database and in `localStorage`, never in server memory — so this works across a server restart exactly as it does across a WiFi drop.

### Federation

Every person runs their own server; there is no central host.

```
 alice@A adds bob@B                     bob accepts
 ──────────────────                     ───────────
 A ── GET  /api/federation/ping ──▶ B   B: friendship(alice) = accepted
      (is this really SpockChat?)       B ── POST /api/federation/friend-response ──▶ A
 A ── GET  /lookup/bob ───────────▶ B        (queued in federation_outbox if A is down)
      (does bob exist there?)          A: friendship(bob) = accepted
 A ── POST /friend-request ───────▶ B   A: socket event → UI updates live
      (queued if B is down)
 A: friendship(bob) = pending/outgoing
 B: friendship(alice) = pending/incoming → socket event
```

Any peer call that fails transiently goes into the `federation_outbox` table and is retried with exponential backoff (up to 12 attempts, capped at 10 minutes apart). A definitive rejection is *not* retried. This is why a friend request sent to a sleeping laptop arrives when it wakes, instead of being lost.

### Data model

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | local accounts | bcrypt `password_hash` |
| `chats` | groups and 1v1 AI chats | `ai_enabled`, `ai_model`, `ai_host` |
| `chat_members` | membership + admin flag | PK `(chat_id, user_id)` |
| `messages` | all messages | **`seq`** per-chat counter, **`client_msg_id`** idempotency key, `created_at_ms` |
| `delivery_cursors` | how far each user has read | drives unread badges and backfill |
| `friendships` | per-user view of a friendship | `status`, `direction`, `last_error` |
| `invites` | group invitations | single-transition `status` |
| `federation_outbox` | undelivered peer calls | `attempts`, `next_retry_at`, `status` |

Two indexes carry the delivery guarantees:

```sql
CREATE UNIQUE INDEX idx_messages_chat_seq  ON messages(chat_id, seq);
CREATE UNIQUE INDEX idx_messages_client_id ON messages(chat_id, client_msg_id)
                                           WHERE client_msg_id IS NOT NULL;
```

Schema changes are versioned migrations tracked with `PRAGMA user_version`, applied inside a transaction. Upgrading an existing `spockchat.db` from v2 is automatic and non-destructive.

---

## Failure handling

### What happens when…

| Failure | Behaviour |
|---|---|
| **Socket drops mid-send** | Message stays in the outbox, retried with jittered backoff over the socket or HTTP. The bubble shows "retrying (3)…". |
| **Acknowledgement is lost** | Client retries; the server returns the original stored row with `duplicate: true`. Exactly one message exists. |
| **Client offline for minutes** | Messages queue in `localStorage` and survive a page reload. `chats:sync` backfills everything missed on reconnect. |
| **Server restarts** | Clients reconnect automatically and backfill from their cursors. Sessions survive if `JWT_SECRET` is set. |
| **Ollama not running** | First calls fail fast with "Ollama is not running at … — run `ollama serve`". After 4 failures the circuit opens and further calls fail in ~1 ms with a countdown. |
| **Model not pulled** | `AI_MODEL_MISSING` with the exact `ollama pull <model>` command. Does not trip the circuit — the host is healthy. |
| **Model too slow / hangs** | Hard deadline (`AI_TIMEOUT_MS`), then a timeout error suggesting a smaller model. |
| **Two people @AI at once** | The second gets "SpockAI is still working on the previous question". Generations are serialised per host. |
| **AI fails** | A system message is **stored in the chat** explaining what broke and how to fix it, plus an `ai:done` event so no spinner sticks. |
| **Peer server asleep** | Friend request is queued (HTTP 202, "we'll keep retrying") and delivered when it comes back. |
| **Peer address is wrong** | `PEER_NOT_SPOCKCHAT` — "that address is reachable but is not a SpockChat API endpoint". |
| **Tunnel drops** | Auto-restarts with backoff; every client is told the URL changed so nobody keeps sharing a dead link. |
| **Database locked** | `busy_timeout` waits instead of erroring; `/api/health/ready` reports it if it persists. |
| **Malformed request** | JSON 400 with a code and hint. Never an HTML stack trace. |
| **Flood / brute force** | Token-bucket limits per IP (auth, API, federation) and per user (messages, AI), each with a `Retry-After`. |
| **Unhandled rejection** | Logged with full context; the process keeps running. |
| **Uncaught exception** | Logged, then a graceful shutdown with a non-zero exit for a supervisor to restart. |
| **Ctrl-C** | Ordered teardown: stop accepting → close sockets → stop workers → checkpoint and close the database. |

### Error codes

Every failure returns the same shape, over HTTP and over the socket:

```json
{
  "error": "The model \"llama3\" is not installed on http://localhost:11434.",
  "code": "AI_MODEL_MISSING",
  "hint": "Run \"ollama pull llama3\" on the machine hosting the model, then try again.",
  "retryable": false,
  "requestId": "a3f9c1d2"
}
```

| Group | Codes |
|---|---|
| Request | `VALIDATION_FAILED` · `MALFORMED_JSON` · `PAYLOAD_TOO_LARGE` · `NOT_FOUND` |
| Auth | `UNAUTHENTICATED` · `TOKEN_INVALID` · `TOKEN_EXPIRED` · `BAD_CREDENTIALS` · `USERNAME_TAKEN` · `FORBIDDEN` |
| Chat | `CHAT_NOT_FOUND` · `NOT_A_MEMBER` · `GROUP_FULL` · `MESSAGE_TOO_LONG` · `MESSAGE_EMPTY` · `INVITE_NOT_FOUND` · `INVITE_ALREADY_ANSWERED` |
| Federation | `PEER_UNREACHABLE` · `PEER_REJECTED` · `PEER_NOT_SPOCKCHAT` · `PEER_USER_NOT_FOUND` · `FRIEND_EXISTS` · `FRIEND_NOT_FOUND` · `INVALID_HOST` |
| AI | `AI_UNREACHABLE` · `AI_TIMEOUT` · `AI_MODEL_MISSING` · `AI_DISABLED` · `AI_BUSY` · `AI_CIRCUIT_OPEN` · `AI_BAD_RESPONSE` |
| Tunnel | `TUNNEL_SSH_MISSING` · `TUNNEL_TIMEOUT` · `TUNNEL_FAILED` |
| Infra | `RATE_LIMITED` · `DB_UNAVAILABLE` · `SHUTTING_DOWN` · `INTERNAL_ERROR` |

`requestId` appears in both the response and the server log, so any report maps to exactly one log line.

---

## Features

- **1v1 AI chat** — private conversation with a local Ollama model; every message gets a reply
- **Group chat** — up to 5 humans sharing one AI model per group (configurable)
- **@AI mentions** — tag the AI mid-conversation; it reads the last 40 messages as context
- **Guaranteed delivery** — messages survive dropped connections, closed tabs and server restarts
- **Unread badges and read cursors** — persisted per user, per chat
- **Built-in public tunnel** — one click for a public HTTPS URL over SSH; auto-reconnects
- **Peer-to-peer federation** — each machine runs its own server and connects to others by address
- **Friend system** — add by LAN address or tunnel URL, with queued retry when a peer is offline
- **Local auth** — bcrypt (cost 12), JWT sessions, nothing stored remotely
- **Persistent history** — SQLite with WAL, versioned migrations
- **Health endpoints** — liveness, readiness and deep diagnostics
- **Glassmorphism UI** — single file, no framework, no build step

---

## Prerequisites

| Requirement | Version | Where to get it |
|---|---|---|
| Node.js | **22.5 or higher** | [nodejs.org](https://nodejs.org) |
| Ollama | latest | [ollama.com](https://ollama.com) |
| A local model | any | `ollama pull llama3` |
| OpenSSH client | built-in | only needed for the 🌐 tunnel |

> **Why Node 22.5+?** SpockChat uses the built-in `node:sqlite` module. No native compilation, no build tools.

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Then set a secret in `.env` — without it, every restart logs everyone out:

```env
PORT=3000
JWT_SECRET=pick-any-long-random-string-and-put-it-here
```

```bash
ollama pull llama3
```

```bash
ollama serve
```

```bash
npm start
```

```
╔════════════════════════════════════════════════════╗
║  SpockChat v3.0.0                                  ║
╠════════════════════════════════════════════════════╣
║  Local:    http://localhost:3000                   ║
║  Network:  http://192.168.1.42:3000                ║
║  Public:   click 🌐 in the sidebar                 ║
║  Health:   http://localhost:3000/api/health/ready   ║
╚════════════════════════════════════════════════════╝
```

Open **http://localhost:3000**.

### First run

1. **Register** — "New here? Create account"
2. **Create a group** — **+ New Group Chat**, enable AI, pick a model (the list is read from your Ollama)
3. **Send a message** — it is stored locally and broadcast over the socket
4. **Try AI** — type `@AI explain how TCP handshakes work`
5. **Invite someone** — **＋** → Add Friend → their server address and username

---

## Connecting with friends

### Same WiFi

Share the **Network** address printed at startup. Anyone on the same network can open it and register.

> If your address starts with `169.254.x.x` it is link-local, not a real LAN IP — your machine did not get an address from the router. SpockChat warns about this at startup. Reconnect to WiFi and restart.

### Different networks — built-in tunnel

1. Click the **🌐** icon in the sidebar
2. Wait 5–15 seconds for a URL like `https://abc123.lhr.life`
3. **📋 Copy URL** and send it to your friend
4. They use **Add Friend → 🌐 Internet (Tunnel)**

The tunnel uses your system SSH to reach [localhost.run](https://localhost.run). Port 22 is tried first, then 443 for networks that block it. If the tunnel drops it reconnects automatically — and because the URL changes, every connected client is notified.

While a tunnel is open, friend requests advertise the **tunnel** address rather than your LAN IP, so replies can actually reach you.

---

## How the AI works

- **1v1 chats** — every message goes to the model
- **Group chats** — the model answers when tagged with `@AI`, with the last 40 messages as context
- **AI runs on whichever machine hosts the configured `ai_host`** — by default the group admin's Ollama
- Generations are **serialised per host** with a bounded queue; excess requests are refused immediately rather than piling up
- Failures are stored in the chat, so a question is never silently ignored

---

## API reference

### Health
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | no | liveness |
| GET | `/api/health/ready` | no | readiness — fails if the database is unusable |
| GET | `/api/health/deep` | yes | breakers, queues, outbox, presence, memory |
| GET | `/api/info` | no | how to reach this machine + networking warnings |

### Auth
| Method | Path | Body |
|---|---|---|
| POST | `/api/auth/register` | `{username, password}` |
| POST | `/api/auth/login` | `{username, password}` |
| GET | `/api/auth/me` | — |

### Chats
| Method | Path | Notes |
|---|---|---|
| GET | `/api/chats` | list, with unread counts |
| POST | `/api/chats` | create |
| GET | `/api/chats/:id` | details, members, capacity |
| GET | `/api/chats/:id/messages` | newest page · `?after=` backfill · `?before=` older page · `?limit=` |
| POST | `/api/chats/:id/messages` | **HTTP send fallback** — same idempotency as the socket |
| POST | `/api/chats/:id/read` | `{seq}` — persist the read cursor |
| POST | `/api/chats/:id/invite` | `{inviteeUsername}` |
| PATCH | `/api/chats/:id/ai` | admin only |
| GET | `/api/chats/invites/pending` | |
| POST | `/api/chats/invites/:id/respond` | `{action}` |

### Friends
| Method | Path | Notes |
|---|---|---|
| GET | `/api/friends` | `{accepted, incoming, outgoing}` |
| POST | `/api/friends/add` | `{peerHost, peerUsername}` — **202** when queued for retry |
| POST | `/api/friends/:username/accept` | notifies the peer, queued if unreachable |
| POST | `/api/friends/:username/reject` | |
| DELETE | `/api/friends/:username` | |

### AI
| Method | Path | Notes |
|---|---|---|
| GET | `/api/ai/models?host=` | always 200 — an offline host is a state, not an error |
| GET | `/api/ai/status?host=` | includes circuit-breaker state |
| POST | `/api/ai/ask` | one-shot query |
| POST | `/api/ai/chat/:chatId` | context-aware query |
| GET | `/api/ai/diagnostics` | breaker + queue snapshot |

### Tunnel
| Method | Path |
|---|---|
| POST | `/api/tunnel/start` |
| DELETE | `/api/tunnel/stop` |
| GET | `/api/tunnel/status` |

### Federation (server-to-server, unauthenticated by design)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/federation/ping` | prove this address is SpockChat |
| GET | `/api/federation/lookup/:username` | confirm a user exists (returns id + name only) |
| POST | `/api/federation/friend-request` | inbound request |
| POST | `/api/federation/friend-response` | inbound accept/reject |

### Socket events

| Direction | Event | Payload |
|---|---|---|
| → server | `message:send` | `{chatId, content, clientMsgId}` → **ack** `{ok, message, duplicate, seq}` |
| → server | `chats:sync` | `{cursors}` → **ack** `{ok, chats:{[id]:{latestSeq, missed, complete}}}` |
| → server | `message:read` | `{chatId, seq}` |
| → server | `chat:join` · `typing:start` · `typing:stop` · `ai:query` · `ping:check` | |
| ← client | `ready` | chat ids, server time, limits |
| ← client | `message:new` · `message:failed` · `typing:update` | |
| ← client | `ai:thinking` · `ai:done` · `ai:error` · `ai:busy` | |
| ← client | `invite:received` · `member:joined` · `chat:updated` | |
| ← client | `friend:request` · `friend:response` | |
| ← client | `tunnel:state` · `server:shutdown` | |

---

## Configuration

Every value is optional and validated at boot — a bad value stops the server with an explanation instead of failing later. See [`.env.example`](.env.example) for the annotated list, or `server/config/index.js` for the source of truth.

The knobs that matter most:

| Variable | Default | Why you would change it |
|---|---|---|
| `JWT_SECRET` | random per process | **Set this.** Otherwise every restart logs everyone out. |
| `MAX_GROUP_MEMBERS` | `5` | bigger groups |
| `MAX_MESSAGE_LENGTH` | `8000` | longer messages |
| `AI_TIMEOUT_MS` | `120000` | slow models on first load |
| `AI_MAX_CONCURRENT` | `1` | a machine that really can run two models |
| `AI_BREAKER_FAILURES` | `4` | how tolerant to be of a flaky Ollama |
| `FEDERATION_ALLOW_PRIVATE_HOSTS` | `true` | set `false` to block LAN/loopback targets |
| `RATE_MESSAGES_PER_MIN` | `120` | busier groups |
| `TRUST_PROXY` / `PUBLIC_URL` | off | running behind nginx/Caddy |
| `LOG_LEVEL` / `LOG_JSON` | `info` / `false` | debugging or log shipping |

---

## Testing

```bash
npm test
```

99 tests across 26 suites, roughly 50 seconds. Every test spawns a **real server process** with its own database and port — migrations, boot sequence, graceful shutdown and two-server federation all run for real.

| Suite | Covers |
|---|---|
| `smoke` | boot, health, JSON 404s, malformed input, graceful shutdown, restart durability |
| `auth` | registration, login, tokens, cross-server token rejection, user enumeration, rate limits |
| `chat` | creation, access control, **the newest-page history regression**, pagination, invites, capacity, unread |
| `reliability` | acks, idempotency across transports, sequence contiguity, backfill, presence, back-pressure |
| `federation` | two live servers: handshake, lookup, both-sides-accepted, unreachable peers, **outbox retry** |
| `ai` | fake Ollama: success, unreachable, missing model, wrong software, empty reply, circuit breaker + recovery, 1v1 auto-reply, persisted failures, SSRF guard |
| `chaos` | packet loss (see below) |

```bash
npm run test:chaos
```

The chaos suite runs clients through a TCP proxy that severs half of all live connections every 30 ms, refuses connections outright, and delays traffic past the acknowledgement deadline. It asserts the delivery contract directly:

- 60 messages over a link losing connections constantly → **all 60 stored, zero duplicates, zero sequence gaps**
- Acknowledgements delayed past their timeout → retries happen, `duplicate: true` is returned, **exactly one row per message**
- A total 2.5-second blackout → queued messages delivered afterwards, nothing abandoned
- A client cut off mid-conversation → recovers exactly the messages it missed
- Three concurrent senders on a lossy link → **contiguous, gap-free sequence numbers**

Each of those tests also asserts that the proxy *actually* caused faults, so a passing run cannot be a false negative.

```bash
npm run health     # readiness of a running server, exit code 1 if not ready
```

---

## Security notes

- Passwords hashed with bcrypt (cost 12); login compares against a dummy hash for unknown users so response time does not reveal which accounts exist
- JWTs expire after 30 days; expired, malformed and unknown-account tokens are distinguished
- All data stays in a local SQLite file
- User-supplied hosts (`aiHost`, `peerHost`, `?host=`) are validated: http/https only, no credentials, no path, with an option to block private ranges (`FEDERATION_ALLOW_PRIVATE_HOSTS=false`) — this is the SSRF boundary
- Federation endpoints are unauthenticated by design (a peer has no account here) but are rate-limited, strictly validated, and cannot read another user's data
- Outbound responses are size-capped, so a hostile peer cannot stream the server out of memory
- Error responses never include stack traces in production
- **Set `JWT_SECRET` before sharing your address with anyone**
- **Stop the tunnel when you are done** — it is a public URL
- For permanent exposure, put SpockChat behind a reverse proxy with HTTPS and set `TRUST_PROXY=true`

---

## Roadmap

- [ ] End-to-end encryption for messages
- [ ] File and image sharing
- [ ] Message search across history
- [ ] mDNS auto-discovery on the LAN
- [ ] Federated group chat (members hosted on different servers)
- [ ] AI persona customisation per chat
- [ ] Electron desktop app

---

## Changelog

### v3.0.0 — Resilience *(latest)*
- **Added** exactly-once message delivery: idempotency keys, acknowledgements, per-chat sequence numbers, client outbox, HTTP fallback transport
- **Added** reconnect backfill via `chats:sync` — a client can prove it missed nothing
- **Added** circuit breakers, bounded queues, jittered retry and hard deadlines for Ollama and peer servers
- **Added** a durable federation outbox so peer calls survive an offline machine
- **Added** graceful shutdown, crash guards, health/readiness/deep-diagnostics endpoints
- **Added** an error taxonomy: every failure has a code, a message and an actionable hint
- **Added** rate limiting on auth, API, federation, messages and AI
- **Added** versioned database migrations, read cursors, unread counts
- **Added** a 99-test suite including a TCP-level packet-loss harness
- **Fixed** federation routes mounted at the wrong path — every friend add failed
- **Fixed** one-sided friend acceptance
- **Fixed** chat history returning the oldest page instead of the newest
- **Fixed** 1v1 AI chats never replying
- **Fixed** messages silently lost when the socket was down
- **Fixed** unbounded message size, HTML stack traces, HTML 200 for unknown API routes
- **Fixed** presence dropping a user's other tabs
- **Fixed** XSS via unescaped avatar initials; login-out on transient network errors
- **Changed** architecture to layered config/core/db/services/api/realtime
- **Removed** `node-fetch` and `uuid` in favour of platform built-ins

### v2.1.1 — Security & Cross-Network
- Built-in SSH tunnel, tabbed Add Friend modal, port 443 fallback
- Removed `localtunnel` and its deprecated transitive dependencies

### v1.0.0 — Foundation
- 1v1 and group chat, Socket.IO, @AI mentions, SQLite, bcrypt auth, friend system

---

## Contributing

1. Fork, branch, change
2. `npm test` must pass — add tests for new behaviour
3. Put business rules in `services/`, SQL in `db/repositories/`, and reusable primitives in `core/`
4. Every user-facing error needs a `code` and a `hint`
5. Open a PR with a clear description

---

## License

**GNU Affero General Public License v3.0 (AGPL-3.0)** — Copyright © 2025 SpockChat Contributors

SpockChat is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

SpockChat is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0) for details.

> **In practice:** use, modify and self-host freely. If you distribute a modified version — including running it as a network service for others — you must release your modifications under the same license.
