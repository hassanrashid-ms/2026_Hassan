# Read Receipts — Design

Date: 2026-08-11
Status: approved, not yet implemented

## Problem

A message sender has no idea whether the other side saw it. The database already
tracks `message.delivery_state` and both surfaces already mark incoming messages
read, but three things are missing:

1. **No timestamp.** `delivery_state` flips `sent → read` and the *when* is lost.
2. **No realtime push.** Nothing notifies the *sender* that their message was
   read, so a receipt only appears after an unrelated refetch.
3. **No UI.** Neither thread renderer draws a tick. `sending` and `failed` are
   the only delivery states with any visual treatment.

## What already exists (do not rebuild)

| Piece | Location |
|---|---|
| `message_delivery_state` enum incl. `read` | `backend/src/shared/db/schema/enums.ts:20` |
| `message.delivery_state`, defaults `sent` | `backend/src/shared/db/schema/conversations.ts:62` |
| `POST /surface/messages/read` → `markPlayerMessagesRead` | `backend/src/surface/services/messagesService.ts:115` |
| `POST /agent/messages/read` → `markAgentMessagesRead` | `backend/src/agent/services/messagesService.ts:68` |
| Player marks read on thread render | `frontend/src/surfaces/webview/pages/SupportChat.tsx:86` |
| Agent marks read on thread open | `frontend/.../Inbox/components/ThreadPanel.tsx:67` |
| `delivery_state` in both serializers | `backend/src/domain/conversations/serializers.ts:18,32` |

Both mark-read paths already carry a `ne(deliveryState, 'read')` guard, which is
what makes first-read-wins possible without extra logic.

## Semantics

Ticks render **only on the viewer's own outbound public messages** — the player
sees them beneath player-authored bubbles, the agent beneath agent-authored ones.

| `delivery_state` | Render |
|---|---|
| `sending` | "Sending…" (unchanged) |
| `sent` | one tick, muted / `currentColor` at reduced opacity |
| `read` | two ticks, blue |
| `failed` | "Not sent. Retry" (unchanged) |
| `delivered` | rendered as `sent`; still never written by any code path |

Rules that fall out of this:

- **Internal notes never get a tick.** Nobody on the other side can see the
  message, so any tick would be false. Gate on `visibility !== 'internal'`.
- **Blue means a human saw it.** While a conversation is `bot_active`, a player's
  message stays on one grey tick until an agent opens the thread. Bot ingestion
  does not flip the state, and must not be made to.
- **Bot and system messages get no tick** — they are not "own" messages for
  either viewer.
- `read_at` is never rewritten. First read wins.

## Data

One additive column:

```ts
// backend/src/shared/db/schema/conversations.ts, in `message`
readAt: timestamp('read_at', tz),   // null until first read
```

Set in the same `UPDATE` that sets `delivery_state`, in both services:

```ts
.set({ deliveryState: 'read', readAt: new Date() })
```

The existing `ne(message.deliveryState, 'read')` predicate keeps this
idempotent — a second mark-read for the same seq range matches zero rows, so
`read_at` cannot drift forward.

Schema changes reach the database through `drizzle-kit push` inside
`pnpm db:setup` (`backend/src/shared/db/setup.ts`), not a hand-written migration
file. No backfill: pre-existing rows keep `read_at` null and render one tick,
which is the honest answer for a message whose read time was never recorded.

RLS is unaffected — `message` already has a policy and no new table is added.

### Rejected alternatives

- **Separate `message_read_receipt` table.** Correct if several distinct readers
  per message needed independent tracking. Each side of a conversation has one
  reader identity (the player; whichever agent is looking), and the tick is
  binary, so the join buys nothing.
- **An `event` row per read.** The `event` table is append-only audit. A read
  receipt fires on every thread open, which would swamp real state transitions.

## Wire contract

Add to `PlayerMessageView` in `packages/types/src/chat.ts` (and therefore to
`AgentMessageView`, which extends it):

```ts
read_at: string | null   // ISO 8601
```

Both serializers emit it. **Adding a response field is explicitly permitted** by
the frozen SDK contract rule in `CLAUDE.md`; removing or retyping one is not.

New socket event payload, also in `packages/types/src/chat.ts`:

```ts
export type MessageReadEvent = {
  conversation_id: string
  up_to_seq: number
  reader_type: 'player' | 'agent'
  read_at: string
}
```

## Realtime

New emitter beside `emitMessageToRooms` in
`backend/src/shared/realtime/emit.ts`, keeping that module transport-only:

```ts
export function emitReadReceipt(io: Server, conversationId: string, room: 'player' | 'agents', payload: unknown): void
```

Routing — each side receives receipts for *its own* messages and never an echo
of its own action:

| Who marked read | Emit `message:read` to |
|---|---|
| Agent (`markAgentMessagesRead`) | `conv:{id}:player` |
| Player (`markPlayerMessagesRead`) | `conv:{id}:agents` |

The payload is a high-water `up_to_seq` plus a timestamp. **No message bodies
cross rooms**, so the two-serializer safety rule is untouched by design rather
than by discipline.

Emit **after** the transaction commits, matching how `sendPlayerMessage` and
`sendAgentMessage` already order their emits. Both services currently return
`boolean` from inside `withWorkspace`; they need to return the conversation id
and the row count so the caller can emit once, outside the transaction, and skip
the emit entirely when nothing changed. Both controllers already discard that
return value (`surface/controllers/messagesController.ts:39`,
`agent/controllers/messagesController.ts:32` both `await` and ignore it), so
widening the return type touches no caller and the HTTP response shape is
unchanged.

`backend/src/docs/openapi.ts` needs no edit: it registers paths only, with
`responses: { 200: { description: … } }` and no message response schema to
extend. Both read endpoints are already registered. The `CLAUDE.md` rule covers
*new* endpoints; this feature adds none.

## Frontend

**New shared component** `frontend/src/features/chat/components/DeliveryTicks.tsx`

- Props: `{ deliveryState?: ChatDeliveryState }`. Returns `null` for
  `sending` / `failed` / `undefined` — those already have their own treatment.
- Renders one or two overlapping `lucide-react` `Check` glyphs.
- Styled with bare Tailwind utilities, per the note at the top of
  `ChatThread.tsx`: this component is shared, and each surface defines its own
  tokens in its own scoped stylesheet, so a hand-written CSS rule would land on
  whichever global stylesheet loaded last.
- Grey state uses `currentColor` at reduced opacity so it inherits the bubble's
  foreground. Read state uses an explicit blue utility — blue is the signal the
  feature is *about*, and own-bubbles are already accent-coloured on both
  surfaces, so inheriting would erase it.
- Accessibility: glyphs are `aria-hidden`, paired with a visually-hidden
  `<span>` reading "Sent" or "Seen". Colour is never the only carrier.

**`frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx`** — render
`<DeliveryTicks>` in the existing metadata row next to `<time>`, when `own`.

**`frontend/src/features/chat/components/ChatThread.tsx`** — same, when
`isOwn && !isInternal`.

**`frontend/src/features/chat/components/types.ts`** — add `readAt?: string | null`
to `ChatMessage`, mapped in both `toChatMessage` functions
(`SupportChat.tsx:14`, `ThreadPanel.tsx:14`). Carried for tooltip/debug use; the
tick itself keys off `deliveryState` alone.

**Socket handlers** — both existing socket effects (`SupportChat.tsx:71`,
`ThreadPanel.tsx:54`) gain a `socket.on('message:read', …)` that invalidates the
same message query they already invalidate for `message:new`. No new cache
surgery, no new query key.

## Testing

| Test | Where | Asserts |
|---|---|---|
| `read_at` set on first read | `backend/tests/surface.messages.test.ts` | column populated, `delivery_state = 'read'` |
| `read_at` stable on re-read | same | second call with same `up_to_seq` leaves `read_at` unchanged |
| Agent read sets `read_at` on player messages only | `backend/tests/agent.messages.test.ts` | agent-authored rows untouched |
| Serializers expose `read_at` | `backend/tests/domain.serializers.test.ts` | present in both views, ISO string or null |
| Receipt reaches the opposite room only | `backend/tests/realtime.rooms.test.ts` | player room receives on agent read; agent room does not |
| No body in the receipt payload | same | payload keys are exactly the four contract fields |
| Tick rendering by state | new `frontend/src/features/chat/components/DeliveryTicks.test.tsx` | one tick for `sent`, two for `read`, none for `sending`/`failed`; correct a11y label |
| No tick on internal notes | new `ChatThread` test | internal own-message renders no receipt |

## Out of scope

- Making `delivered` a real state. It requires a client-side socket ack and
  earns a third visual state the user did not ask for. The enum value stays,
  unused, and renders as `sent`.
- Per-agent receipts, "seen by N agents", or a readers list.
- Read receipts on articles, forms, or bot cards.
- A privacy setting to disable receipts.
