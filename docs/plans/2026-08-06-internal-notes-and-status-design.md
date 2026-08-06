# Internal Notes & Awaiting-Player/Reopen Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task — **with one
> deviation from the default**: do **not** dispatch a review/validator subagent after each task.
> Each task's own implementer runs that task's own verification (`pnpm --filter @support/api
> typecheck` + that task's new/extended vitest file for backend tasks; `pnpm --filter @support/web
> typecheck && pnpm --filter @support/web build` for frontend tasks) as its own exit check, then
> stops — no second agent re-reviews it. Validation instead happens mechanically at the **Batch
> Checkpoint** after Batch 1, and once more at **Final Validation**. Tasks within Batch 1 touch
> disjoint files by design and may be dispatched to parallel subagents; Task 1 (Batch 0) must
> finish and be committed before any Batch 1 task starts.

**Goal:** Ship internal (agent-only) notes on the composer, the automatic `open → awaiting_player`
status transition on a public agent reply, and the player-facing resolved/closed reopen banner —
per `docs/specs/2026-08-06-internal-notes-and-status-design.md`.

**Architecture:** No schema changes. `message.visibility` and the existing `toPlayerView`/
`toAgentView` serializer split already do all the leak-prevention work; this slice is the first
caller to actually pass `'internal'` through `postMessage`. The status transition is inserted
inside `sendAgentMessage`'s existing transaction, mirroring the `inboxStatus`/`emitInboxChanged`
pattern `sendPlayerMessage` already uses for reopen. The reopen banner reuses
`sendPlayerMessage`'s existing `REOPENABLE_STATUSES` handling verbatim — no new endpoint.

**Tech Stack:** Express 5 + Drizzle + Zod (existing) · Socket.io (existing) · React 19 + TanStack
Query (existing). No new dependencies.

## Global Constraints

- **No schema changes.** `conversation.status` and `message.visibility` already carry everything
  this slice needs. Nothing in this plan touches `backend/src/shared/db/schema/**` or
  `backend/src/shared/db/sql/**`.
- **`postMessage(tx, {...})` remains the only place** that bumps `message_seq`, inserts a
  `message`, and appends the matching `event`. No task may reimplement any piece of that sequence.
- **Two serializers only**, unchanged in shape: `toPlayerView` returns `null` for any row whose
  `visibility !== 'public'`; `toAgentView` is permissive. Leak prevention is structural — no task
  may add a visibility filter to a query that fetches message rows.
- **The one documented transition this slice automates**: `open → awaiting_player`, triggered by a
  **public** agent reply, per `docs/project-overview.md`'s status machine ("`open` →
  `awaiting_player` — Agent asks something and marks waiting"). Any other current status is left
  untouched by a public reply — this is a no-op on status, not a rejection. Internal notes never
  reach this branch.
- **Out of scope — do not build:** a `resolution_cycle` table or resolution-cycle metrics; any
  manual "Mark Awaiting Player"/"Mark Resolved" agent control; `escalated`, the inactivity clock,
  or the bot's own resolve path; server-side enforcement of the transition table beyond the one
  transition above.
- **REST is the write path; sockets are push-only.** Every socket emit happens strictly after the
  triggering DB transaction has committed — never inside `withWorkspace`/`postMessage`.
- **Two Socket.io rooms per conversation** (`conv:{id}:player`, `conv:{id}:agents`), always emitted
  to separately with two different payloads.
- **Permission and visibility checks run at the API, not the UI.** The Composer toggle hides the
  internal option from the player surface's own usage, but the actual guarantee that an internal
  note never reaches a player is `toPlayerView` returning `null` plus `emitMessageToRooms` skipping
  the player-room emit — never anything client-side.
- **Per-task gate:** `pnpm --filter @support/api typecheck` (backend tasks) or
  `pnpm --filter @support/web typecheck && pnpm --filter @support/web build` (frontend tasks). A
  task's own new/extended vitest file is run as part of writing it (ordinary TDD), not as a
  separate validation step.
- **Batch Checkpoint** (after Batch 1): `pnpm typecheck` and `pnpm test` across the whole repo
  (Postgres must be up), plus `pnpm --filter @support/web build`. Mechanical command run, not an
  AI code review.
- **No frontend automated tests for this slice**, per the spec's own Testing section — the toggle,
  amber styling, and reopen banner are verified manually in a running dev server, called out
  explicitly in Final Validation below.

---

## Batching

```
Batch 0 (sequential, 1 task)  → Task 1
  ── commit ──
Batch 1 (parallel, 4 tasks)   → Tasks 2, 3, 4, 5      [depends only on Task 1]
  ── Batch Checkpoint ──
Final Validation
```

Tasks 2–5 touch disjoint files by construction — see each task's **Files** list. None of them
imports anything another Batch-1 task creates; all four import only from Task 1's output
(`packages/types/src/chat.ts`) plus the pre-existing codebase.

---

## Task 1: Wire contract — `visibility` on send, `status` on player messages response

**Batch:** 0 (sequential prerequisite for everything else)

**Files:**
- Modify: `packages/types/src/chat.ts`

**Interfaces:**
- Produces: `SendAgentMessageBody` gains `visibility: z.enum(['public', 'internal']).default('public')`.
  `PlayerMessagesResponse` gains an optional `status?: ConversationStatusValue` (optional, not
  required — see Step 3 rationale; a conversation-less player has no status to report, and the
  existing `{ conversation_id: null, messages: [] }` no-conversation response must not change
  shape).
- Consumes: nothing new — `ConversationStatusValue` already exists in this same file.

This task is type-only — there is no runtime behavior to red/green test here; downstream tasks'
typecheck and their own tests are what exercise it. Steps are implement → typecheck → commit.

- [ ] **Step 1: Add `visibility` to `SendAgentMessageBody`**

In `packages/types/src/chat.ts`, change:

```ts
export const SendAgentMessageBody = z.object({
  conversation_id: z.uuid(),
  body: z.string().min(1).max(4000),
})
```

to:

```ts
export const SendAgentMessageBody = z.object({
  conversation_id: z.uuid(),
  body: z.string().min(1).max(4000),
  visibility: z.enum(['public', 'internal']).default('public'),
})
```

- [ ] **Step 2: Add `status` to `PlayerMessagesResponse`**

Change:

```ts
export type PlayerMessagesResponse = { conversation_id: string | null; messages: PlayerMessageView[] }
```

to:

```ts
export type PlayerMessagesResponse = {
  conversation_id: string | null
  messages: PlayerMessageView[]
  status?: ConversationStatusValue
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @support/types typecheck` (or `pnpm typecheck` if that package has no
dedicated script — check `packages/types/package.json`).
Expected: passes with no errors. `SendAgentMessageBody`'s inferred type now includes
`visibility: 'public' | 'internal'` (never optional at the type level, thanks to `.default(...)`
making it optional only on the *input* side of `z.infer`'s companion `z.input`, but always present
on the parsed output `z.infer<typeof SendAgentMessageBody>` that `sendAgentMessage` consumes).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/chat.ts
git commit -m "feat(types): add visibility to SendAgentMessageBody, status to PlayerMessagesResponse"
```

---

## Task 2: Backend — internal notes send path + auto `open → awaiting_player` transition

**Batch:** 1 (parallel — depends only on Task 1)

**Files:**
- Modify: `backend/src/agent/services/messagesService.ts`
- Modify: `backend/src/domain/conversations/postMessage.ts`
- Test: `backend/tests/agent.messages.test.ts` (extend)
- Create: `backend/tests/realtime.internalNote.test.ts`

**Interfaces:**
- Consumes: `SendAgentMessageBody` (Task 1, now carries `visibility`), `postMessage(tx, input:
  PostMessageInput)` (existing, already accepts `visibility?: 'public' | 'internal'`),
  `appendEvent(tx, input: EventInput)` (existing), `emitInboxChanged(io, workspaceId,
  conversationId, status)` (existing), `withWorkspace`.
- Produces: `sendAgentMessage` now writes `message.visibility`, appends `visibility` to the
  `message_sent` event payload, and — for a public reply from `open` only — flips
  `conversation.status` to `awaiting_player`, appends `conversation_awaiting_player`, and emits
  `emitInboxChanged(..., 'awaiting_player')` after commit. No change to `SendAgentMessageResult`'s
  shape.

- [ ] **Step 1: Write the failing tests**

In `backend/tests/agent.messages.test.ts`, add a new `describe` block below the existing
`describe('POST /agent/messages/read', ...)`:

```ts
describe('POST /agent/messages — internal notes and status transition', () => {
  it('an internal note stores visibility internal and leaves status unchanged even from open', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'internal note', visibility: 'internal' })
      .expect(200)
    expect(res.body.message).toMatchObject({ visibility: 'internal' })

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('open')
  })

  it('a public reply from open flips status to awaiting_player and appends conversation_awaiting_player', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'here is the fix' })
      .expect(200)

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('awaiting_player')

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 and type = 'conversation_awaiting_player'`,
      [conversationId],
    )
    expect(events).toHaveLength(1)
  })

  it('a public reply from a status other than open leaves status unchanged', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [conversationId])
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'still here' })
      .expect(200)

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('awaiting_player')
  })

  it('message_sent event payload includes visibility', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'note', visibility: 'internal' })
      .expect(200)

    const { rows } = await ownerPool.query<{ payload: { visibility?: string } }>(
      `select payload from event where conversation_id = $1 and type = 'message_sent'`,
      [conversationId],
    )
    expect(rows[0]!.payload.visibility).toBe('internal')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @support/api test agent.messages.test.ts`
Expected: FAIL — `visibility` is silently dropped (never passed into `postMessage`), so the first
test's `res.body.message.visibility` is `'public'` not `'internal'`; the second and third tests
fail because no status-transition logic exists yet; the fourth fails because the `message_sent`
payload has no `visibility` key.

- [ ] **Step 3: Implement**

In `backend/src/domain/conversations/postMessage.ts`, change the `appendEvent` call's payload:

```ts
  await appendEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'message_sent',
    conversationId: input.conversationId,
    actorId: input.actorId,
    actorType: input.authorType,
    payload: { seq: bumped.seq, author_type: input.authorType, visibility: input.visibility ?? 'public' },
  })
```

In `backend/src/agent/services/messagesService.ts`, add the two missing imports:

```ts
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { emitInboxChanged, emitMessageToRooms } from '../../shared/realtime/emit.ts'
```

(replacing the existing single-symbol `import { emitMessageToRooms } from '../../shared/realtime/emit.ts'`)

Then replace the body of `sendAgentMessage`:

```ts
export async function sendAgentMessage(
  ctx: AgentContext,
  body: z.infer<typeof SendAgentMessageBody>,
): Promise<SendAgentMessageResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id, assignedAgentId: conversation.assignedAgentId, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.id, body.conversation_id))
      .limit(1)

    if (!found) return { outcome: 'not_found' } as const
    if (found.assignedAgentId !== ctx.agentId) return { outcome: 'forbidden' } as const

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: found.id,
      authorType: 'agent',
      actorId: ctx.agentId,
      authorAgentId: ctx.agentId,
      body: body.body,
      visibility: body.visibility,
    })

    let inboxStatus: 'awaiting_player' | null = null
    if (body.visibility !== 'internal' && found.status === 'open') {
      await tx.update(conversation).set({ status: 'awaiting_player' }).where(eq(conversation.id, found.id))
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_awaiting_player',
        conversationId: found.id,
        actorId: ctx.agentId,
        actorType: 'agent',
      })
      inboxStatus = 'awaiting_player'
    }

    return { outcome: 'ok', posted, inboxStatus } as const
  })

  if (result.outcome !== 'ok') return result

  const agentView = toAgentView(result.posted)
  const playerView = toPlayerView(result.posted)
  emitMessageToRooms(getIo(), body.conversation_id, playerView, agentView)
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, body.conversation_id, result.inboxStatus)
  }
  return { outcome: 'ok', message: agentView }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @support/api test agent.messages.test.ts`
Expected: PASS (all four new tests, plus the three pre-existing ones in this file).

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/messagesService.ts backend/src/domain/conversations/postMessage.ts backend/tests/agent.messages.test.ts
git commit -m "feat(agent): pass visibility into postMessage, auto-transition open to awaiting_player on public reply"
```

- [ ] **Step 6: Write the failing realtime leak test**

Create `backend/tests/realtime.internalNote.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { mintToken } from './helpers/app.ts'
import { closeOwnerPool, ownerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
import { connectClient, startRealtimeServer } from './helpers/realtime.ts'

let server: Awaited<ReturnType<typeof startRealtimeServer>>

beforeEach(async () => {
  await truncateAll()
  server = await startRealtimeServer()
})

afterEach(async () => {
  await server.close()
})

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()))
}

describe('internal notes never reach the player room', () => {
  it('posting an internal note through sendAgentMessage end-to-end never emits to conv:{id}:player', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent-note@example.test', 'Agent Note') returning id`,
    )
    const agentId = rows[0]!.id
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      agentId,
    ])
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [conversationId, agentId])
    const agentToken = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' })
    await waitFor(playerSocket, 'connect')
    await new Promise<boolean>((resolve) =>
      playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    )

    const playerReceived: unknown[] = []
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload))

    await request(server.url)
      .post('/agent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ conversation_id: conversationId, body: 'internal only', visibility: 'internal' })
      .expect(200)

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(playerReceived).toEqual([])
    playerSocket.close()
  })
})
```

- [ ] **Step 7: Run the new test file to verify it fails**

Run: `pnpm --filter @support/api test realtime.internalNote.test.ts`
Expected: FAIL — before Step 3's implementation this would actually already pass by accident
(internal notes were never wired to change anything), so **confirm this step runs *after* Step 3's
implementation is in place, against a deliberately broken `emitMessageToRooms` call** — the real
regression this test guards is a future edit that emits the internal note's payload into
`conv:{id}:player`. To genuinely see it fail once, temporarily change the `emitMessageToRooms` call
in `messagesService.ts` to pass `agentView` as both the player and agent payload, run the test
(expect FAIL, `playerReceived` non-empty), then revert that temporary change before Step 8.

- [ ] **Step 8: Run the test against the real (correct) implementation**

Run: `pnpm --filter @support/api test realtime.internalNote.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/tests/realtime.internalNote.test.ts
git commit -m "test(realtime): assert internal notes never emit to the player room end-to-end"
```

---

## Task 3: Backend — `status` on `GET /surface/messages`

**Batch:** 1 (parallel — depends only on Task 1)

**Files:**
- Modify: `backend/src/surface/services/messagesService.ts`
- Test: `backend/tests/surface.messages.test.ts` (extend)

**Interfaces:**
- Consumes: `PlayerMessagesResponse` (Task 1, now carries optional `status`), `conversation.status`
  column (existing, Drizzle schema, `ConversationStatusValue` union).
- Produces: `getPlayerMessages` return type widens to `{ conversation_id: string | null; messages:
  PlayerMessageView[]; status?: ConversationStatusValue } | null`. The no-conversation branch keeps
  returning exactly `{ conversation_id: null, messages: [] }` (no `status` key at all) — this is a
  deliberate choice: the type is optional specifically so the pre-existing "no conversation yet"
  test (`toEqual({ conversation_id: null, messages: [] })`) keeps passing unchanged, since a
  conversation-less player genuinely has no status to report.

- [ ] **Step 1: Write the failing test**

In `backend/tests/surface.messages.test.ts`, add inside the existing `describe('GET
/surface/messages', ...)` block:

```ts
  it('includes status and no internal-only fields', async () => {
    const { workspaceId, playerId, token, sessionId } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'open' where id = $1`, [conversationId])
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    )

    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.status).toBe('open')
    expect(res.body.messages[0]).not.toHaveProperty('visibility')
    expect(res.body.messages[0]).not.toHaveProperty('author_agent_id')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test surface.messages.test.ts`
Expected: FAIL — `res.body.status` is `undefined`, not `'open'` (`getPlayerMessages` doesn't select
or return `status` yet).

- [ ] **Step 3: Implement**

In `backend/src/surface/services/messagesService.ts`, add `ConversationStatusValue` to the type
import:

```ts
import { MarkPlayerReadBody, SendMessageBody, type ConversationStatusValue, type PlayerMessageView } from '@support/types'
```

Change `getPlayerMessages`'s signature and body:

```ts
export async function getPlayerMessages(
  ctx: PlayerContext,
  query: { session_id: string },
): Promise<{ conversation_id: string | null; messages: PlayerMessageView[]; status?: ConversationStatusValue } | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [ownedSession] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)
    if (!ownedSession) return null

    const [found] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!found) return { conversation_id: null, messages: [] }

    const rows = await tx.select().from(message).where(eq(message.conversationId, found.id)).orderBy(message.seq)
    const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
    return { conversation_id: found.id, messages, status: found.status }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test surface.messages.test.ts`
Expected: PASS (new test, plus every pre-existing test in this file still passes — in particular
the "returns conversation_id: null and an empty list" test, unaffected since that branch's return
shape didn't change).

- [ ] **Step 5: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "feat(surface): include conversation status in GET /surface/messages"
```

---

## Task 4: Frontend — internal note toggle, amber rendering, agent console wiring

**Batch:** 1 (parallel — depends only on Task 1)

**Files:**
- Modify: `frontend/src/components/chat/types.ts`
- Modify: `frontend/src/components/chat/ChatThread.tsx`
- Modify: `frontend/src/components/chat/Composer.tsx`
- Modify: `frontend/src/pages/AgentConversation.tsx`
- Modify: `frontend/src/api/agentApi.ts`
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: `AgentMessageView` (existing, already carries `visibility`).
- Produces: `ChatMessage` gains optional `visibility?: 'public' | 'internal'`. `Composer` gains
  `onSend: (body: string, visibility?: 'public' | 'internal') => void` (widened from `(body:
  string) => void`) and a new optional `allowVisibilityToggle?: boolean` prop — when omitted or
  `false`, no toggle renders and `onSend` is called with `visibility` always `undefined`,
  preserving the player surface's existing call site untouched. `sendAgentMessage` (agentApi.ts)
  gains an optional fourth `visibility?: 'public' | 'internal'` parameter.

No frontend automated tests exist for this component tree (per spec's Testing section) — this
task's verification is `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`,
plus manual verification called out in Final Validation.

- [ ] **Step 1: Add `visibility` to `ChatMessage`**

In `frontend/src/components/chat/types.ts`, change:

```ts
export type ChatMessage = {
  id: string
  authorType: ChatAuthorType
  body: string
  createdAt: string
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
}
```

to:

```ts
export type ChatMessage = {
  id: string
  authorType: ChatAuthorType
  body: string
  createdAt: string
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  visibility?: 'public' | 'internal'
}
```

- [ ] **Step 2: Render internal notes with the amber class in `ChatThread`**

In `frontend/src/components/chat/ChatThread.tsx`, change the `className` line inside
`itemContent`:

```tsx
        <div
          className={`chat-message chat-message--${chatMessage.authorType}`}
          data-own={chatMessage.authorType === currentAuthorType}
        >
```

to:

```tsx
        <div
          className={[
            'chat-message',
            `chat-message--${chatMessage.authorType}`,
            chatMessage.visibility === 'internal' ? 'chat-message--internal' : null,
          ]
            .filter(Boolean)
            .join(' ')}
          data-own={chatMessage.authorType === currentAuthorType}
        >
```

- [ ] **Step 3: Add the amber CSS rule**

In `frontend/src/styles.css`, add this rule immediately after the existing
`.chat-message[data-own='false'] { ... }` block (so source order wins the specificity tie against
the `[data-own]` background rules — both selectors below are two-class/attribute-plus-class
combinators of equal specificity to `.chat-message[data-own='...']`):

```css
.chat-message.chat-message--internal {
  background: light-dark(#fef3c7, #78350f);
  color: light-dark(#78350f, #fef3c7);
  border: 1px solid light-dark(#f59e0b, #b45309);
}
```

- [ ] **Step 4: Add the Public/Internal toggle to `Composer`**

Replace the full contents of `frontend/src/components/chat/Composer.tsx`:

```tsx
import { useState } from 'react'

type ComposerProps = {
  onSend: (body: string, visibility?: 'public' | 'internal') => void
  disabled?: boolean
  /** Only the agent console passes this. The player surface's Composer usage omits it, so
   *  onSend is always called with visibility undefined there — there is no code path for a
   *  player to send an internal note. */
  allowVisibilityToggle?: boolean
}

