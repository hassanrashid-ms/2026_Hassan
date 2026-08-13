# Chat module — the core loop

**Date:** 2026-08-06
**Status:** Proposed
**Depends on:** [`2026-08-04-database-and-schema-design.md`](2026-08-04-database-and-schema-design.md),
[`2026-08-04-sdk-wire-contract.md`](2026-08-04-sdk-wire-contract.md)
**Supersedes (scope note):** the Step 5 line in the wire contract's build order —
*"`POST /conversations`, `POST /messages`, the real chat UI, the agent inbox"* — this document is
that step, narrowed to the smallest slice that proves the loop end to end.

This is the step the wire contract calls out as the payoff: *"player message → agent reply → player
sees it."* Steps 1–4 (auth seam, the four `/sdk/*` endpoints, the web surface stub, `GET
/sdk/unread`) are built. This is next.

## Scope

**In:**
- Player sends a message from the web support surface; a conversation is created or reopened.
- Conversation lands in `open`, unassigned.
- An agent claims it from an inbox and replies.
- Player sees the reply, live if connected, on next fetch otherwise.
- A minimal agent console: dev-picker login, inbox, conversation view.

**Out (deferred to later slices):**
- The bot. Every conversation in this slice skips `bot_active` and is created directly in `open` —
  the same path the status machine already defines for "bot errors/times out/disabled." No new
  status-machine rule is needed; this slice just always takes that branch.
- Forms, attachments, internal notes.
- Round-robin auto-assignment. Claiming is manual; every new/reopened conversation is unassigned.
- Real agent auth. Google OAuth is its own slice per
  [`2026-08-04-agent-auth-google-oauth.md`](../decisions/2026-08-04-agent-auth-google-oauth.md).
  This slice uses a dev picker instead.
- `delivered` in the delivery-state ladder. Only `sent` and `read` are written.

## Data model

No schema changes. `conversation` and `message` already carry everything this slice needs
(`status`, `assigned_agent_id`, `message_seq`, `author_type`, `visibility`, `delivery_state`).

**Reopen is a status write, not a new row.** A player has at most one conversation, ever, in this
slice (no separate `resolution_cycle` table exists yet — see `conversations.ts`'s own comment that
it is deliberately minimal). Sending into a `resolved`/`closed` conversation flips it back to
`open`, clears `assigned_agent_id` (back to the unassigned queue), and appends a
`conversation_reopened` event — all inside the same transaction as the message insert.

**Delivery state** takes two values here: `sent` (written on insert) and `read` (written by a
small batch endpoint when the thread is actually visible on screen — drives the unread badge
already surfaced by `GET /surface/bootstrap`).

## API surface

All new endpoints route through one shared function, `postMessage(tx, {...})`, so the "bump
`message_seq`, insert the message, append an event, all in one transaction, no I/O inside it" rule
lives in exactly one place. The player and agent routers differ only in which `authorType` they're
allowed to write and which serializer they read back with.

| Endpoint | Caller | Auth | What it does |
|---|---|---|---|
| `POST /surface/messages` `{ body }` | player | player JWT | find-or-create/reopen the player's conversation, `postMessage(authorType: 'player')`, emit to both socket rooms |
| `GET /surface/messages?session_id=` | player | player JWT | `{ conversation_id: string \| null, messages: [] }` for the player's conversation, `toPlayerView` — `conversation_id: null` and an empty list if none exists yet. `session_id` is validated but **not** consulted, see the note below |
| `POST /surface/messages/read` | player | player JWT | mark everything up to a given `seq` as `read` |
| `GET /agent/conversations?status=unassigned\|mine` | agent | stub session | inbox rows: id, player, status, last message preview |
| `POST /agent/conversations/:id/claim` | agent | stub session | `UPDATE ... SET assigned_agent_id = :agent WHERE id = :id AND assigned_agent_id IS NULL`; zero rows affected is "already claimed," not an error |
| `GET /agent/conversations/:id/messages` | agent | stub session | full history, `toAgentView` |
| `POST /agent/messages` `{ conversation_id, body }` | agent | stub session | `postMessage(authorType: 'agent')`; requires caller to be `assigned_agent_id` on that conversation |
| `POST /agent/messages/read` | agent | stub session | mark everything up to a given `seq` as `read` |

Module lives at `backend/src/agent/` (renamed from the already-scaffolded `agentside/`), mirroring
`backend/src/surface/`'s router/controller/service split.

## Realtime

Two Socket.io rooms per conversation, per the schema design doc: `conv:{id}:player` and
`conv:{id}:agents`. Every emit is two explicit `.to(room).emit()` calls with two different
serializers — never a single emit both sides subscribe to — so there is no code path where a raw
row reaches a socket.

Agents additionally join one workspace-wide room, `workspace:{id}:inbox`, on connect. Creating,
reopening, or claiming a conversation emits a small `conversation:changed` event there (id and
new status only, not the full row) — the inbox list treats it as a cue to refetch via TanStack
Query invalidation, not as data to render directly. This keeps the socket payload from drifting
out of sync with the REST response shape, and means new unassigned conversations appear in the
inbox live instead of on a poll.

**REST is the write path; sockets are push-only.** `POST .../messages` returns the created message
directly — that response *is* the send confirmation. The socket emit exists only to update *other*
participants live. A client that misses the socket event still sees the message on its next `GET
.../messages`, matching the "push is best effort, fetch-on-open is the guaranteed path" rule
`GET /sdk/unread` already established.

**Auth is on connect, not per-message.** Player socket handshake carries the same player JWT used
for REST. Agent socket handshake carries the stub session token from the dev picker. The player
joins `conv:{id}:player` as soon as a conversation id is known — either from `GET
/surface/messages` on load (a returning player already has one) or from the response to their
first `POST /surface/messages` (a first-time player didn't have one until that call returned).
There is nothing to subscribe to only in the narrow window before either of those has happened.

## UI

**Player side** (`frontend/src/pages/SupportSurface.tsx`): "Still need help?" and "Talk to a
person" both reveal the same chat panel — the bot is skipped in this slice, so there's no
divergent path between the two buttons.

- `ChatThread`: `react-virtuoso`, `followOutput="auto"` — sticks to bottom on new messages,
  doesn't yank the viewport if the player has scrolled up.
- A plain `<textarea>` composer. TanStack Query mutation for the send; optimistically appends the
  message as `sending`, reconciles to `sent` on response, shows a retry affordance on error.
- Marks-read fires off a visibility check against the last message in view, batched rather than
  per-message.

**Agent console** (new, minimal):
- `/login`: dev picker listing seeded agents; selecting one sets the stub session.
- `/inbox`: two lists, Unassigned and Mine. Claim button per unassigned row.
- `/conversations/:id`: same `ChatThread`/composer pair as the player side (serializer-agnostic —
  it renders `{authorType, body, createdAt}`), pointed at the agent endpoints and socket room.

`ChatThread` and the composer live in one shared location and are reused by both surfaces — only
the API calls and socket room differ between the two callers, which is what keeps them changeable
independently.

**Deferred for this slice, brought in now as dependencies rather than rolled by hand:**
- `react-virtuoso` — chat scroll anchoring is a two-day trap if hand-rolled.
- TanStack Query (already the console's stack choice) — its mutation lifecycle plus
  `Idempotency-Key` gives `sending → sent` almost for free.
- No Tiptap, no react-dropzone/presigned-PUT yet — no rich text and no attachments in this slice.

## Error handling

- **RLS-shaped 404s, not 403s**, for the same reason as everywhere else in this codebase: an
  agent hitting an endpoint for a conversation outside their workspace gets a 404, indistinguishable
  from "never existed."
- **`GET /surface/messages` never 404s on `session_id`** — superseded 2026-08-13 by
  [`2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md`](2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md).
  As built, this endpoint rejected any `session_id` with no row, which is the normal state while
  `POST /sdk/sessions/start` is still queued in the Outbox (2s boot delay, skipped entirely under
  `offlineDryRun`). The 404 cost the webview its `conversation_id`, so it never emitted
  `join_conversation` — no history and no socket room, which looked like two devices holding
  independent threads. The gate protected nothing: the thread is resolved from the token's
  `player_id` under RLS, so a foreign `session_id` cannot name a foreign conversation. It is now
  accepted, validated (`BootstrapQuery`, still the React Query cache key) and ignored.
  **Do not reintroduce a session gate on a read path that RLS already scopes.**
- **Claim race**: zero rows updated is a normal response (`{ claimed: false }`), not an error — the
  UI shows "already claimed" and refreshes the inbox row.
- **Reply to an unassigned or someone-else's conversation** is a 403 (this one *is* a real
  permission failure, not a tenancy question) — enforced at the API, not hidden in the UI.
- **Socket disconnect** is invisible to correctness: the REST send path doesn't depend on the
  socket being up, and `GET .../messages` is always the source of truth on reconnect/reload.
- **Empty message body** is rejected client-side and re-validated server-side (`422`); there's no
  scenario where an empty send is a meaningful state to persist.

## Testing

- Cross-workspace isolation sweep for the four new endpoints, extending the existing
  `isolation.test.ts` pattern — agent from workspace A must 404 against workspace B's conversation
  ids.
- Claim race: two concurrent `POST /claim` calls against the same conversation; exactly one
  succeeds.
- Reopen: send into a `resolved` conversation, assert status flips to `open`,
  `assigned_agent_id` clears, and a `conversation_reopened` event is appended.
- Visibility: agent-authored message never appears in `toPlayerView` with `visibility: 'internal'`
  set manually in a test row (guards the serializer split even though this slice never writes
  `internal` itself) — cheap insurance for the day internal notes ship.
- Socket rooms: an agent socket in `conv:{id}:agents` never receives an emit intended for
  `conv:{id}:player` and vice versa, asserted directly against the Socket.io server in-process.
- Message ordering: concurrent sends into the same conversation never produce a duplicate `seq`
  (unique index already enforces this at the DB level; the test proves the app doesn't retry in a
  way that violates it).

