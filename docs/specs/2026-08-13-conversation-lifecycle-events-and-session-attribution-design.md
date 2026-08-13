# Conversation Lifecycle Events & Session Attribution — Design

Date: 2026-08-13
Status: implemented

## Problem

Three gaps, found while investigating why an Android build and a Unity editor
Play-mode session — both using the same `UnsafeStaticTokenProvider` token, and so
the same player — appeared to hold two independent chat threads.

**1. The threads were never split.** The database holds exactly one conversation
for that player (`b0ec8ed3…`, 45 messages). `sendPlayerMessage` resolves the
thread by `player_id` alone, so a second thread is not reachable by construction.
What the player saw was a rendering failure: `getPlayerMessages` returns `null`
when the request's `session_id` has no row, the controller turns that into a 404,
the webview therefore has no `conversation_id`, and `SupportChat.tsx` only calls
`join_conversation` when that id exists. No history, no socket room, no live
sync — each device showed only its own optimistic bubbles.

The session row is missing whenever `POST /sdk/sessions/start` has not landed
yet: it is queued through the Outbox behind a 2s boot delay, and is skipped
outright under `offlineDryRun`.

**2. Conversation lifecycle is unrecorded.** Creating a conversation writes no
event at all. The `bot_active` default status is invisible. `bot_handoff` exists
but its payload is `{ reason }` only — it does not record which agent
`assignOnHandoff` just selected. `claimConversation` writes no event, so an agent
taking a conversation from the unassigned queue leaves no trace.

**3. Nothing is attributable to a session.** `event.session_id` and the
`event_session_type_idx` index on `(session_id, type)` both exist, but only
`session_start`, `session_end` and `sdk_incident` populate the column. No
conversation or message event does. "Which conversations were opened during this
session" is not answerable, which undermines the self-serve rate — counted per
session, never per ticket.

## What already exists (do not rebuild)

| Piece | Location |
|---|---|
| `event.session_id` + FK + `event_session_type_idx` | `backend/src/shared/db/schema/events.ts:28,39` |
| `event.type` as free `text` — "new types arrive every slice" | `backend/src/shared/db/schema/events.ts:23` |
| `appendEvent`, the only permitted writer | `backend/src/shared/events/appendEvent.ts:31` |
| `conversation.session_id`, set once at creation | `backend/src/shared/db/schema/conversations.ts:32` |
| Latest-session lookup already inside the create branch | `backend/src/surface/services/messagesService.ts:42` |
| `bot_handoff`, `bot_unavailable`, `intent_set` | `backend/src/domain/bot/applyBotTurn.ts:62,101,139` |
| `assignOnHandoff` — least-loaded agent selection | `backend/src/domain/bot/assignOnHandoff.ts:12` |
| `conversation_reopened`, `conversation_player_replied` | `backend/src/surface/services/messagesService.ts:60,74` |
| Session ownership check (the pattern to reuse) | `backend/src/surface/services/bootstrapService.ts:26` |
| `boot.sessionId`, parsed synchronously from the URL | `frontend/src/lib/boot.ts:16` |

**No migration.** `event.type` is `text`, not an enum, and `event.session_id`
already exists. Every change below is application code.

## Part 1 — Thread sync

Delete the session gate in `getPlayerMessages`:

```ts
const [ownedSession] = await tx.select(…)          // remove
if (!ownedSession) return null                     // remove
```

The thread is resolved from `ctx.playerId` under RLS, which the player token
already grants. The session check was never protecting data — it only converted
"your session has not uploaded yet" into a 404 that killed history *and* the
socket join.

`session_id` stays a required, validated query param: `BootstrapQuery` is shared
with bootstrap, the frontend already sends it, and it is the React Query cache
key. It simply stops gating. A comment records why it is accepted and ignored.

`getPlayerMessages` can no longer return `null`, so the controller's 404 branch
becomes unreachable. Drop the branch and narrow the return type rather than
leaving a dead path.

### Test that changes

`backend/tests/surface.messages.test.ts:258` — *"404s for a session_id that is
not the caller's own"*. The isolation intent survives and stays tested; the
assertion becomes **"a foreign `session_id` is ignored and the caller receives
their own thread"**. No isolation guarantee weakens: the conversation is resolved
from the token's `player_id` under RLS either way, and a foreign session id
cannot name a foreign conversation because it is no longer consulted.

## Part 2 — The session attribution rule

> **An event carries `session_id` when a verified player session accompanied the
> request that caused it. Otherwise `null`.**

Everything below follows from that one rule. Nulls are deliberate, not gaps: an
event written by a background worker has no session, and inventing one would
produce a wrong answer for the `(session_id, type)` index rather than no answer.

### The client supplies it

`POST /surface/messages` gains one optional field:

```
{ "body": "hello", "session_id": "7abc6c55-…" }
```

There is no latency cost. `readBoot` parses `session_id` from `location.search`
on first mount — synchronous, no network, and explicitly not dependent on
bootstrap having succeeded. `boot.sessionId` is already in scope in the send
mutation at `SupportChat.tsx:57`.

`/surface/*` is not part of the frozen SDK wire contract — it "ships with the
page that consumes it" — so adding a field here carries none of the
shipped-Unity-build constraints that apply to `/sdk/*`.

### The server must verify it, and must never fail the send

`event.session_id` is a FK with `ON DELETE RESTRICT`. A `session_id` whose row
has not arrived yet — the Outbox case that produced this whole investigation —
would violate the constraint, roll back the transaction, and **fail the player's
message**. That directly violates *nothing may prevent a player reaching a
human*.

So, one scoped lookup at the top of `sendPlayerMessage`:

```ts
const [verified] = await tx
  .select({ id: session.id, entryPoint: session.entryPoint })
  .from(session)
  .where(and(eq(session.id, body.session_id), eq(session.playerId, ctx.playerId)))
  .limit(1)
const sessionId = verified?.id ?? null
```

`entry_point` is selected here because it is the payload of `conversation_opened`
and it lives on the session row. When the session is unverifiable both the stamp
and `entry_point` are `null` — an unknown entry point is recorded as unknown, not
guessed from a different session.

`null` on any miss — absent field, unknown id, another player's id, not yet
uploaded. The send always proceeds. This lookup is mandatory for tenant safety
regardless (`appendEvent`'s contract: FK checks bypass RLS, so a client-supplied
id must be confirmed visible first), and it doubles as the value for
`conversation.session_id` at creation, so it is one indexed primary-key lookup
for both purposes.

### `conversation.session_id` keeps its current meaning

Set once, at creation, to the **originating** session; never rewritten on reopen.
It is not audit data — it is the pointer an agent's Game View follows to reach
`player_state_snapshot`, so it must show the player's state *when the problem
happened*, not their state today.

The only change is accuracy. Today it is `order by started_at desc limit 1` over
all the player's sessions — a proxy that is correct with one live device and
wrong with two, which is the normal state of a dev machine running an Android
build and the editor at once. It becomes the verified session from the request,
falling back to today's lookup when that is `null`, so behaviour is unchanged
when the client sends nothing.

Note that nothing reads this column yet — repo-wide, the only references outside
the schema are two comments. The Game View that consumes it is unbuilt. That
raises the cost of writing a guess into it, not lowers it.

## Part 3 — Events

### New

| Event | Written in | Payload | `session_id` |
|---|---|---|---|
| `conversation_opened` | `sendPlayerMessage`, `!existing` branch, same tx as the insert | `{ entry_point }` | verified |
| `conversation_assigned_bot` | same tx, immediately after | `{}` | verified |
| `conversation_assigned` | `claimConversation` | `{ agent_id, via: 'claim' }` | null |

`conversation_assigned_bot` carries no `provisioned` flag. At insert time
`resolveBotConfig` has not run, and the not-provisioned outcome is already
recorded by the existing `bot_unavailable` event. Adding the flag would mean
reordering the transaction to obtain information already available elsewhere.

`conversation_assigned` uses `via: 'claim'` so a future auto-assignment path can
write the same event type with a different `via` rather than a second type.

`claimConversation` currently returns without writing anything; the event goes
inside its existing transaction, guarded by the same `claimed` check so a losing
racer writes nothing.

### Extended

`bot_handoff` gains `assigned_agent_id` in its payload — `assignOnHandoff`
already computed it two statements earlier and it is currently discarded. `null`
is a legitimate value: the function returns `null` when no active agent exists,
and that is explicitly not an error.

### Stamped

| Event | `session_id` | Why |
|---|---|---|
| `message_sent` (player-authored) | verified | player POST |
| `message_sent` (agent / bot / system) | null | no player request |
| `conversation_opened` | verified | |
| `conversation_assigned_bot` | verified | same tx |
| `conversation_reopened` | verified | the **reopening** session, not the originating one |
| `conversation_player_replied` | verified | already exists, free to stamp |
| `bot_handoff` | null | BullMQ worker, no request |
| `conversation_assigned` | null | agent console, no player session |

`postMessage` gains an optional `sessionId` parameter, threaded through to its
`message_sent` event. Agent, bot and system callers omit it and get `null`.

On reopen the row and the events now say different things, deliberately:
`conversation.session_id` says **where it began**, `conversation_reopened.session_id`
says **where this reopen happened**.

### Explicitly out of scope

`sessionId` is not threaded into `applyBotTurn`. Its events — `bot_handoff`,
`bot_unavailable`, `intent_set` — are bot-authored and run inside the BullMQ
worker in the general case, but inline from `sendPlayerMessage` on the
not-provisioned path. Threading it would stamp them roughly half the time.
Consistent nulls beat inconsistent stamps.

## Testing

| Area | Assertion |
|---|---|
| Sync | GET with an unknown `session_id` returns 200 and the caller's full thread |
| Sync | GET with another player's `session_id` returns the caller's own thread, never the other player's |
| Sync | Response carries a non-null `conversation_id` when a conversation exists, regardless of session state |
| Events | First player message writes `conversation_opened` + `conversation_assigned_bot`, both stamped |
| Events | Second message writes neither |
| Events | Reopen writes `conversation_reopened` stamped with the *reopening* session while `conversation.session_id` is unchanged |
| Events | `bot_handoff.payload.assigned_agent_id` matches `conversation.assigned_agent_id`, and is `null` when no active agent exists |
| Events | Claim writes `conversation_assigned`; a losing concurrent claim writes nothing |
| Session | Unknown / foreign / absent `session_id` → events stamped `null` **and the message still sends** |
| Session | `conversation.session_id` is the verified request session, not the latest-started one, when two sessions are open |
| Isolation | A foreign `session_id` never causes a cross-tenant FK write (`isolation.test.ts` row counts) |

The "message still sends" case is the important one — it is the FK-rollback
failure mode, and it maps directly to a non-negotiable constraint.

## Constraints honoured

- **Nothing may prevent a player reaching a human.** An unverifiable session
  degrades to a `null` stamp; it never fails a send.
- **Nothing is deleted.** All changes are additive: new event types, one new
  payload field, one new optional request field. The only removal is a gate that
  produced a wrong 404.
- **Events are a projection.** Every new event is written through `appendEvent`,
  inside the transaction that writes the mutable row.
- **Payloads are snapshotted literals.** `agent_id` and `assigned_agent_id` are
  ids, not FK-resolved names.
- **`entryPoint` is context, never classification.** `conversation_opened`
  carries it as context only; `classification_source` is untouched.