export function Composer({ onSend, disabled, allowVisibilityToggle }: ComposerProps) {
  const [value, setValue] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    onSend(trimmed, allowVisibilityToggle ? visibility : undefined)
    setValue('')
    setVisibility('public')
  }

  return (
    <div className="composer">
      {allowVisibilityToggle && (
        <div className="composer__visibility" role="radiogroup" aria-label="Message visibility">
          <button type="button" aria-pressed={visibility === 'public'} onClick={() => setVisibility('public')}>
            Public
          </button>
          <button type="button" aria-pressed={visibility === 'internal'} onClick={() => setVisibility('internal')}>
            Internal
          </button>
        </div>
      )}
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder="Type a message…"
      />
      <button type="button" onClick={submit} disabled={disabled === true || value.trim().length === 0}>
        Send
      </button>
    </div>
  )
}
```

- [ ] **Step 5: Wire the agent console through**

In `frontend/src/api/agentApi.ts`, change `sendAgentMessage`:

```ts
export function sendAgentMessage(token: string, conversationId: string, body: string): Promise<{ message: unknown }> {
  return apiCall(`/agent/messages`, token, { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, body }) })
}
```

to:

```ts
export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
): Promise<{ message: unknown }> {
  return apiCall(`/agent/messages`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, body, visibility }),
  })
}
```

In `frontend/src/pages/AgentConversation.tsx`, change the mapping function:

```tsx
function toChatMessage(m: AgentMessageView): ChatMessage {
  return { id: m.id, authorType: m.author_type, body: m.body, createdAt: m.created_at, deliveryState: m.delivery_state }
}
```

to:

```tsx
function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    visibility: m.visibility,
  }
}
```

and change the `send` mutation plus the `Composer` usage:

```tsx
  const send = useMutation({
    mutationFn: (body: string) => sendAgentMessage(session!.token, id!, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    },
  })
