# Internal notes & the awaiting-player/reopen loop

**Date:** 2026-08-06
**Status:** Proposed
**Depends on:** [`2026-08-06-chat-module-design.md`](2026-08-06-chat-module-design.md) — this
picks up the "Out" list item that slice explicitly deferred: *"Forms, attachments, internal
notes."*

## Scope

**In:**
- Agent console: a Public reply / Internal note toggle on the composer. Internal notes are
  visually distinct (amber) and never reach a player, by construction of the existing
  `toPlayerView`/`toAgentView` split and separate socket rooms.
- Sending a **public** reply while a conversation is `open` auto-transitions it to
  `awaiting_player` — no manual status button. Internal notes never trigger this.
- Player support surface: when the conversation is `resolved` or `closed`, show a banner
  ("Your ticket is resolved." / "Still facing issues?") with a button that reopens the
  conversation by sending a fixed message, reusing the reopen behavior `sendPlayerMessage`
  already implements.

**Out (deferred):**
- `resolution_cycle` table and true resolution-cycle metrics. This slice's "resolved" stays a
  bare `conversation.status` write, same minimal shape the schema is already in.
- Any manual "Mark Awaiting Player" / "Mark Resolved" agent control. Both are automated, per the
  In section above — an assigned agent's status changes are a side effect of sending a message,
  never a separate action.
- `escalated`, the inactivity clock, and the bot's own resolve path (player confirms bot's
  answer). Untouched by this slice.
- Server-side enforcement of the transition table beyond the one new transition
  (`open → awaiting_player`) — sending a public reply from any other status is a no-op on
  status, not rejected.

> **Superseded in part (2026-08-11):** scoping this slice to the forward flip alone left
> `awaiting_player → open` (player replies) unimplemented, so a conversation stayed in Awaiting
> Player after the player had answered. That transition now ships in `sendPlayerMessage`. The
> rest of this "out of scope" list still stands — see `docs/status-transitions.md` for the
> current per-transition build state.

## Internal notes

**Data model:** no schema changes. `message.visibility` (`'public' | 'internal'`, default
`'public'`) already exists; `postMessage` already accepts and stores it. Nothing before this
slice ever passed a value other than the default.

**Wire contract:** `SendAgentMessageBody` (`packages/types/src/chat.ts`) gains
`visibility: z.enum(['public', 'internal']).default('public')`. `sendAgentMessage`
(`backend/src/agent/services/messagesService.ts`) passes `body.visibility` straight into the
existing `postMessage` call.

**Leak prevention is structural, not new:** `toPlayerView` already returns `null` for any row
whose `visibility !== 'public'`; `emitMessageToRooms` already skips the player-room emit when
its player payload is `null`. This slice is the first to actually exercise that path with a
non-default value — see Testing.

**Event payload:** `message_sent`'s payload gains `visibility` alongside the existing `seq` /
`author_type`, for future internal-note reporting without a new event type.

**Frontend:**
- `ChatMessage` (`frontend/src/components/chat/types.ts`) and the agent's mapping from
  `AgentMessageView` gain `visibility`. `ChatThread` renders `visibility === 'internal'` rows
  with a `chat-message--internal` class (amber). The player-facing `SupportSurface` consumes
  `PlayerMessageView`, which has no `visibility` field — there is no code path for it to render
  one.
- `Composer` gains a Public/Internal toggle, used only by the agent console (the player
  surface's `Composer` usage passes no visibility and defaults to public). The toggle resets to
  Public after every send.

## Auto status transition: `open → awaiting_player`

Inside `sendAgentMessage`'s existing transaction, after the existing lookup of
`{ id, assignedAgentId }`, also select `status`. If `body.visibility !== 'internal'` (i.e. a
public reply) and `status === 'open'`:
- Update `conversation.status = 'awaiting_player'`.
- `appendEvent(tx, { type: 'conversation_awaiting_player', conversationId, actorId: ctx.agentId,
  actorType: 'agent' })` — same shape as `sendPlayerMessage`'s existing
  `conversation_reopened` event.
- After commit, `emitInboxChanged(getIo(), ctx.workspaceId, conversationId, 'awaiting_player')`,
  mirroring the existing `inboxStatus` pattern in `sendPlayerMessage` and the claim handler.

Any other current status is left untouched — this is the one documented transition
(`docs/project-overview.md`'s status machine: *"`open` → `awaiting_player` — Agent asks
something and marks waiting"*), now automatic instead of a button. Internal notes never reach
this branch at all.

## Player reopen banner

**Data model:** no schema changes. `sendPlayerMessage`'s existing `REOPENABLE_STATUSES` handling
(`resolved`, `closed` → `open`, unassign, append `conversation_reopened`) already does everything
the reopen needs to do.

**Wire contract:** `PlayerMessagesResponse` (`packages/types/src/chat.ts`) gains
`status: ConversationStatusValue`, populated by `getPlayerMessages`.

**Frontend (`SupportSurface.tsx`):** when `messagesQuery.data.status` is `resolved` or `closed`,
render a banner above the composer: "Your ticket is resolved." and "Still facing issues?" with a
"Yes" button. The button calls the existing `send.mutate(...)` with a fixed body,
`"I'm still facing issues."` — no new endpoint. The existing `message:new` socket
handler / refetch (already wired in this component) picks up the resulting status change and the
banner disappears once the refetched `status` is `open`.

## Testing

- `agent.messages.test.ts`: an internal-note send stores `visibility: 'internal'` and leaves
  `status` unchanged even when the conversation was `open`.
- `agent.messages.test.ts`: a public reply from `open` flips `status` to `awaiting_player` and
  appends `conversation_awaiting_player`; the same send from any other status leaves `status`
  unchanged.
- Realtime leak test (extends `realtime.rooms.test.ts` or a new file): posting an internal note
  through `sendAgentMessage` end-to-end never emits to `conv:{id}:player` — asserts on the
  connected player socket receiving nothing, not just the existing unit-level
  `toPlayerView(...) === null` assertion in `domain.serializers.test.ts`.
- `surface.messages.test.ts`: `GET /surface/messages` response includes `status` and contains no
  `visibility`/internal-only fields.
- `surface.messages.test.ts`: sending on a `resolved` conversation flips it to `open` (existing
  coverage for `resolved`/`closed` reopen already exists for this path — extend rather than
  duplicate).
- Frontend: no new automated tests. Manually verify the toggle, amber note styling, and the
  reopen banner in a running dev server before calling this done.
