# Read Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a single grey tick when a message reached the server and a double blue tick when the other side actually read it, and record the read time in the database.

**Architecture:** The delivery-state machine and both mark-read endpoints already exist. This adds a `message.read_at` timestamp written by the existing mark-read `UPDATE`s, a `message:read` Socket.io event pushed to the *opposite* audience's room so the sender's ticks flip live, and one shared presentational `DeliveryTicks` component rendered by both thread renderers.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, PostgreSQL 17, Socket.io, Vitest + supertest (backend), React + TanStack Query + Tailwind + Vitest/jsdom + @testing-library/react (frontend).

**Spec:** `docs/specs/2026-08-11-read-receipts-design.md` — read it before starting.

## Global Constraints

- **Never `console.*`.** Use `logger` from `backend/src/shared/logging/logger.ts`. This feature adds no logging, so the rule only matters if you debug.
- **The SDK wire contract is frozen: add response fields freely, never remove or retype one.** `read_at` is additive and therefore allowed.
- **Internal notes must never reach a player.** Do not add a `visibility` filter to any query. The two serializers (`toPlayerView`, `toAgentView`) are the only place visibility is decided.
- **No hard deletes.** Nothing in this plan deletes a row.
- **`read_at` is never rewritten.** First read wins, enforced by the existing `ne(message.deliveryState, 'read')` predicate — do not remove it.
- **Socket payloads carry no message bodies.** The read receipt is `{ conversation_id, up_to_seq, reader_type, read_at }` and nothing more.
- **Schema changes reach Postgres via `pnpm db:setup`** (`drizzle-kit push`), not a hand-written migration file.
- Emit to sockets **after** the transaction commits, never inside `withWorkspace`.
- Backend tests need Postgres running: `docker compose up -d` first.
- Run a single backend test file with `pnpm --filter @support/api exec vitest run <path>`; a single frontend file with `pnpm --filter @support/web exec vitest run <path>`.

---

### Task 1: `read_at` column and serializer field

Adds the column, threads it through the row type and both serializers. No behaviour change yet — nothing writes a non-null value until Task 2.

**Files:**
- Modify: `packages/types/src/chat.ts:34-41` (`PlayerMessageView`)
- Modify: `backend/src/shared/db/schema/conversations.ts:45-70` (`message` table)
- Modify: `backend/src/domain/conversations/postMessage.ts:18-28` (`PostedMessageRow`)
- Modify: `backend/src/domain/conversations/serializers.ts:11-35`
- Test: `backend/tests/domain.serializers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PlayerMessageView.read_at: string | null`; `AgentMessageView.read_at: string | null` (inherited, it extends `PlayerMessageView`); `PostedMessageRow.readAt: Date | null`; `message.readAt` Drizzle column mapping `read_at timestamptz null`.

- [ ] **Step 1: Update the failing tests**

The two existing `toEqual` assertions are exhaustive object comparisons, so adding a field to the serializer breaks them. Update them first — that is the failing test.

In `backend/tests/domain.serializers.test.ts`, add `readAt: null` to the `row()` fixture defaults (after `createdAt`):

```ts
function row(overrides: Partial<PostedMessageRow> = {}): PostedMessageRow {
  return {
    id: 'm1',
    conversationId: 'c1',
    seq: 1,
    authorType: 'agent',
    authorAgentId: 'ag1',
    body: 'hello',
    visibility: 'public',
    deliveryState: 'sent',
    createdAt: new Date('2026-08-06T00:00:00Z'),
    readAt: null,
    ...overrides,
  }
}
```

Add `read_at: null` to the expected object in the `toPlayerView` "returns the whitelisted fields" test, and to the expected object in the `toAgentView` "never returns null" test. Then add two new tests at the end of the file:

```ts
describe('read_at serialization', () => {
  it('serializes a read timestamp as an ISO string in both views', () => {
    const read = row({ deliveryState: 'read', readAt: new Date('2026-08-11T10:43:07Z') })
    expect(toPlayerView(read)?.read_at).toBe('2026-08-11T10:43:07.000Z')
    expect(toAgentView(read).read_at).toBe('2026-08-11T10:43:07.000Z')
  })

  it('serializes an unread message as null, not undefined or an empty string', () => {
    expect(toPlayerView(row())?.read_at).toBeNull()
    expect(toAgentView(row()).read_at).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @support/api exec vitest run tests/domain.serializers.test.ts`