```

to:

```tsx
  const send = useMutation({
    mutationFn: ({ body, visibility }: { body: string; visibility?: 'public' | 'internal' }) =>
      sendAgentMessage(session!.token, id!, body, visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    },
  })
```

and:

```tsx
      <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
```

to:

```tsx
      <Composer
        onSend={(body, visibility) => send.mutate({ body, visibility })}
        disabled={send.isPending}
        allowVisibilityToggle
      />
```

- [ ] **Step 6: Typecheck and build**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`
Expected: both pass with no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/chat/types.ts frontend/src/components/chat/ChatThread.tsx frontend/src/components/chat/Composer.tsx frontend/src/pages/AgentConversation.tsx frontend/src/api/agentApi.ts frontend/src/styles.css
git commit -m "feat(agent-console): Public/Internal composer toggle with amber internal-note rendering"
```

---

## Task 5: Frontend — player resolved/closed reopen banner

**Batch:** 1 (parallel — depends only on Task 1)

**Files:**
- Modify: `frontend/src/pages/SupportSurface.tsx`

**Interfaces:**
- Consumes: `PlayerMessagesResponse` (Task 1, `messagesQuery.data?.status`), the existing `send`
  mutation (`send.mutate(body: string)`, unchanged signature — this task calls it with a fixed
  string body, no new argument), the existing `Composer` (unchanged call site, no
  `allowVisibilityToggle`).
- Produces: no new exports — this is a leaf page component change.

No frontend automated tests for this component (per spec) — verification is
`pnpm --filter @support/web typecheck && pnpm --filter @support/web build`, plus manual
verification in Final Validation. No new CSS: the banner reuses the existing `.notice` class
already used elsewhere in this same file for the player-state availability copy.

- [ ] **Step 1: Add the banner**

In `frontend/src/pages/SupportSurface.tsx`, change:

```tsx
      {chatOpen && (
        <section className="chat-panel">
          <div className="chat-panel__thread">
            <ChatThread messages={chatMessages} currentAuthorType="player" onRetry={onRetry} />
          </div>
          <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
        </section>
      )}
