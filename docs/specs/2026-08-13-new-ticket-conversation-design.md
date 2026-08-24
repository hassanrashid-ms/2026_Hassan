# True new-ticket conversation

Status: approved
Companion to: 2026-08-13-chat-resolution-banner-ux-design.md (frontend button lives there)

## Problem

Today a player has at most one conversation, ever — `sendPlayerMessage` finds the existing
conversation by `player_id` and either creates it (first message), reopens it (status
`resolved`/`closed`), or appends to it. There is no way for a player to close a ticket for good
and start a genuinely separate one; "Still facing issues?" only ever reopens the same row
(`docs/specs/2026-08-06-chat-module-design.md:40`).

"Open a new ticket" (added to the resolved banner in the companion spec) needs a real second
conversation row, with the old one closed and never reopened again.

## Scope check

The invariant is not DB- or RLS-enforced — no unique index on `conversation.player_id`, and every
FK from `message`/`event` already points at `conversation.id`, not `player_id`. It lives entirely
in application code: three "find latest conversation by player_id" query sites, the
create/reopen/append branch in `sendPlayerMessage`, and two unread-count aggregates. No schema
migration is needed.

## Design

### Concurrency model: one live conversation at a time

"Open a new ticket" is only reachable from the resolved banner, so by construction the player's
latest conversation is already `resolved` or `closed` when this fires. The new endpoint enforces
that explicitly rather than relying on the UI:

- If the latest conversation's status is not `resolved` or `closed` → `409 conversation_still_open`.

This keeps "find latest conversation by player_id, ordered by `created_at desc`" a valid way to
resolve "the player's current conversation" everywhere else in the codebase — old, closed
conversations sit in history and are never the latest, so `sendPlayerMessage`, `getPlayerMessages`,
and `answerResolution` need no changes.

### New endpoint: `POST /surface/new-ticket`

Player-authenticated (same token/session pattern as other `/surface/*` routes). No request body
beyond the standard session identification.

In one transaction:

1. Lock and re-check the latest conversation for `ctx.playerId` is `resolved` or `closed` (guards
   the race between two rapid taps).
2. Update it to `status: 'closed'` (even if it was already `resolved` — "open a new ticket" is a
   deliberate close, not a no-op) and write a `conversation_closed` event, payload snapshotting
   the prior status.
3. Insert a new `conversation` row: `status: 'bot_active'`, current `session_id`, same
   `workspace_id`/`player_id`. Write `conversation_opened` for it, per the existing rule that
   entering a state is always a state change.
4. Return the new conversation's id/status (shape mirrors what `sendPlayerMessage` returns on
   first-message creation, so the frontend can reuse existing response handling).

Register the route + Zod schema in `backend/src/docs/openapi.ts`.

### Unread count — scope to the live conversation, not all history

`bootstrapService.ts` (`loadBootstrap`) and `backend/src/sdk/services/unreadService.ts`
(`getUnreadCount`) both currently join `message` → `conversation` filtered only by
`eq(conversation.playerId, ctx.playerId)`, so once a player has closed history, the count would
start summing unread messages across every past ticket instead of just the current one.

Fix: constrain the join to the player's latest conversation id, not just their `player_id`.
Concretely, resolve the latest conversation id first (same query shape already used in
`sendPlayerMessage`/`answerResolution`: `order by created_at desc, limit 1`), then filter the
`message` count to `conversation_id = <that id>`. The count itself is unchanged — still
`count(*)` of unread/public/non-player messages — only the scope narrows from "all of this
player's conversations" to "their current one."

### Frontend (companion spec owns the button; this spec owns the call)

On success, the webview:

- Clears the `playerMessages` query cache entry for the old conversation/session.
- Invalidates so the next fetch picks up the new (empty) conversation — same "Say hello" empty
  state as a brand-new player.

### Docs to update

- `docs/specs/2026-08-06-chat-module-design.md:40-44` — reopen-is-not-a-new-row language needs a
  carve-out for the explicit new-ticket path.
- `docs/specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md:12-14` —
  "the database holds exactly one conversation for that player" is no longer universally true;
  qualify as "at most one _live_ conversation."

### Tests

- New-ticket endpoint: 409 when latest conversation is not resolved/closed.
- New-ticket endpoint: old conversation ends up `closed` with a `conversation_closed` event; new
  conversation has its own `conversation_opened` event.
- After a new ticket, sending a message never reopens the old (now closed) conversation — it
  appends to the new one.
- Unread count only reflects the latest conversation's unread messages, verified with a player who
  has one closed conversation with unread agent messages and one fresh open conversation.

## Out of scope

- Merging or cross-linking old/new conversations in the agent console UI (they already show as
  separate rows keyed by `conversation.id` — no code change needed there).
- Allowing more than one live (non-closed) conversation per player at a time.