Expected: FAIL. The fixture change is a type error on `PostedMessageRow` (`readAt` does not exist), and the new tests fail because `read_at` is `undefined`.

- [ ] **Step 3: Add `read_at` to the wire type**

In `packages/types/src/chat.ts`, add to `PlayerMessageView`:

```ts
export type PlayerMessageView = {
  id: string
  seq: number
  author_type: ChatAuthorType
  body: string
  delivery_state: ChatDeliveryState
  /** ISO 8601, or null until the other side reads it. Additive — the frozen contract permits new response fields. */
  read_at: string | null
  created_at: string
}
```

`AgentMessageView` extends `PlayerMessageView`, so it picks this up with no edit.

- [ ] **Step 4: Add the column**

In `backend/src/shared/db/schema/conversations.ts`, inside the `message` table definition, after `deliveryState`:

```ts
    deliveryState: messageDeliveryState('delivery_state').notNull().default('sent'),
    /** Set once, by the first mark-read that matches this row. Never rewritten — see docs/specs/2026-08-11-read-receipts-design.md. */
    readAt: timestamp('read_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
```

`tz` and `timestamp` are already in scope at the top of the file. No index: every query that touches `read_at` already narrows by `conversation_id` first.

- [ ] **Step 5: Add `readAt` to the row type**

In `backend/src/domain/conversations/postMessage.ts`, add to `PostedMessageRow` after `deliveryState`:

```ts
  deliveryState: ChatDeliveryState
  readAt: Date | null
  createdAt: Date
```

`postMessage` ends with `return inserted`, the full Drizzle row from `.returning()`, so the new column flows through with no other change to that file.

- [ ] **Step 6: Serialize it**

In `backend/src/domain/conversations/serializers.ts`, add the same line to both functions, after `delivery_state`:

```ts
    delivery_state: row.deliveryState,
    read_at: row.readAt ? row.readAt.toISOString() : null,
```

Use the explicit ternary, not `row.readAt?.toISOString() ?? null` — the optional-chain form returns `undefined` for a null Date under some TS configs and `read_at` must be present-and-null, not absent, for the frozen contract.

- [ ] **Step 7: Push the schema and run the tests**

```bash
docker compose up -d
pnpm db:setup
pnpm --filter @support/api exec vitest run tests/domain.serializers.test.ts
pnpm typecheck
```

Expected: `db:setup` reports `database ready`; the serializer suite PASSES; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/chat.ts backend/src/shared/db/schema/conversations.ts \
  backend/src/domain/conversations/postMessage.ts backend/src/domain/conversations/serializers.ts \
  backend/tests/domain.serializers.test.ts
git commit -m "feat: add message.read_at and expose it in both serializers"
```

---

### Task 2: Mark-read writes the timestamp

Both mark-read services stamp `read_at` and start returning enough information for their caller to emit a receipt in Task 3.

**Files:**
- Modify: `backend/src/surface/services/messagesService.ts:115-133`
- Modify: `backend/src/agent/services/messagesService.ts:68-89`
- Test: `backend/tests/surface.messages.test.ts`, `backend/tests/agent.messages.test.ts`

**Interfaces:**
- Consumes: `message.readAt` from Task 1.
- Produces:
  ```ts
  // exported from BOTH service modules
  export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null
  export async function markPlayerMessagesRead(ctx: PlayerContext, body: MarkPlayerReadBodyType): Promise<MarkReadResult>
  export async function markAgentMessagesRead(ctx: AgentContext, body: z.infer<typeof MarkAgentReadBody>): Promise<MarkReadResult>
  ```
  `null` means "nothing to announce" — either no conversation, or no row transitioned. Both controllers already `await` and discard the return value (`surface/controllers/messagesController.ts:39`, `agent/controllers/messagesController.ts:32`), so widening it from `boolean` breaks no caller and the HTTP response stays `{ ok: true }`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/surface.messages.test.ts`. `setup()` and `ownerPool` already exist in that file; `seedConversation` is already imported.