```

to:

```tsx
      {chatOpen && (
        <section className="chat-panel">
          <div className="chat-panel__thread">
            <ChatThread messages={chatMessages} currentAuthorType="player" onRetry={onRetry} />
          </div>
          {(messagesQuery.data?.status === 'resolved' || messagesQuery.data?.status === 'closed') && (
            <div className="notice">
              <p>Your ticket is resolved.</p>
              <p>
                Still facing issues?{' '}
                <button type="button" onClick={() => send.mutate("I'm still facing issues.")}>
                  Yes
                </button>
              </p>
            </div>
          )}
          <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
        </section>
      )}
```

The banner disappears on its own once the refetch this component already wires (the `message:new`
socket handler's `queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })`,
and `onSuccess` on `send` itself) lands with the reopened `status: 'open'` — no new effect or state
needed.

- [ ] **Step 2: Typecheck and build**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`
Expected: both pass with no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/SupportSurface.tsx
git commit -m "feat(surface): resolved/closed reopen banner reusing existing reopen behaviour"
```

---

## Batch Checkpoint (after Task 2, 3, 4, 5 all complete)

Run, in order, from the repo root:

1. `pnpm typecheck` — expected: no errors across the workspace.
2. `pnpm test` — expected: full suite green (Postgres must be running; `pnpm db:setup` first if
   the local DB has never been migrated). In particular: `agent.messages.test.ts`,
   `realtime.internalNote.test.ts`, `surface.messages.test.ts`, and the pre-existing
   `domain.serializers.test.ts` and `realtime.rooms.test.ts` all pass unchanged.
3. `pnpm --filter @support/web build` — expected: clean build.

If any of these fail, fix forward on the branch before proceeding — do not skip to Final
Validation with a red checkpoint.

---

## Final Validation

1. Re-run `pnpm typecheck`, `pnpm test`, and `pnpm --filter @support/web build` one more time on
   the final state of the branch (catches anything a late fix-forward broke).
2. Manual verification in a running dev server (`pnpm dev`), per the spec's own Testing section —
   there are no automated frontend tests for these three:
   - Agent console: open a conversation, confirm the Public/Internal toggle appears on the
     composer, defaults to Public, and resets to Public after every send.
   - Send an internal note; confirm it renders amber (`chat-message--internal`) in the agent
     console thread, and confirm — by opening the same conversation on the player-facing surface in
     a second tab/session — that it never appears there.
   - Send a public reply while the conversation is `open`; confirm the conversation's status flips
     to `awaiting_player` (visible wherever the agent console surfaces conversation status, e.g. the
     inbox) without clicking any status button.
   - On the player surface, get a conversation into `resolved` or `closed` (via whatever agent
     action already sets that — out of scope for this slice to add a button for), reload the
     surface, and confirm the "Your ticket is resolved." / "Still facing issues?" banner appears
     with a working "Yes" button, and that clicking it reopens the conversation and the banner
     disappears once the status refetches to `open`.
3. Read `docs/specs/2026-08-06-internal-notes-and-status-design.md` top to bottom one more time
   against the finished branch and confirm every **In** bullet has a corresponding committed
   change, every **Out** bullet was genuinely left untouched (no `resolution_cycle` table, no
   manual status button, no `escalated`/inactivity code, no broader transition-table enforcement),
   and every bullet in **Testing** has a matching test or the manual check in Step 2 above.