```ts
describe('POST /surface/messages/read records when the player saw it', () => {
  it('stamps read_at on agent messages and leaves the player\'s own untouched', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r1@example.test', 'R1') returning id`,
    )
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'from the agent'), ($1, $2, 2, 'player', null, 'from the player')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    )

    await request(app)
      .post('/surface/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ up_to_seq: 2 })
      .expect(200)

    const { rows } = await ownerPool.query<{ seq: number; delivery_state: string; read_at: Date | null }>(
      `select seq, delivery_state, read_at from message where conversation_id = $1 order by seq`,
      [conversationId],
    )
    expect(rows[0]).toMatchObject({ seq: 1, delivery_state: 'read' })
    expect(rows[0]!.read_at).toBeInstanceOf(Date)
    // The player reading their own message is not a receipt.
    expect(rows[1]).toMatchObject({ seq: 2, delivery_state: 'sent' })
    expect(rows[1]!.read_at).toBeNull()
  })

  it('never moves read_at forward on a second read of the same message', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('r2@example.test', 'R2') returning id`,
    )
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'agent', $3, 'first')`,
      [workspaceId, conversationId, agentRow.rows[0]!.id],
    )

    const read = () =>
      request(app).post('/surface/messages/read').set('Authorization', `Bearer ${token}`).send({ up_to_seq: 1 }).expect(200)
    const readAtNow = async () => {
      const { rows } = await ownerPool.query<{ read_at: Date }>(
        `select read_at from message where conversation_id = $1 and seq = 1`,
        [conversationId],
      )
      return rows[0]!.read_at.toISOString()
    }

    await read()
    const first = await readAtNow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await read()
    expect(await readAtNow()).toBe(first)
  })
})
```

Append the mirror-image test to `backend/tests/agent.messages.test.ts`. Note that this file mounts `messagesRouter` on a bare express app, so **the path is `/messages/read`, not `/agent/messages/read`**. It already has `setupAssignedAgent`, `ownerPool`, and a `createSocketServer` call in `beforeAll`, so nothing new needs importing.

```ts
describe('POST /messages/read records when the agent saw it', () => {
  it('stamps read_at on player messages and leaves agent messages untouched', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId)
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'player', null, 'my coins vanished'), ($1, $2, 2, 'agent', $3, 'looking into it')`,
      [workspaceId, conversationId, agentId],
    )

    await request(app)
      .post('/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, up_to_seq: 2 })
      .expect(200)

    const { rows } = await ownerPool.query<{ seq: number; delivery_state: string; read_at: Date | null }>(
      `select seq, delivery_state, read_at from message where conversation_id = $1 order by seq`,
      [conversationId],
    )
    expect(rows[0]).toMatchObject({ seq: 1, delivery_state: 'read' })
    expect(rows[0]!.read_at).toBeInstanceOf(Date)
    // An agent reading their own reply is not a receipt.
    expect(rows[1]).toMatchObject({ seq: 2, delivery_state: 'sent' })
    expect(rows[1]!.read_at).toBeNull()
  })

  it('never moves read_at forward on a second read of the same message', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { token } = await setupAssignedAgent(workspaceId, conversationId)
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, author_agent_id, body)
       values ($1, $2, 1, 'player', null, 'my coins vanished')`,
      [workspaceId, conversationId],
    )

    const read = () =>
      request(app)
        .post('/messages/read')
        .set('Authorization', `Bearer ${token}`)
        .send({ conversation_id: conversationId, up_to_seq: 1 })
        .expect(200)
    const readAtNow = async () => {
      const { rows } = await ownerPool.query<{ read_at: Date }>(
        `select read_at from message where conversation_id = $1 and seq = 1`,
        [conversationId],
      )
      return rows[0]!.read_at.toISOString()
    }

    await read()
    const first = await readAtNow()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await read()
    expect(await readAtNow()).toBe(first)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @support/api exec vitest run tests/surface.messages.test.ts tests/agent.messages.test.ts
```

Expected: FAIL — `read_at` is null where a Date is expected, because nothing writes it yet.

- [ ] **Step 3: Implement the player side**

Replace `markPlayerMessagesRead` in `backend/src/surface/services/messagesService.ts`:

```ts
/**
 * `null` means there is nothing to announce — no conversation, or every message
 * in range was already read. The caller uses that to skip the socket emit.
 */
export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null

export async function markPlayerMessagesRead(
  ctx: PlayerContext,
  body: MarkPlayerReadBodyType,
): Promise<MarkReadResult> {
  // One timestamp for the whole batch: every message in this range was seen in
  // the same glance, and a per-row now() would imply an ordering that did not happen.
  const readAt = new Date()

  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.playerId, ctx.playerId)).limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          ne(message.authorType, 'player'),
          // Load-bearing: this is what makes read_at first-write-wins. Removing
          // it would let every thread open overwrite the original read time.
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })
}
```

- [ ] **Step 4: Implement the agent side**

Replace `markAgentMessagesRead` in `backend/src/agent/services/messagesService.ts`. Same shape, mirrored predicate (`eq(message.authorType, 'player')` — an agent reading agent messages is not a receipt):

```ts
export type MarkReadResult = { conversationId: string; upToSeq: number; readAt: Date } | null

export async function markAgentMessagesRead(
  ctx: AgentContext,
  body: z.infer<typeof MarkAgentReadBody>,
): Promise<MarkReadResult> {
  const readAt = new Date()

  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, body.conversation_id)).limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          eq(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @support/api exec vitest run tests/surface.messages.test.ts tests/agent.messages.test.ts
pnpm typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/src/agent/services/messagesService.ts \
  backend/tests/surface.messages.test.ts backend/tests/agent.messages.test.ts
git commit -m "feat: stamp read_at when messages are marked read"
```

---

### Task 3: `message:read` socket event

Pushes the receipt to the *opposite* audience's room so the sender's ticks flip without a manual refresh.

**Files:**
- Modify: `packages/types/src/chat.ts` (add `MessageReadEvent`)
- Modify: `backend/src/shared/realtime/emit.ts`
- Modify: `backend/src/surface/services/messagesService.ts`, `backend/src/agent/services/messagesService.ts`
- Test: `backend/tests/realtime.rooms.test.ts`

**Interfaces:**
- Consumes: `MarkReadResult` from Task 2.
- Produces:
  ```ts
  // packages/types/src/chat.ts
  export type MessageReadEvent = {
    conversation_id: string
    up_to_seq: number
    reader_type: 'player' | 'agent'
    read_at: string
  }

  // backend/src/shared/realtime/emit.ts
  export function emitReadReceipt(io: Server, audience: 'player' | 'agents', payload: MessageReadEvent): void
  ```
  Socket event name: `message:read`.

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/realtime.rooms.test.ts`, inside the existing `describe`. It already imports `agentRoom`, `playerRoom`, `getIo`, and the seed/connect helpers.

```ts
  it('routes a read receipt to the opposite audience only, and carries no message body', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const playerToken = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
    const agentToken = await signAgentSession({ agent_id: 'agent-1', workspace_id: workspaceId })
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' })
    const agentSocket = connectClient(server.url, { token: agentToken, role: 'agent' })
    await Promise.all([waitFor(playerSocket, 'connect'), waitFor(agentSocket, 'connect')])

    const join = (socket: ReturnType<typeof connectClient>) =>
      new Promise<boolean>((resolve) => socket.emit('join_conversation', { conversation_id: conversationId }, resolve))
    expect(await join(playerSocket)).toBe(true)
    expect(await join(agentSocket)).toBe(true)

    const playerReceived: unknown[] = []
    const agentReceived: unknown[] = []
    playerSocket.on('message:read', (payload: unknown) => playerReceived.push(payload))
    agentSocket.on('message:read', (payload: unknown) => agentReceived.push(payload))

    // An agent read is news for the player, who wrote the messages being read.
    emitReadReceipt(getIo(), 'player', {
      conversation_id: conversationId,
      up_to_seq: 4,
      reader_type: 'agent',
      read_at: '2026-08-11T10:43:07.000Z',
    })

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(playerReceived).toEqual([
      { conversation_id: conversationId, up_to_seq: 4, reader_type: 'agent', read_at: '2026-08-11T10:43:07.000Z' },
    ])
    // Never an echo back to the audience that did the reading.
    expect(agentReceived).toEqual([])
    // The payload is exactly the contract — a body leaking here would cross the
    // internal-note boundary the two serializers exist to protect.
    expect(Object.keys(playerReceived[0] as object).sort()).toEqual([
      'conversation_id',
      'read_at',
      'reader_type',
      'up_to_seq',
    ])

    playerSocket.close()
    agentSocket.close()
  })
```

Add `emitReadReceipt` to the imports at the top of that file:

```ts
import { emitReadReceipt } from '../src/shared/realtime/emit.ts'
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api exec vitest run tests/realtime.rooms.test.ts`

Expected: FAIL — `emitReadReceipt` is not exported from `emit.ts`.

- [ ] **Step 3: Add the event type**

Append to `packages/types/src/chat.ts`, next to `ConversationChangedEvent`:

```ts
/**
 * The read-receipt payload. A high-water sequence number and a timestamp — no
 * bodies, no ids of individual messages. `reader_type` is who *did* the reading,
 * so a client can ignore an echo of its own action.
 */
export type MessageReadEvent = {
  conversation_id: string
  up_to_seq: number
  reader_type: 'player' | 'agent'
  read_at: string
}
```

- [ ] **Step 4: Add the emitter**

Append to `backend/src/shared/realtime/emit.ts`:

```ts
/**
 * Routed by audience rather than by conversation alone: a receipt goes to whoever
 * *wrote* the messages, never back to whoever read them. Unlike
 * emitMessageToRooms this payload is typed — it is a fixed four-field contract,
 * not a serializer's output passed through.
 */
export function emitReadReceipt(io: Server, audience: 'player' | 'agents', payload: MessageReadEvent): void {
  const room = audience === 'player' ? playerRoom(payload.conversation_id) : agentRoom(payload.conversation_id)
  io.to(room).emit('message:read', payload)
}
```

Add the import at the top of the file:

```ts
import type { MessageReadEvent } from '@support/types'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/api exec vitest run tests/realtime.rooms.test.ts`
Expected: PASS.

- [ ] **Step 6: Emit from both services**

In `backend/src/surface/services/messagesService.ts`, the player just read agent messages, so the receipt goes to the agents' room. Restructure the function so the emit happens after `withWorkspace` returns — `emitReadReceipt` must never run inside the transaction, or a rollback would push a lie:

```ts
export async function markPlayerMessagesRead(
  ctx: PlayerContext,
  body: MarkPlayerReadBodyType,
): Promise<MarkReadResult> {
  const readAt = new Date()

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.playerId, ctx.playerId)).limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })

  if (result) {
    emitReadReceipt(getIo(), 'agents', {
      conversation_id: result.conversationId,
      up_to_seq: result.upToSeq,
      reader_type: 'player',
      read_at: result.readAt.toISOString(),
    })
  }

  return result
}
```

Add `emitReadReceipt` to the existing `emit.ts` import at the top of the file; `getIo` is already imported.

The agent side, in `backend/src/agent/services/messagesService.ts` — audience `'player'`, `reader_type: 'agent'`, and the mirrored author predicate:

```ts
export async function markAgentMessagesRead(
  ctx: AgentContext,
  body: z.infer<typeof MarkAgentReadBody>,
): Promise<MarkReadResult> {
  const readAt = new Date()

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, body.conversation_id)).limit(1)
    if (!found) return null

    const updated = await tx
      .update(message)
      .set({ deliveryState: 'read', readAt })
      .where(
        and(
          eq(message.conversationId, found.id),
          eq(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
      .returning({ seq: message.seq })

    if (updated.length === 0) return null
    return { conversationId: found.id, upToSeq: Math.max(...updated.map((r) => r.seq)), readAt }
  })

  if (result) {
    emitReadReceipt(getIo(), 'player', {
      conversation_id: result.conversationId,
      up_to_seq: result.upToSeq,
      reader_type: 'agent',
      read_at: result.readAt.toISOString(),
    })
  }

  return result
}
```

`getIo` and the `emit.ts` import already exist in that file too.

- [ ] **Step 7: Run the full backend suite**

```bash
pnpm --filter @support/api test
pnpm typecheck
```

Expected: all PASS. The mark-read tests from Task 2 now exercise the emit path, which needs a live `getIo()`. Both files already call `createSocketServer(createServer())` in `beforeAll` (`surface.messages.test.ts:22`, `agent.messages.test.ts:23`), so no test setup changes — the comments there explain why each file needs its own instance.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/chat.ts backend/src/shared/realtime/emit.ts \
  backend/src/surface/services/messagesService.ts backend/src/agent/services/messagesService.ts \
  backend/tests/realtime.rooms.test.ts
git commit -m "feat: push message:read receipts to the opposite audience room"
```

---

### Task 4: `DeliveryTicks` component

The one piece of UI, shared by both surfaces. Pure presentation — no data fetching, no socket, no state.

**Files:**
- Create: `frontend/src/features/chat/components/DeliveryTicks.tsx`
- Create: `frontend/src/features/chat/components/DeliveryTicks.test.tsx`

**Interfaces:**
- Consumes: `ChatDeliveryState` from `@support/types`.
- Produces:
  ```tsx
  export function DeliveryTicks(props: { deliveryState?: ChatDeliveryState; readClassName?: string }): JSX.Element | null
  ```
  Renders `null` for `undefined`, `'sending'`, `'failed'`. One tick for `'sent'` and `'delivered'`, two for `'read'`. `readClassName` defaults to `'text-sky-500'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/chat/components/DeliveryTicks.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DeliveryTicks } from './DeliveryTicks.tsx'

describe('DeliveryTicks', () => {
  it('renders one tick labelled Sent for a delivered-to-server message', () => {
    render(<DeliveryTicks deliveryState="sent" />)
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(1)
  })

  it('renders two ticks labelled Seen once the other side has read it', () => {
    render(<DeliveryTicks deliveryState="read" />)
    expect(screen.getByText('Seen')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(2)
  })

  it('treats the unused delivered state as sent rather than inventing a third look', () => {
    render(<DeliveryTicks deliveryState="delivered" />)
    expect(screen.getByText('Sent')).toBeInTheDocument()
    expect(document.querySelectorAll('svg')).toHaveLength(1)
  })

  it('renders nothing while sending, when failed, or when the state is unknown', () => {
    const { container: sending } = render(<DeliveryTicks deliveryState="sending" />)
    expect(sending).toBeEmptyDOMElement()
    const { container: failed } = render(<DeliveryTicks deliveryState="failed" />)
    expect(failed).toBeEmptyDOMElement()
    const { container: absent } = render(<DeliveryTicks />)
    expect(absent).toBeEmptyDOMElement()
  })

  it('colours only the read state, and lets the caller override that colour', () => {
    const { container } = render(<DeliveryTicks deliveryState="read" readClassName="text-sky-300" />)
    expect(container.querySelector('.text-sky-300')).not.toBeNull()
    expect(container.querySelector('.text-sky-500')).toBeNull()
  })

  it('hides the glyphs from assistive tech so the label is the only thing read out', () => {
    const { container } = render(<DeliveryTicks deliveryState="read" />)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/web exec vitest run src/features/chat/components/DeliveryTicks.test.tsx`

Expected: FAIL — cannot resolve `./DeliveryTicks.tsx`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/features/chat/components/DeliveryTicks.tsx`:

```tsx
import { Check } from 'lucide-react'
import type { ChatDeliveryState } from '@support/types'

/**
 * One grey tick: the server has the message. Two blue ticks: the other side read it.
 *
 * Styled with bare Tailwind utilities and `currentColor`, for the reason spelled
 * out at the top of ChatThread.tsx — this component is shared, and each surface
 * defines its own tokens in its own scoped stylesheet, so a hand-written CSS rule
 * here would land on whichever global stylesheet loaded last.
 *
 * The read colour is a prop rather than a token because the two surfaces render
 * these ticks against different backgrounds: the webview puts them on the page
 * background below the bubble, the agent console puts them inside a slate-600
 * bubble. One blue cannot be legible on both, and blue is the whole signal.
 *
 * 'sending' and 'failed' render nothing — both already have their own text
 * treatment in the callers, and a tick beside "Not sent." would contradict it.
 */
export function DeliveryTicks({
  deliveryState,
  readClassName = 'text-sky-500',
}: {
  deliveryState?: ChatDeliveryState
  readClassName?: string
}) {
  if (deliveryState !== 'sent' && deliveryState !== 'delivered' && deliveryState !== 'read') return null

  // 'delivered' is never written by any code path (see the spec's Out of scope).
  // Rendering it as 'sent' means a future writer of that state degrades quietly
  // instead of showing an empty gap.
  const read = deliveryState === 'read'

  return (
    <span className={read ? readClassName : 'opacity-70'}>
      <span className="inline-flex items-center align-middle" aria-hidden="true">
        <Check className="size-3.5" strokeWidth={3} />
        {read && <Check className="-ml-2 size-3.5" strokeWidth={3} />}
      </span>
      {/* Colour is never the only carrier of the signal. */}
      <span className="sr-only">{read ? 'Seen' : 'Sent'}</span>
    </span>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/web exec vitest run src/features/chat/components/DeliveryTicks.test.tsx`
Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/chat/components/DeliveryTicks.tsx \
  frontend/src/features/chat/components/DeliveryTicks.test.tsx
git commit -m "feat: add shared DeliveryTicks component"
```

---

### Task 5: Render the ticks in both threads

**Files:**
- Modify: `frontend/src/features/chat/components/types.ts` (add `readAt`)
- Modify: `frontend/src/features/chat/components/ChatThread.tsx:27-60` (agent console)
- Modify: `frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx:59-73` (webview)
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:14-16` (`toChatMessage`)
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx:14-23` (`toChatMessage`)
- Test: create `frontend/src/features/chat/components/ChatThread.test.tsx`

**Interfaces:**
- Consumes: `DeliveryTicks` from Task 4; `read_at` on the message views from Task 1.
- Produces: `ChatMessage.readAt?: string | null`.

- [ ] **Step 1: Write the failing test**

The internal-note rule is the one that must not regress, so it gets a test. Create `frontend/src/features/chat/components/ChatThread.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatThread } from './ChatThread.tsx'
import type { ChatMessage } from './types.ts'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    authorType: 'agent',
    body: 'hello',
    createdAt: '2026-08-11T10:42:00.000Z',
    deliveryState: 'read',
    visibility: 'public',
    ...overrides,
  }
}

describe('ChatThread read receipts', () => {
  it('shows Seen on the agent\'s own read message', () => {
    render(<ChatThread messages={[message()]} currentAuthorType="agent" />)
    expect(screen.getByText('Seen')).toBeInTheDocument()
  })

  it('shows Sent on the agent\'s own unread message', () => {
    render(<ChatThread messages={[message({ deliveryState: 'sent' })]} currentAuthorType="agent" />)
    expect(screen.getByText('Sent')).toBeInTheDocument()
  })

  it('never shows a receipt on an internal note, which no player can see', () => {
    render(<ChatThread messages={[message({ visibility: 'internal' })]} currentAuthorType="agent" />)
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
    expect(screen.queryByText('Sent')).not.toBeInTheDocument()
  })

  it('never shows a receipt on the other side\'s message', () => {
    render(<ChatThread messages={[message({ authorType: 'player' })]} currentAuthorType="agent" />)
    expect(screen.queryByText('Seen')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/web exec vitest run src/features/chat/components/ChatThread.test.tsx`

Expected: FAIL — "Unable to find an element with the text: Seen". (If `react-virtuoso` renders nothing under jsdom because the container has zero height, give the wrapper an explicit height in the test via `render(<div style={{ height: 600 }}>…</div>)`; `ConversationList.test.tsx` is the local precedent for working around virtualization.)

- [ ] **Step 3: Add `readAt` to the shared message shape**

In `frontend/src/features/chat/components/types.ts`:

```ts
export type ChatMessage = {
  id: string
  authorType: ChatAuthorType
  body: string
  createdAt: string
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
  /** ISO 8601 when the other side read it, null if they have not. Carried for tooltips and debugging — the tick itself keys off deliveryState alone. */
  readAt?: string | null
  visibility?: 'public' | 'internal'
}
```

Map it in both `toChatMessage` functions — `SupportChat.tsx` (whose parameter type is inlined, so add `read_at: string | null` to it) and `ThreadPanel.tsx` (typed as `AgentMessageView`, so just read the field):

```ts
// ThreadPanel.tsx
function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    visibility: m.visibility,
  }
}
```

- [ ] **Step 4: Render in `ChatThread.tsx`**

Import `DeliveryTicks` and add it after the existing `<time>` element, inside the same bubble div. Gate on own **and** public:

```tsx
            <time dateTime={chatMessage.createdAt} className="mt-1 block text-xs opacity-80">
              {new Date(chatMessage.createdAt).toLocaleTimeString()}
            </time>
            {/* Never on an internal note: the player cannot see the message, so
                any receipt would be a claim about something they never got. */}
            {isOwn && !isInternal && (
              <span className="mt-0.5 block text-xs">
                {/* sky-300, not the default sky-500: an own bubble here is slate-600, and the darker blue disappears against it. */}
                <DeliveryTicks deliveryState={chatMessage.deliveryState} readClassName="text-sky-300" />
              </span>
            )}
```

- [ ] **Step 5: Render in `ChatBubbles.tsx`**

The webview's metadata row already exists below the bubble. Add the ticks beside the timestamp, only for own messages:

```tsx
        <div className="flex items-center gap-2 px-1 text-xs text-muted">
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {/* Default sky-500: this row sits on the page background, not on the accent bubble. */}
          {own && <DeliveryTicks deliveryState={message.deliveryState} />}
          {message.deliveryState === 'sending' && <span>Sending…</span>}
```

`own` is already computed at the top of `ChatBubble`. `DeliveryTicks` returns `null` for `sending`/`failed`, so it does not compete with the two lines below it.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @support/web exec vitest run src/features/chat/components/ChatThread.test.tsx
pnpm --filter @support/web test
pnpm typecheck
```

Expected: PASS. `typecheck` also runs eslint on the frontend.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/chat/components/types.ts \
  frontend/src/features/chat/components/ChatThread.tsx \
  frontend/src/features/chat/components/ChatThread.test.tsx \
  frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx \
  frontend/src/surfaces/webview/pages/SupportChat.tsx \
  frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx
git commit -m "feat: render delivery ticks in both thread renderers"
```

---

### Task 6: Flip the ticks live

Without this the ticks only change on an unrelated refetch. Each client listens for `message:read` and refetches the message list it already owns.

**Files:**
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx:71-84` (socket effect)
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx:54-65` (socket effect)

**Interfaces:**
- Consumes: the `message:read` event from Task 3.
- Produces: nothing new. Reuses the existing query keys `['playerMessages', sessionId]` and `['conversation', conversationId, 'messages']`.

- [ ] **Step 1: Add the handler in the webview**

In `SupportChat.tsx`, inside the existing socket effect, directly after the `message:new` handler:

```tsx
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    // The payload's up_to_seq/read_at are deliberately unused. Refetching keeps
    // the "which messages count as read" rule in exactly one place — the server.
    // Patching the cache from the payload would duplicate that rule here, and it
    // is asymmetric (each side only ever marks the other side's messages).
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
```

- [ ] **Step 2: Add the handler in the agent console**

In `ThreadPanel.tsx`, same placement inside its socket effect:

```tsx
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    })
    socket.on('message:read', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    })
```

Neither client filters on `reader_type`: the server already routes each receipt to the opposite audience's room, so a client never receives an echo of its own read.

- [ ] **Step 3: Verify end to end in the running app**

```bash
docker compose up -d
pnpm db:setup && pnpm db:seed
pnpm dev
```

Then, with the agent console (`http://localhost:5173`) and the webview open side by side against the same conversation:

1. Send a message as the player → one grey tick appears immediately.
2. Open that conversation in the agent console → the player's tick turns into two blue ticks **without touching the webview**.
3. Reply as the agent → one grey tick in the console.
4. Bring the webview forward → the console's tick turns blue.
5. Post an internal note as the agent → no tick at all on it.
6. Confirm in `pnpm db:studio` that `message.read_at` is populated for the read rows and null for the unread ones.

- [ ] **Step 4: Run everything**

```bash
pnpm test
pnpm typecheck
```

Expected: all suites PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/webview/pages/SupportChat.tsx \
  frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx
git commit -m "feat: refetch messages on a read receipt so ticks flip live"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| Semantics table (`sent` → one tick, `read` → two blue, `delivered` as `sent`) | 4 |
| No tick on internal notes | 5 |
| No tick on bot/system/other-side messages | 5 |
| Blue means a human saw it (bot never flips it) | 2 — the mark-read predicates are unchanged, so bot ingestion still cannot set `read` |
| `message.read_at`, first-read-wins | 1, 2 |
| `read_at` in both serializers and the wire type | 1 |
| `MessageReadEvent` + `message:read` routing | 3 |
| Emit after commit, skip when nothing changed | 3 |
| No body in the socket payload | 3 |
| Shared `DeliveryTicks`, `currentColor`, a11y label | 4 |
| Socket handlers on both clients | 6 |
| `openapi.ts` needs no edit | n/a — verified: it registers paths only, no message response schema |
