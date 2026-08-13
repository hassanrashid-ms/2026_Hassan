# Chat Module Implementation Plan

> **Executed and partly superseded — read this before copying anything out of it.** This is a
> historical execution record; it is not updated in place. Two behaviours it specifies were
> replaced on 2026-08-13 by
> [`docs/specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md`](../specs/2026-08-13-conversation-lifecycle-events-and-session-attribution-design.md):
>
> 1. **`GET /surface/messages` no longer 404s on a `session_id` that is not the caller's own.**
>    The gate protected nothing (RLS already scopes the read by `player_id`) and broke live sync
>    whenever the session row had not been uploaded yet. `session_id` is now validated and ignored.
> 2. **`conversation.session_id` is no longer "the player's most recent session."** It is the
>    verified session from the creating request, with latest-started only as a fallback.
>
> Also added since: creation writes `conversation_opened` + `conversation_assigned_bot`, and
> `claimConversation` writes `conversation_assigned`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task — **with one
> deviation from the default**: do **not** dispatch a review/validator subagent after each task.
> Each task's own implementer runs that task's `pnpm typecheck` (and `pnpm test` for the file(s) it
> just wrote, which is fine to run solo) as its own exit check, then stops — no second agent
> re-reviews it. Validation instead happens at the **Batch Checkpoint** after every batch of
> parallel tasks, and once more at the end (see "Batch Checkpoint" and "Final Validation" below).
> Tasks within the same batch touch disjoint files by design and may be dispatched to parallel
> subagents; batches themselves are sequential (batch 1 must finish and pass its checkpoint before
> batch 2 starts).

**Goal:** Ship the smallest end-to-end slice of the support chat loop — player sends a message,
an agent claims the conversation and replies, the player sees the reply live or on next fetch —
per `docs/specs/2026-08-06-chat-module-design.md`.

**Architecture:** One shared domain function (`postMessage`) that every send path funnels through
inside a single DB transaction (bump `message_seq`, insert `message`, append an `event`). Two
serializers (`toPlayerView`, `toAgentView`) are the only code that decides what a message looks
like to each audience. Socket.io pushes are best-effort notifications layered on top of a REST
write path that never depends on them. A dev-picker stub stands in for the Google-OAuth agent
session this slice explicitly defers.

**Tech Stack:** Express 5 + Drizzle (existing) · Socket.io 4 + `@socket.io/redis-adapter` (new) ·
React 19 + Vite (existing) · TanStack Query 5, `react-router-dom` 7, `react-virtuoso` 4,
`socket.io-client` 4 (new).

## Global Constraints

- **No schema changes.** `conversation` and `message` already carry everything this slice needs.
  Nothing in this plan touches `backend/src/shared/db/schema/**` or `backend/src/shared/db/sql/**`.
- **`postMessage(tx, {...})` is the only place** that bumps `message_seq`, inserts a `message`, and
  appends the matching `event`, always in that order, always in the caller's transaction. No task
  may reimplement any piece of that sequence elsewhere.
- **Two serializers only.** `toPlayerView` is an explicit whitelist that returns `null` for any row
  whose `visibility <> 'public'`. `toAgentView` is permissive. Files under `backend/src/surface/`
  may only import `toPlayerView`; files under `backend/src/agent/` may only import `toAgentView`.
  Never add a visibility filter to a query — the row is always fetched whole.
- **RLS-shaped 404s, not 403s**, for tenancy misses (an agent or player reaching an id outside
  their scope). The **one** real 403 in this slice is an agent replying to a conversation that
  isn't assigned to them — that is a genuine permission failure, not a tenancy question.
- **Claiming is a race, not an error.** Zero rows updated by the claim `UPDATE` is a normal
  `{ claimed: false }` response.
- **REST is the write path; sockets are push-only.** Every socket emit happens strictly after the
  triggering DB transaction has committed — never inside `withWorkspace`/`postMessage`. A missed
  socket event must never be the only way a client learns something happened; `GET .../messages`
  is always the fallback.
- **Two Socket.io rooms per conversation** (`conv:{id}:player`, `conv:{id}:agents`), always emitted
  to separately with two different payloads — never one emit both sides subscribe to. Agents also
  join one workspace-wide room, `workspace:{id}:inbox`.
- **Empty message body**: rejected client-side (disabled Send button) and re-validated server-side
  (`422` via Zod, `min(1)`).
- **No hard deletes, append-only events** — already enforced by `002_rls.sql`; nothing here changes
  that.
- **Player-facing copy is British English**, per the existing convention in `SupportSurface.tsx`.
- **Per-task gate:** `pnpm --filter @support/api typecheck` (backend tasks) or
  `pnpm --filter @support/web typecheck && pnpm --filter @support/web build` (frontend tasks). A
  task may also run its own new test file with vitest as part of writing it — that's an ordinary
  part of TDD, not a validation step, and it's fine even though the shared Postgres test DB means
  two tasks' test runs shouldn't be *literally* simultaneous. What must **not** happen is a second
  agent re-reviewing a first agent's finished task.
- **Batch Checkpoint** (after every batch, see below): `pnpm typecheck` and `pnpm test` across the
  whole repo, plus `pnpm --filter @support/web build`. This is a mechanical command run, not an AI
  code review.

---

## Batching

```
Batch 0 (sequential, 1 task)  → Task 1
Batch 1 (parallel, 4 tasks)   → Tasks 2, 3, 4, 5      [depends only on Task 1]
  ── Batch 1 Checkpoint ──
Batch 2 (parallel, 5 tasks)   → Tasks 6, 7, 8, 9, 10   [depends on all of Batch 1]
  ── Batch 2 Checkpoint (includes router wiring + isolation-sweep tests) ──
Final Validation
```

Tasks within a batch touch disjoint files by construction — see each task's **Files** list. No
task in Batch 1 imports anything another Batch-1 task creates (each is independently typecheckable
against Task 1 + the pre-existing codebase alone). Batch 2 tasks may freely import Batch 1's output
since Batch 1 is complete and checkpointed before Batch 2 starts; within Batch 2, no task imports
another Batch-2 task's new files.

---

## Task 1: Agent-session primitive, `agent/` folder, router mount

**Batch:** 0 (sequential prerequisite for everything else)

**Files:**
- Rename: `backend/src/agentside/` → `backend/src/agent/` (git mv; drop the unused `models/`
  subfolder — this codebase's actual per-vertical layout is `routers/controllers/services` only,
  matching `surface/`, not the aspirational `models/` in the folder-structure-revamp doc)
- Create: `backend/src/shared/auth/agentSession.ts`
- Create: `backend/src/agent/router.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/env.ts`
- Modify: `.env.example`, `.env.test.example` (tracked) — plus your local `.env`, `.env.test`
  (gitignored, not part of any commit)
- Test: `backend/tests/auth.agentSession.test.ts`

**Interfaces:**
- Produces: `signAgentSession(claims: { agent_id: string; workspace_id: string }, ttlSeconds?: number): Promise<string>`,
  `verifyAgentSession(token: string): Promise<{ agent_id: string; workspace_id: string }>`,
  `class InvalidAgentSession extends Error` — all from `backend/src/shared/auth/agentSession.ts`.
  Produces `agentRouter: Router` (empty for now) from `backend/src/agent/router.ts`, mounted at
  `app.use('/agent', agentRouter)` in `app.ts`.
- Consumes: nothing new — `getEnv()` (existing), `jose` (existing dependency).

- [ ] **Step 1: Rename the scaffolded folder**

```bash
git mv backend/src/agentside/routers backend/src/agent/routers
git mv backend/src/agentside/controllers backend/src/agent/controllers
git mv backend/src/agentside/services backend/src/agent/services
git rm backend/src/agentside/models/.gitkeep
rmdir backend/src/agentside/models backend/src/agentside 2>/dev/null || true
```

- [ ] **Step 2: Create the (still-empty) agent router**

`backend/src/agent/router.ts`:

```ts
import { Router } from 'express'

// Sub-routers (auth, conversations, messages) are added by later tasks in this
// plan. Kept as its own file, mirroring sdk/router.ts and surface/router.ts, so
// those later tasks each add one `.use()` line rather than editing app.ts.
export const agentRouter = Router()
```

- [ ] **Step 3: Mount it in `app.ts`**

In `backend/src/app.ts`, add the import and mount line:

```ts
import { agentRouter } from './agent/router.ts'
```

```ts
  app.use('/auth', playerTokenRouter)
  app.use('/sdk', sdkRouter)
  app.use('/surface', surfaceRouter)
  app.use('/agent', agentRouter)
```

- [ ] **Step 4: Run typecheck to confirm the rename and mount didn't break anything**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS (no route behaviour changed yet — `agentRouter` has zero routes)

- [ ] **Step 5: Commit the mechanical rename/mount**

```bash
git add backend/src/agent backend/src/app.ts
git commit -m "chore(agent): rename agentside/ to agent/, mount empty agentRouter"
```

- [ ] **Step 6: Add the env var**

In `backend/src/env.ts`, add to `EnvSchema` (right after `PLAYER_JWT_SECRET`/`PLAYER_TOKEN_TTL_SECONDS`):

```ts
  AGENT_SESSION_JWT_SECRET: z
    .string()
    .min(32, 'AGENT_SESSION_JWT_SECRET must be at least 32 characters'),
```

- [ ] **Step 7: Add it to the tracked env templates**

In `.env.example`, after the `PLAYER_TOKEN_TTL_SECONDS` line:

```
# Stands in for the Google-OAuth agent session this slice defers. 32+ chars.
AGENT_SESSION_JWT_SECRET=change-me-change-me-change-me-change-me
```

Same block in `.env.test.example`. Then add the same two lines (with any value ≥32 chars) to your
own local `.env` and `.env.test` — these are gitignored, so this half of the step is not part of
any commit, but `getEnv()` will throw on startup/test-run without it.

- [ ] **Step 8: Write the failing test**

`backend/tests/auth.agentSession.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { InvalidAgentSession, signAgentSession, verifyAgentSession } from '../src/shared/auth/agentSession.ts'

describe('agent session token', () => {
  it('round-trips valid claims', async () => {
    const token = await signAgentSession({ agent_id: 'a1', workspace_id: 'w1' })
    const claims = await verifyAgentSession(token)
    expect(claims).toEqual({ agent_id: 'a1', workspace_id: 'w1' })
  })

  it('rejects an expired token', async () => {
    const token = await signAgentSession({ agent_id: 'a1', workspace_id: 'w1' }, -1)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })

  it('rejects a token signed with a different audience', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET)
    const token = await new SignJWT({ agent_id: 'a1', workspace_id: 'w1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('some-other-audience')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })

  it('rejects a token missing a required claim', async () => {
    const { SignJWT } = await import('jose')
    const key = new TextEncoder().encode(process.env.AGENT_SESSION_JWT_SECRET)
    const token = await new SignJWT({ agent_id: 'a1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('support-crm')
      .setAudience('support-agent-dev')
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(key)
    await expect(verifyAgentSession(token)).rejects.toThrow(InvalidAgentSession)
  })
})
```

- [ ] **Step 9: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- auth.agentSession`
Expected: FAIL — `agentSession.ts` module not found

- [ ] **Step 10: Implement `agentSession.ts`**

`backend/src/shared/auth/agentSession.ts`:

```ts
import { SignJWT, jwtVerify } from 'jose'
import { getEnv } from '../../env.ts'

const ISSUER = 'support-crm'
const AUDIENCE = 'support-agent-dev'

export type AgentSessionClaims = { agent_id: string; workspace_id: string }

function key(): Uint8Array {
  return new TextEncoder().encode(getEnv().AGENT_SESSION_JWT_SECRET)
}

/**
 * Stands in for the real Google-OAuth session this slice defers (see
 * docs/decisions/2026-08-04-agent-auth-google-oauth.md). A separate secret and
 * audience from the player token keep the two credentials from ever being
 * interchangeable, even by accident.
 */
export async function signAgentSession(
  claims: AgentSessionClaims,
  ttlSeconds: number = 60 * 60 * 12,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key())
}

export class InvalidAgentSession extends Error {}

export async function verifyAgentSession(token: string): Promise<AgentSessionClaims> {
  let payload: Record<string, unknown>
  try {
    ;({ payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }))
  } catch (error) {
    throw new InvalidAgentSession(error instanceof Error ? error.message : 'token rejected')
  }

  const { agent_id, workspace_id } = payload
  if (typeof agent_id !== 'string' || typeof workspace_id !== 'string') {
    throw new InvalidAgentSession('token is missing a required claim')
  }
  return { agent_id, workspace_id }
}
```

- [ ] **Step 11: Run the test to confirm it passes**

Run: `pnpm --filter @support/api test -- auth.agentSession`
Expected: PASS (all 4 cases)

- [ ] **Step 12: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add backend/src/shared/auth/agentSession.ts backend/src/env.ts .env.example .env.test.example backend/tests/auth.agentSession.test.ts
git commit -m "feat(agent): agent-session sign/verify primitive (dev-auth stand-in)"
```

---

## Batch 1 (parallel: Tasks 2, 3, 4, 5)

Each of the four tasks below is independently typecheckable using only Task 1's output plus the
pre-existing codebase — none of them imports anything another Batch-1 task creates. Dispatch all
four to separate subagents at once.

---

## Task 2: Domain conversations module + shared chat types

**Batch:** 1

**Files:**
- Create: `packages/types/src/chat.ts`
- Modify: `packages/types/src/index.ts`
- Test: `packages/types/tests/chat.test.ts`
- Create: `backend/src/domain/conversations/postMessage.ts`
- Create: `backend/src/domain/conversations/serializers.ts`
- Create: `backend/src/domain/conversations/index.ts`
- Test: `backend/tests/domain.postMessage.test.ts`
- Test: `backend/tests/domain.serializers.test.ts`

**Interfaces:**
- Produces (from `@support/types`, i.e. `packages/types/src/chat.ts`): Zod schemas
  `SendMessageBody`, `SendAgentMessageBody`, `MarkPlayerReadBody`, `MarkAgentReadBody`; types
  `ChatAuthorType`, `ChatDeliveryState`, `ConversationStatusValue`, `PlayerMessageView`,
  `AgentMessageView`, `PlayerMessagesResponse`, `AgentMessagesResponse`, `ClaimResponse`,
  `AgentConversationSummary`, `AgentConversationsResponse`, `ConversationChangedEvent`.
- Produces (from `backend/src/domain/conversations/index.ts`):
  `postMessage(tx: Tx, input: PostMessageInput): Promise<PostedMessageRow>`,
  `toPlayerView(row: PostedMessageRow): PlayerMessageView | null`,
  `toAgentView(row: PostedMessageRow): AgentMessageView`, and the `PostMessageInput` /
  `PostedMessageRow` types themselves.
- Consumes: existing `backend/src/shared/db/schema/index.ts` (`conversation`, `message`),
  `backend/src/shared/db/withWorkspace.ts` (`Tx`), `backend/src/shared/events/appendEvent.ts`
  (`appendEvent`) — all pre-existing.

- [ ] **Step 1: Write the failing chat-types test**

`packages/types/tests/chat.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MarkAgentReadBody, MarkPlayerReadBody, SendAgentMessageBody, SendMessageBody } from '../src/chat.ts'

describe('chat request schemas', () => {
  it('SendMessageBody accepts a non-empty body', () => {
    expect(SendMessageBody.safeParse({ body: 'hello' }).success).toBe(true)
  })

  it('SendMessageBody rejects an empty body', () => {
    expect(SendMessageBody.safeParse({ body: '' }).success).toBe(false)
  })

  it('SendAgentMessageBody requires a uuid conversation_id', () => {
    expect(SendAgentMessageBody.safeParse({ conversation_id: 'not-a-uuid', body: 'hi' }).success).toBe(false)
    expect(
      SendAgentMessageBody.safeParse({ conversation_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', body: 'hi' })
        .success,
    ).toBe(true)
  })

  it('MarkPlayerReadBody requires a non-negative integer', () => {
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: -1 }).success).toBe(false)
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: 1.5 }).success).toBe(false)
    expect(MarkPlayerReadBody.safeParse({ up_to_seq: 3 }).success).toBe(true)
  })

  it('MarkAgentReadBody requires both fields', () => {
    expect(MarkAgentReadBody.safeParse({ up_to_seq: 3 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @support/types test -- chat`
Expected: FAIL — `../src/chat.ts` not found

- [ ] **Step 3: Implement `chat.ts`**

`packages/types/src/chat.ts`:

```ts
import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — this ships with the server, same as
 * surface.ts. Shared between the surface (player) and agent verticals so both
 * sides of the chat loop agree on one shape.
 */
export const SendMessageBody = z.object({ body: z.string().min(1).max(4000) })

export const SendAgentMessageBody = z.object({
  conversation_id: z.uuid(),
  body: z.string().min(1).max(4000),
})

export const MarkPlayerReadBody = z.object({ up_to_seq: z.number().int().nonnegative() })

export const MarkAgentReadBody = z.object({
  conversation_id: z.uuid(),
  up_to_seq: z.number().int().nonnegative(),
})

export type ChatAuthorType = 'player' | 'agent' | 'bot' | 'system'
export type ChatDeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
export type ConversationStatusValue =
  | 'new'
  | 'bot_active'
  | 'open'
  | 'awaiting_player'
  | 'escalated'
  | 'resolved'
  | 'closed'

export type PlayerMessageView = {
  id: string
  seq: number
  author_type: ChatAuthorType
  body: string
  delivery_state: ChatDeliveryState
  created_at: string
}

/** Same fields as PlayerMessageView plus the two an agent may see and a player may not. */
export type AgentMessageView = PlayerMessageView & {
  author_agent_id: string | null
  visibility: 'public' | 'internal'
}

export type PlayerMessagesResponse = { conversation_id: string | null; messages: PlayerMessageView[] }
export type AgentMessagesResponse = { messages: AgentMessageView[] }
export type ClaimResponse = { claimed: boolean }

export type AgentConversationSummary = {
  id: string
  player: { external_player_id: string }
  status: ConversationStatusValue
  last_message_preview: string | null
  last_message_at: string | null
}
export type AgentConversationsResponse = { conversations: AgentConversationSummary[] }

/** The inbox-room payload: id and new status only, never the full row. */
export type ConversationChangedEvent = { conversation_id: string; status: ConversationStatusValue }
```

`packages/types/src/index.ts` — add one line:

```ts
export * from './chat.ts'
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @support/types test -- chat`
Expected: PASS

- [ ] **Step 5: Write the failing domain-serializers test**

`backend/tests/domain.serializers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { toAgentView, toPlayerView } from '../src/domain/conversations/index.ts'
import type { PostedMessageRow } from '../src/domain/conversations/index.ts'

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
    ...overrides,
  }
}

describe('toPlayerView', () => {
  it('returns the whitelisted fields for a public message', () => {
    expect(toPlayerView(row())).toEqual({
      id: 'm1',
      seq: 1,
      author_type: 'agent',
      body: 'hello',
      delivery_state: 'sent',
      created_at: '2026-08-06T00:00:00.000Z',
    })
  })

  it('returns null for an internal message, guarding the serializer split even though this slice never writes internal itself', () => {
    expect(toPlayerView(row({ visibility: 'internal' }))).toBeNull()
  })
})

describe('toAgentView', () => {
  it('never returns null and includes visibility and author_agent_id', () => {
    expect(toAgentView(row({ visibility: 'internal' }))).toEqual({
      id: 'm1',
      seq: 1,
      author_type: 'agent',
      author_agent_id: 'ag1',
      body: 'hello',
      visibility: 'internal',
      delivery_state: 'sent',
      created_at: '2026-08-06T00:00:00.000Z',
    })
  })
})
```

- [ ] **Step 6: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- domain.serializers`
Expected: FAIL — module not found

- [ ] **Step 7: Write the failing domain-postMessage test**

`backend/tests/domain.postMessage.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { postMessage } from '../src/domain/conversations/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('postMessage', () => {
  it('bumps message_seq, inserts the message, and appends a message_sent event', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const posted = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'hi there',
      }),
    )

    expect(posted.seq).toBe(1)
    expect(posted.body).toBe('hi there')
    expect(posted.deliveryState).toBe('sent')
  })

  it('never produces a duplicate seq under concurrent sends into the same conversation', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        withWorkspace(workspaceId, (tx) =>
          postMessage(tx, {
            workspaceId,
            conversationId,
            authorType: 'player',
            actorId: playerId,
            body: `msg ${i}`,
          }),
        ),
      ),
    )

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })
})
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- domain.postMessage`
Expected: FAIL — module not found

- [ ] **Step 9: Implement `postMessage.ts`**

`backend/src/domain/conversations/postMessage.ts`:

```ts
import { eq, sql } from 'drizzle-orm'
import type { ChatAuthorType, ChatDeliveryState } from '@support/types'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import type { Tx } from '../../shared/db/withWorkspace.ts'

export type PostMessageInput = {
  workspaceId: string
  conversationId: string
  authorType: ChatAuthorType
  /** The player id or agent id behind this send — recorded on the event, not the message row. */
  actorId: string
  authorAgentId?: string | null
  body: string
  visibility?: 'public' | 'internal'
}

export type PostedMessageRow = {
  id: string
  conversationId: string
  seq: number
  authorType: ChatAuthorType
  authorAgentId: string | null
  body: string
  visibility: 'public' | 'internal'
  deliveryState: ChatDeliveryState
  createdAt: Date
}

/**
 * The one place that bumps `message_seq`, inserts the message, and appends the
 * event — always in that order, always in the caller's transaction. The UPDATE
 * below takes a row lock on the conversation row, so a second concurrent call
 * against the same conversation blocks until this one commits: that lock, not
 * any application-level retry, is what keeps `seq` gap-free of duplicates.
 *
 * No I/O beyond these three DB statements — no socket emit here. The caller
 * emits only after this transaction commits, so a rolled-back message is never
 * pushed to a client that thinks it succeeded.
 */
export async function postMessage(tx: Tx, input: PostMessageInput): Promise<PostedMessageRow> {
  const [bumped] = await tx
    .update(conversation)
    .set({ messageSeq: sql`${conversation.messageSeq} + 1` })
    .where(eq(conversation.id, input.conversationId))
    .returning({ seq: conversation.messageSeq })

  if (!bumped) {
    throw new Error(`postMessage: conversation ${input.conversationId} not found`)
  }

  const [inserted] = await tx
    .insert(message)
    .values({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      seq: bumped.seq,
      authorType: input.authorType,
      authorAgentId: input.authorAgentId ?? null,
      body: input.body,
      visibility: input.visibility ?? 'public',
    })
    .returning()

  if (!inserted) {
    throw new Error('postMessage: message insert returned nothing')
  }

  await appendEvent(tx, {
    workspaceId: input.workspaceId,
    type: 'message_sent',
    conversationId: input.conversationId,
    actorId: input.actorId,
    actorType: input.authorType,
    payload: { seq: bumped.seq, author_type: input.authorType },
  })

  return inserted
}
```

- [ ] **Step 10: Implement `serializers.ts`**

`backend/src/domain/conversations/serializers.ts`:

```ts
import type { AgentMessageView, PlayerMessageView } from '@support/types'
import type { PostedMessageRow } from './postMessage.ts'

/**
 * Explicit whitelist: returns null for any row whose visibility is not
 * 'public'. The caller (a player-facing service) must filter the nulls out —
 * see docs/decisions/2026-08-04-three-audience-api-structure.md. Never add a
 * visibility filter to the query that fetches these rows; the row is always
 * fetched whole and this function is the only place that decides.
 */
export function toPlayerView(row: PostedMessageRow): PlayerMessageView | null {
  if (row.visibility !== 'public') return null
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    body: row.body,
    delivery_state: row.deliveryState,
    created_at: row.createdAt.toISOString(),
  }
}

/** Permissive: every field, every visibility. Only backend/src/agent/** may import this. */
export function toAgentView(row: PostedMessageRow): AgentMessageView {
  return {
    id: row.id,
    seq: row.seq,
    author_type: row.authorType,
    author_agent_id: row.authorAgentId,
    body: row.body,
    visibility: row.visibility,
    delivery_state: row.deliveryState,
    created_at: row.createdAt.toISOString(),
  }
}
```

`backend/src/domain/conversations/index.ts`:

```ts
export * from './postMessage.ts'
export * from './serializers.ts'
```

- [ ] **Step 11: Run both domain tests to confirm they pass**

Run: `pnpm --filter @support/api test -- domain.postMessage domain.serializers`
Expected: PASS (3 tests)

- [ ] **Step 12: Run typecheck across both packages**

Run: `pnpm --filter @support/types typecheck && pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add packages/types/src/chat.ts packages/types/src/index.ts packages/types/tests/chat.test.ts \
        backend/src/domain backend/tests/domain.postMessage.test.ts backend/tests/domain.serializers.test.ts
git commit -m "feat(domain): shared chat types, postMessage, toPlayerView/toAgentView"
```

---

## Task 3: Realtime infrastructure — Socket.io server, rooms, emit helpers

**Batch:** 1

**Files:**
- Modify: `backend/package.json` (add `socket.io`, `@socket.io/redis-adapter`; add
  `socket.io-client` as a devDependency for the in-process test)
- Create: `backend/src/shared/realtime/rooms.ts`
- Create: `backend/src/shared/realtime/socketServer.ts`
- Create: `backend/src/shared/realtime/emit.ts`
- Modify: `backend/src/server.ts`
- Create: `backend/tests/helpers/realtime.ts`
- Test: `backend/tests/realtime.rooms.test.ts`

**Interfaces:**
- Produces: `playerRoom(conversationId): string`, `agentRoom(conversationId): string`,
  `inboxRoom(workspaceId): string` from `rooms.ts`. `createSocketServer(httpServer: http.Server): Server`
  and `getIo(): Server` from `socketServer.ts`. `emitMessageToRooms(io, conversationId, playerPayload: unknown, agentPayload: unknown): void`
  and `emitInboxChanged(io, workspaceId, conversationId, status: string): void` from `emit.ts` —
  **deliberately untyped payloads**: this module is transport, not domain-aware, so it has no
  dependency on `@support/types` or the domain module, keeping it typecheckable standalone.
- Consumes: existing `backend/src/shared/auth/playerToken.ts` (`verifyPlayerToken`,
  `InvalidPlayerToken`), Task 1's `backend/src/shared/auth/agentSession.ts`
  (`verifyAgentSession`, `InvalidAgentSession`), existing `backend/src/shared/db/schema/index.ts`
  (`conversation`), existing `withWorkspace`.

- [ ] **Step 1: Add the dependencies**

In `backend/package.json`, add to `dependencies`:

```json
    "@socket.io/redis-adapter": "^8",
    "socket.io": "^4",
```

and to `devDependencies`:

```json
    "socket.io-client": "^4",
```

Run: `pnpm install`

- [ ] **Step 2: Write the room-name helpers (no test needed — three one-line pure functions, exercised by the test in Step 8)**

`backend/src/shared/realtime/rooms.ts`:

```ts
export const playerRoom = (conversationId: string): string => `conv:${conversationId}:player`
export const agentRoom = (conversationId: string): string => `conv:${conversationId}:agents`
export const inboxRoom = (workspaceId: string): string => `workspace:${workspaceId}:inbox`
```

- [ ] **Step 3: Write the emit helpers**

`backend/src/shared/realtime/emit.ts`:

```ts
import type { Server } from 'socket.io'
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts'

/**
 * Payloads are `unknown` on purpose: this module is transport, not
 * domain-aware. The caller (a surface/agent service, after its transaction has
 * committed) already ran the row through toPlayerView/toAgentView and passes
 * the finished view object straight through.
 */
export function emitMessageToRooms(
  io: Server,
  conversationId: string,
  playerPayload: unknown,
  agentPayload: unknown,
): void {
  io.to(agentRoom(conversationId)).emit('message:new', agentPayload)
  if (playerPayload !== null) {
    io.to(playerRoom(conversationId)).emit('message:new', playerPayload)
  }
}

/** id and new status only — never the full conversation row. */
export function emitInboxChanged(io: Server, workspaceId: string, conversationId: string, status: string): void {
  io.to(inboxRoom(workspaceId)).emit('conversation:changed', { conversation_id: conversationId, status })
}
```

- [ ] **Step 4: Implement the socket server**

`backend/src/shared/realtime/socketServer.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import IORedis from 'ioredis'
import { createAdapter } from '@socket.io/redis-adapter'
import { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { getEnv } from '../../env.ts'
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts'
import { InvalidPlayerToken, verifyPlayerToken } from '../auth/playerToken.ts'
import { conversation } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts'

export type PlayerSocketData = { role: 'player'; workspaceId: string; playerId: string }
export type AgentSocketData = { role: 'agent'; workspaceId: string; agentId: string }
export type SocketData = PlayerSocketData | AgentSocketData

let ioInstance: Server | undefined

function redisConnection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

async function canJoinConversation(data: SocketData, conversationId: string): Promise<boolean> {
  return withWorkspace(data.workspaceId, async (tx) => {
    const where =
      data.role === 'player'
        ? and(eq(conversation.id, conversationId), eq(conversation.playerId, data.playerId))
        : eq(conversation.id, conversationId)
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(where).limit(1)
    return found !== undefined
  })
}

/**
 * Auth is on connect, not per-message: the handshake carries the same player
 * JWT or agent-session token already used for REST, verified once here.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const pubClient = redisConnection()
  const subClient = pubClient.duplicate()

  const io = new Server(httpServer, {
    cors: { origin: getEnv().SURFACE_ORIGINS, methods: ['GET', 'POST'] },
    adapter: createAdapter(pubClient, subClient),
  })

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown; role?: unknown }
    if (typeof auth.token !== 'string' || (auth.role !== 'player' && auth.role !== 'agent')) {
      next(new Error('unauthorized'))
      return
    }
    try {
      if (auth.role === 'player') {
        const claims = await verifyPlayerToken(auth.token)
        socket.data = { role: 'player', workspaceId: claims.workspace_id, playerId: claims.player_id } satisfies PlayerSocketData
      } else {
        const claims = await verifyAgentSession(auth.token)
        socket.data = { role: 'agent', workspaceId: claims.workspace_id, agentId: claims.agent_id } satisfies AgentSocketData
      }
      next()
    } catch (error) {
      if (error instanceof InvalidPlayerToken || error instanceof InvalidAgentSession) {
        next(new Error('unauthorized'))
        return
      }
      next(error instanceof Error ? error : new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const data = socket.data as SocketData
    if (data.role === 'agent') {
      socket.join(inboxRoom(data.workspaceId))
    }

    socket.on('join_conversation', (payload: { conversation_id?: unknown }, ack?: (ok: boolean) => void) => {
      const conversationId = payload.conversation_id
      if (typeof conversationId !== 'string') {
        ack?.(false)
        return
      }
      void canJoinConversation(data, conversationId).then((allowed) => {
        if (allowed) socket.join(data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId))
        ack?.(allowed)
      })
    })

    socket.on('leave_conversation', (payload: { conversation_id?: unknown }) => {
      const conversationId = payload.conversation_id
      if (typeof conversationId !== 'string') return
      socket.leave(data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId))
    })
  })

  ioInstance = io
  return io
}

export function getIo(): Server {
  if (!ioInstance) throw new Error('Socket server not initialised — call createSocketServer first.')
  return ioInstance
}
```

- [ ] **Step 5: Wire it into `server.ts`**

In `backend/src/server.ts`, add the import:

```ts
const { createSocketServer } = await import('./shared/realtime/socketServer.ts')
```

and, right after the `server` is created:

```ts
const port = getEnv().PORT
const server = createApp().listen(port, () => {
  console.log(`api listening on http://localhost:${port}`)
})
createSocketServer(server)
```

- [ ] **Step 6: Write the realtime test helper**

`backend/tests/helpers/realtime.ts`:

```ts
import { createServer } from 'node:http'
import { io as ioClient, type Socket } from 'socket.io-client'
import { app } from './app.ts'
import { createSocketServer } from '../../src/shared/realtime/socketServer.ts'

export async function startRealtimeServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(app)
  createSocketServer(httpServer)
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))

  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    throw new Error('failed to bind an ephemeral port for the test realtime server')
  }

  return {
    url: `http://localhost:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

export function connectClient(url: string, auth: { token: string; role: 'player' | 'agent' }): Socket {
  return ioClient(url, { auth, transports: ['websocket'], forceNew: true })
}
```

- [ ] **Step 7: Write the failing socket-rooms test**

`backend/tests/realtime.rooms.test.ts`:

```ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { agentRoom, playerRoom } from '../src/shared/realtime/rooms.ts'
import { getIo } from '../src/shared/realtime/socketServer.ts'
import { mintToken } from './helpers/app.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
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

describe('socket rooms stay separated by audience', () => {
  it('an agent socket in conv:{id}:agents never receives an emit intended for conv:{id}:player, and vice versa', async () => {
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
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload))
    agentSocket.on('message:new', (payload: unknown) => agentReceived.push(payload))

    getIo().to(playerRoom(conversationId)).emit('message:new', { scope: 'player-only' })
    getIo().to(agentRoom(conversationId)).emit('message:new', { scope: 'agent-only' })

    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(playerReceived).toEqual([{ scope: 'player-only' }])
    expect(agentReceived).toEqual([{ scope: 'agent-only' }])

    playerSocket.close()
    agentSocket.close()
  })

  it('a player cannot join a conversation that is not theirs', async () => {
    const workspaceId = await seedWorkspace()
    const ownerId = await seedPlayer(workspaceId, 'owner')
    const otherId = await seedPlayer(workspaceId, 'other')
    const conversationId = await seedConversation({ workspaceId, playerId: ownerId })

    const otherToken = await mintToken({ workspace_id: workspaceId, player_id: otherId, external_player_id: 'other' })
    const socket = connectClient(server.url, { token: otherToken, role: 'player' })
    await waitFor(socket, 'connect')

    const allowed = await new Promise<boolean>((resolve) =>
      socket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    )
    expect(allowed).toBe(false)
    socket.close()
  })
})
```

- [ ] **Step 8: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- realtime.rooms`
Expected: FAIL — `socketServer.ts` / `rooms.ts` not found (or, once those exist from Step 4,
passes on the first try since the implementation above was written together with the test; if so
skip ahead, but confirm by temporarily renaming `createSocketServer` and re-running to see a real
failure before renaming it back)

- [ ] **Step 9: Run the tests to confirm they pass**

Run: `pnpm --filter @support/api test -- realtime.rooms`
Expected: PASS (2 tests)

- [ ] **Step 10: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add backend/package.json backend/src/shared/realtime backend/src/server.ts \
        backend/tests/helpers/realtime.ts backend/tests/realtime.rooms.test.ts
git commit -m "feat(realtime): Socket.io server with redis adapter, audience-separated rooms"
```

---

## Task 4: Agent REST auth — dev-picker login

**Batch:** 1

**Files:**
- Create: `backend/src/shared/middleware/requireAgentSession.ts`
- Create: `backend/src/agent/services/authService.ts`
- Create: `backend/src/agent/controllers/authController.ts`
- Create: `backend/src/agent/routers/authRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/shared/db/seed.ts` (seed two more demo agents so the picker has something to
  list)
- Test: `backend/tests/agent.auth.test.ts`

**Interfaces:**
- Produces: `requireAgentSession: RequestHandler` (sets `req.agent: AgentContext`) from
  `requireAgentSession.ts`; `type AgentContext = { agentId: string; workspaceId: string }`.
  `authRouter: Router` (mounted at `/auth/dev-agents`, `/auth/dev-login`, both **public** — the
  dev picker is itself the login flow, so it cannot require the session it's about to mint).
- Consumes: Task 1's `agentSession.ts` (`verifyAgentSession`, `signAgentSession`,
  `InvalidAgentSession`), existing schema (`agent`, `workspaceMember`, `workspace`),
  `withWorkspace`/`withoutWorkspace`.

- [ ] **Step 1: Write the failing test**

`backend/tests/agent.auth.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { app } from './helpers/app.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

async function seedAgentWithMembership(workspaceId: string, email: string, displayName: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, $2) returning id`,
    [email, displayName],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  )
  return agentId
}

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('agent dev auth', () => {
  it('GET /agent/auth/dev-agents lists agents with a workspace membership', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgentWithMembership(workspaceId, 'alex@example.test', 'Alex Agent')

    const res = await request(app).get('/agent/auth/dev-agents').expect(200)
    expect(res.body.agents).toEqual([{ id: agentId, email: 'alex@example.test', display_name: 'Alex Agent' }])
  })

  it('POST /agent/auth/dev-login mints a token that requireAgentSession accepts', async () => {
    const workspaceId = await seedWorkspace()
    const agentId = await seedAgentWithMembership(workspaceId, 'sam@example.test', 'Sam Agent')

    const res = await request(app).post('/agent/auth/dev-login').send({ agent_id: agentId }).expect(200)
    expect(res.body.agent).toEqual({ id: agentId, display_name: 'Sam Agent' })
    expect(res.body.workspace.id).toBe(workspaceId)
    expect(typeof res.body.token).toBe('string')
  })

  it('POST /agent/auth/dev-login 404s for an agent with no workspace membership', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('nomember@example.test', 'No Member') returning id`,
    )
    await request(app).post('/agent/auth/dev-login').send({ agent_id: rows[0]!.id }).expect(404)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- agent.auth`
Expected: FAIL — 404 on unmounted routes

- [ ] **Step 3: Implement `requireAgentSession` middleware**

`backend/src/shared/middleware/requireAgentSession.ts`:

```ts
import type { RequestHandler } from 'express'
import { sendError } from '../../errors.ts'
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts'

export type AgentContext = { agentId: string; workspaceId: string }

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      agent?: AgentContext
    }
  }
}

export const requireAgentSession: RequestHandler = async (req, res, next) => {
  const header = req.header('authorization') ?? ''
  const [scheme, ...rest] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <agent_session_token> header.')
    return
  }

  try {
    const claims = await verifyAgentSession(rest.join(' ').trim())
    req.agent = { agentId: claims.agent_id, workspaceId: claims.workspace_id }
    next()
  } catch (error) {
    if (error instanceof InvalidAgentSession) {
      sendError(res, 401, 'unauthorized', 'Agent session is not valid.')
      return
    }
    next(error)
  }
}
```

- [ ] **Step 4: Implement the dev-auth service**

`backend/src/agent/services/authService.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { agent as agentTable, workspace, workspaceMember } from '../../shared/db/schema/index.ts'
import { withoutWorkspace, withWorkspace } from '../../shared/db/withWorkspace.ts'
import { signAgentSession } from '../../shared/auth/agentSession.ts'

export type DevAgentOption = { id: string; email: string; display_name: string }

/**
 * `workspace_member` is RLS-scoped, so it can only be read inside
 * `withWorkspace(someWorkspaceId, ...)` — there is no query that answers "which
 * agents have any membership, across all workspaces" in one shot. This loops
 * over every workspace instead, which is fine for a handful of dev workspaces
 * and would need a different approach (e.g. a superuser reporting role) at real
 * scale — acceptable because this whole endpoint is a throwaway stand-in for
 * Google OAuth (docs/decisions/2026-08-04-agent-auth-google-oauth.md).
 */
export async function listDevAgents(): Promise<DevAgentOption[]> {
  const workspaces = await withoutWorkspace(async (tx) => tx.select({ id: workspace.id }).from(workspace))

  const seen = new Map<string, DevAgentOption>()
  for (const ws of workspaces) {
    const rows = await withWorkspace(ws.id, async (tx) =>
      tx
        .select({ id: agentTable.id, email: agentTable.email, displayName: agentTable.displayName })
        .from(workspaceMember)
        .innerJoin(agentTable, eq(agentTable.id, workspaceMember.agentId))
        .where(isNull(workspaceMember.deactivatedAt)),
    )
    for (const row of rows) {
      seen.set(row.id, { id: row.id, email: row.email, display_name: row.displayName })
    }
  }
  return [...seen.values()]
}

export type DevLoginResult = {
  token: string
  agent: { id: string; display_name: string }
  workspace: { id: string; slug: string }
} | null

export async function devLogin(agentId: string): Promise<DevLoginResult> {
  const agentRow = await withoutWorkspace(async (tx) => {
    const [row] = await tx
      .select({ id: agentTable.id, displayName: agentTable.displayName })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1)
    return row ?? null
  })
  if (!agentRow) return null

  const workspaces = await withoutWorkspace(async (tx) => tx.select({ id: workspace.id, slug: workspace.slug }).from(workspace))

  for (const ws of workspaces) {
    const membership = await withWorkspace(ws.id, async (tx) => {
      const [row] = await tx
        .select({ id: workspaceMember.id })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.agentId, agentId), isNull(workspaceMember.deactivatedAt)))
        .limit(1)
      return row ?? null
    })
    if (membership) {
      const token = await signAgentSession({ agent_id: agentRow.id, workspace_id: ws.id })
      return {
        token,
        agent: { id: agentRow.id, display_name: agentRow.displayName },
        workspace: { id: ws.id, slug: ws.slug },
      }
    }
  }
  return null
}
```

- [ ] **Step 5: Implement the controller and router**

`backend/src/agent/controllers/authController.ts`:

```ts
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { devLogin as devLoginService, listDevAgents } from '../services/authService.ts'

// Kept local rather than in @support/types: this endpoint is a throwaway
// dev-picker stand-in for Google OAuth, not a contract any other audience shares.
const DevLoginBody = z.object({ agent_id: z.uuid() })

export const devAgents: RequestHandler = async (_req, res) => {
  const agents = await listDevAgents()
  res.status(200).json({ agents })
}

export const devLogin: RequestHandler = async (req, res) => {
  const body = DevLoginBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'agent_id must be a uuid.')
    return
  }
  const result = await devLoginService(body.data.agent_id)
  if (!result) {
    sendError(res, 404, 'not_found', 'Agent not found or has no workspace membership.')
    return
  }
  res.status(200).json(result)
}
```

`backend/src/agent/routers/authRouter.ts`:

```ts
import { Router } from 'express'
import { devAgents, devLogin } from '../controllers/authController.ts'

export const authRouter = Router()
authRouter.get('/auth/dev-agents', devAgents)
authRouter.post('/auth/dev-login', devLogin)
```

- [ ] **Step 6: Mount the auth router and the session gate**

`backend/src/agent/router.ts` — replace its contents:

```ts
import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { authRouter } from './routers/authRouter.ts'

export const agentRouter = Router()

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter)

// Everything mounted after this line requires a valid agent session. Later
// tasks in this plan add their routers below this line, not above it.
agentRouter.use(requireAgentSession)
```

- [ ] **Step 7: Seed two more demo agents**

In `backend/src/shared/db/seed.ts`, extend the `withoutWorkspace` block that creates the admin so
it also creates two ordinary agents (needed so the dev picker has more than one option):

```ts
  const { adminId } = await withoutWorkspace(async (tx) => {
    const [admin] = await tx
      .insert(agent)
      .values({ email: ADMIN_EMAIL, displayName: 'Seed Admin' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Seed Admin' } })
      .returning({ id: agent.id })
    if (!admin) throw new Error('agent upsert returned nothing')

    const [alex] = await tx
      .insert(agent)
      .values({ email: 'alex@example.test', displayName: 'Alex Agent' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Alex Agent' } })
      .returning({ id: agent.id })
    const [sam] = await tx
      .insert(agent)
      .values({ email: 'sam@example.test', displayName: 'Sam Agent' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Sam Agent' } })
      .returning({ id: agent.id })
    if (!alex || !sam) throw new Error('agent upsert returned nothing')

    return { adminId: admin.id, alexId: alex.id, samId: sam.id }
  })
```

And in the `withWorkspace` block below it, add their memberships alongside the admin's:

```ts
  await withWorkspace(workspaceId, async (tx) => {
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: adminId, role: 'admin' })
      .onConflictDoNothing()
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: alexId, role: 'agent' })
      .onConflictDoNothing()
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: samId, role: 'agent' })
      .onConflictDoNothing()
```

(and destructure `alexId`, `samId` out of the earlier `const { adminId, alexId, samId } = await withoutWorkspace(...)`.)

- [ ] **Step 8: Run the test to confirm it passes**

Run: `pnpm --filter @support/api test -- agent.auth`
Expected: PASS (3 tests)

- [ ] **Step 9: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add backend/src/shared/middleware/requireAgentSession.ts backend/src/agent \
        backend/src/shared/db/seed.ts backend/tests/agent.auth.test.ts
git commit -m "feat(agent): dev-picker login, requireAgentSession middleware, seed two more agents"
```

---

## Task 5: Frontend scaffolding — router, query client, socket client, shared chat UI

**Batch:** 1

**Files:**
- Modify: `frontend/package.json` (add `react-router-dom`, `@tanstack/react-query`,
  `react-virtuoso`, `socket.io-client`)
- Create: `frontend/src/routes.tsx`
- Modify: `frontend/src/main.tsx`
- Create: `frontend/src/lib/socket.ts`
- Create: `frontend/src/components/chat/types.ts`
- Create: `frontend/src/components/chat/ChatThread.tsx`
- Create: `frontend/src/components/chat/Composer.tsx`
- Create: `frontend/src/pages/AgentLogin.tsx` (placeholder — filled in by Task 10)
- Create: `frontend/src/pages/AgentInbox.tsx` (placeholder — filled in by Task 10)
- Create: `frontend/src/pages/AgentConversation.tsx` (placeholder — filled in by Task 10)
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Produces: `ChatMessage` type (`{ id, authorType, body, createdAt, deliveryState? }`) from
  `components/chat/types.ts` — **deliberately local, not imported from `@support/types`**, per the
  spec's "serializer-agnostic" requirement for `ChatThread`. `ChatThread({ messages, currentAuthorType, onRetry? }): JSX.Element`
  (`onRetry` fires only for a message with `deliveryState: 'failed'`) and `Composer({ onSend, disabled? }): JSX.Element`.
  `createSocket(token: string, role: 'player' | 'agent'): Socket` from `lib/socket.ts`.
- Consumes: nothing from Batch 1 siblings — fully self-contained.

- [ ] **Step 1: Add the dependencies**

In `frontend/package.json`, add to `dependencies`:

```json
    "@tanstack/react-query": "^5",
    "react-router-dom": "^7",
    "react-virtuoso": "^4",
    "socket.io-client": "^4",
```

Run: `pnpm install`

- [ ] **Step 2: Write the shared chat message type**

`frontend/src/components/chat/types.ts`:

```ts
export type ChatAuthorType = 'player' | 'agent' | 'bot' | 'system'

/**
 * Serializer-agnostic on purpose: this is not @support/types's PlayerMessageView
 * or AgentMessageView. ChatThread renders this shape regardless of which
 * audience's API produced the data — only the caller (SupportSurface vs the
 * agent console pages) knows which serializer's response it mapped from.
 */
export type ChatMessage = {
  id: string
  authorType: ChatAuthorType
  body: string
  createdAt: string
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
}
```

- [ ] **Step 3: Write `ChatThread`**

`frontend/src/components/chat/ChatThread.tsx`:

```tsx
import { Virtuoso } from 'react-virtuoso'
import type { ChatAuthorType, ChatMessage } from './types.ts'

type ChatThreadProps = {
  messages: ChatMessage[]
  currentAuthorType: ChatAuthorType
  /** Only ever called for a message with deliveryState 'failed'. Omit if the caller has no pending/optimistic sends to retry (e.g. the agent console, which never renders a 'sending' or 'failed' message). */
  onRetry?: (message: ChatMessage) => void
}

/**
 * followOutput="auto" sticks to the bottom on a new message but doesn't yank
 * the viewport if the reader has scrolled up to read history.
 */
export function ChatThread({ messages, currentAuthorType, onRetry }: ChatThreadProps) {
  return (
    <Virtuoso
      style={{ height: '100%' }}
      data={messages}
      followOutput="auto"
      itemContent={(_index, chatMessage) => (
        <div
          className={`chat-message chat-message--${chatMessage.authorType}`}
          data-own={chatMessage.authorType === currentAuthorType}
        >
          <p>{chatMessage.body}</p>
          <time dateTime={chatMessage.createdAt}>{new Date(chatMessage.createdAt).toLocaleTimeString()}</time>
          {chatMessage.deliveryState === 'sending' && <span className="chat-message__status">Sending…</span>}
          {chatMessage.deliveryState === 'failed' && (
            <span className="chat-message__status">
              Failed to send.{' '}
              <button type="button" onClick={() => onRetry?.(chatMessage)}>
                Retry
              </button>
            </span>
          )}
        </div>
      )}
    />
  )
}
```

- [ ] **Step 4: Write `Composer`**

`frontend/src/components/chat/Composer.tsx`:

```tsx
import { useState } from 'react'

type ComposerProps = {
  onSend: (body: string) => void
  disabled?: boolean
}

export function Composer({ onSend, disabled }: ComposerProps) {
  const [value, setValue] = useState('')

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return
    onSend(trimmed)
    setValue('')
  }

  return (
    <div className="composer">
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

- [ ] **Step 5: Write the socket client factory**

`frontend/src/lib/socket.ts`:

```ts
import { io, type Socket } from 'socket.io-client'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

export type SocketRole = 'player' | 'agent'

export function createSocket(token: string, role: SocketRole): Socket {
  return io(BASE, { auth: { token, role }, transports: ['websocket'] })
}
```

- [ ] **Step 6: Write the three agent-console page placeholders**

`frontend/src/pages/AgentLogin.tsx`:

```tsx
export function AgentLogin() {
  return <main className="agent-login">Loading…</main>
}
```

`frontend/src/pages/AgentInbox.tsx`:

```tsx
export function AgentInbox() {
  return <main className="agent-inbox">Loading…</main>
}
```

`frontend/src/pages/AgentConversation.tsx`:

```tsx
export function AgentConversation() {
  return <main className="agent-conversation">Loading…</main>
}
```

(Task 10 replaces the body of each of these three files in place — same file paths, no other task
touches them in the meantime.)

- [ ] **Step 7: Write the route table**

`frontend/src/routes.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'
import { SupportSurface } from './pages/SupportSurface.tsx'
import { AgentLogin } from './pages/AgentLogin.tsx'
import { AgentInbox } from './pages/AgentInbox.tsx'
import { AgentConversation } from './pages/AgentConversation.tsx'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SupportSurface />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
    </Routes>
  )
}
```

- [ ] **Step 8: Wire the query client and router into `main.tsx`**

`frontend/src/main.tsx` — replace its contents:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { AppRoutes } from './routes.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

const queryClient = new QueryClient()

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
```

- [ ] **Step 9: Add minimal chat layout CSS**

Append to `frontend/src/styles.css`:

```css
.chat-message { padding: 0.5rem 0.75rem; margin: 0.25rem 0; border-radius: 0.5rem; max-width: 80%; }
.chat-message[data-own='true'] { margin-left: auto; background: #dbeafe; }
.chat-message[data-own='false'] { background: #f3f4f6; }
.chat-message time { display: block; font-size: 0.75rem; opacity: 0.6; }
.chat-message__status { font-size: 0.75rem; opacity: 0.7; }
.composer { display: flex; gap: 0.5rem; padding: 0.5rem; }
.composer textarea { flex: 1; resize: none; min-height: 2.5rem; }
```

- [ ] **Step 10: Run typecheck and build**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`
Expected: PASS (the build succeeds with placeholder agent pages and the existing `SupportSurface`
at `/`)

- [ ] **Step 11: Commit**

```bash
git add frontend/package.json frontend/src/routes.tsx frontend/src/main.tsx frontend/src/lib/socket.ts \
        frontend/src/components/chat frontend/src/pages/AgentLogin.tsx frontend/src/pages/AgentInbox.tsx \
        frontend/src/pages/AgentConversation.tsx frontend/src/styles.css
git commit -m "feat(web): router, query client, socket factory, shared ChatThread/Composer"
```

---

## Batch 1 Checkpoint

Run once, after all four of Tasks 2–5 are committed, before starting Batch 2:

```bash
pnpm typecheck
pnpm test
pnpm --filter @support/web build
```

All three must pass. This is a mechanical command run — not a dispatched review subagent. If
anything fails, fix it in place (small, targeted fixes) and re-run; do not proceed to Batch 2 until
this is clean.

---

## Batch 2 (parallel: Tasks 6, 7, 8, 9, 10)

Each task below imports Batch 1's output (already committed and checkpointed) but no sibling
Batch-2 task's files. Dispatch all five to separate subagents at once.

---

## Task 6: Player messages — send, fetch, mark-read (`/surface/messages*`)

**Batch:** 2

**Files:**
- Create: `backend/src/surface/services/messagesService.ts`
- Create: `backend/src/surface/controllers/messagesController.ts`
- Create: `backend/src/surface/routers/messagesRouter.ts`
- Modify: `backend/src/surface/router.ts`
- Test: `backend/tests/surface.messages.test.ts`

**Interfaces:**
- Produces: `POST /surface/messages { body }` → `{ conversation_id, message: PlayerMessageView }`;
  `GET /surface/messages?session_id=` → `{ conversation_id: string | null; messages: PlayerMessageView[] }`
  (404 if `session_id` isn't the player's own session); `POST /surface/messages/read { up_to_seq }` → `{ ok: true }`.
- Consumes: Task 2's `postMessage`, `toPlayerView`, `toAgentView` (`@support/types` /
  `backend/src/domain/conversations/index.ts`); Task 3's `emitMessageToRooms`, `emitInboxChanged`,
  `getIo` (`backend/src/shared/realtime/{emit,socketServer}.ts`); existing `BootstrapQuery` (reused
  as-is for the `session_id` query param — same shape, no need for a second schema).

- [ ] **Step 1: Write the failing test**

`backend/tests/surface.messages.test.ts`:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { app, mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setup() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const sessionId = await seedSession({ workspaceId, playerId })
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p1' })
  return { workspaceId, playerId, sessionId, token }
}

describe('POST /surface/messages', () => {
  it('creates the conversation on the first message', async () => {
    const { token } = await setup()
    const res = await request(app)
      .post('/surface/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ body: 'hello' })
      .expect(200)
    expect(res.body.conversation_id).toBeDefined()
    expect(res.body.message).toMatchObject({ author_type: 'player', body: 'hello', seq: 1 })
  })

  it('rejects an empty body with 422', async () => {
    const { token } = await setup()
    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: '' }).expect(422)
  })

  it('reopens a resolved conversation and appends conversation_reopened', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(`update conversation set status = 'resolved', assigned_agent_id = null where id = $1`, [
      conversationId,
    ])
    const agentRow = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a1@example.test', 'A1') returning id`,
    )
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentRow.rows[0]!.id,
    ])

    await request(app).post('/surface/messages').set('Authorization', `Bearer ${token}`).send({ body: 'still here' }).expect(200)

    const { rows } = await ownerPool.query<{ status: string; assigned_agent_id: string | null }>(
      `select status, assigned_agent_id from conversation where id = $1`,
      [conversationId],
    )
    expect(rows[0]!.status).toBe('open')
    expect(rows[0]!.assigned_agent_id).toBeNull()

    const { rows: events } = await ownerPool.query<{ type: string }>(
      `select type from event where conversation_id = $1 and type = 'conversation_reopened'`,
      [conversationId],
    )
    expect(events).toHaveLength(1)
  })
})

describe('GET /surface/messages', () => {
  it('returns conversation_id: null and an empty list when no conversation exists yet', async () => {
    const { token, sessionId } = await setup()
    const res = await request(app)
      .get('/surface/messages')
      .query({ session_id: sessionId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ conversation_id: null, messages: [] })
  })

  it('404s for a session_id that is not the caller\'s own', async () => {
    const { token } = await setup()
    await request(app)
      .get('/surface/messages')
      .query({ session_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })
})

describe('POST /surface/messages/read', () => {
  it('marks agent-authored messages up to seq as read', async () => {
    const { workspaceId, playerId, token } = await setup()
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'agent', 'hi')`,
      [workspaceId, conversationId],
    )
    await request(app).post('/surface/messages/read').set('Authorization', `Bearer ${token}`).send({ up_to_seq: 1 }).expect(200)

    const { rows } = await ownerPool.query<{ delivery_state: string }>(
      `select delivery_state from message where conversation_id = $1 and seq = 1`,
      [conversationId],
    )
    expect(rows[0]!.delivery_state).toBe('read')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- surface.messages`
Expected: FAIL — 404 on unmounted routes

- [ ] **Step 3: Implement the service**

`backend/src/surface/services/messagesService.ts`:

```ts
import { and, desc, eq, lte, ne } from 'drizzle-orm'
import type { MarkPlayerReadBody as MarkPlayerReadBodyType, PlayerMessageView, SendMessageBody as SendMessageBodyType } from '@support/types'
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { appendEvent } from '../../shared/events/appendEvent.ts'
import { conversation, message, session } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitInboxChanged, emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

const REOPENABLE_STATUSES = new Set(['resolved', 'closed'])

export async function sendPlayerMessage(
  ctx: PlayerContext,
  body: SendMessageBodyType,
): Promise<{ conversation_id: string; message: PlayerMessageView | null }> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx
      .select({ id: conversation.id, status: conversation.status })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)

    let conversationId: string
    // Set whenever the inbox needs to refetch: a brand-new conversation just
    // appeared in Unassigned, or a reopen just moved one back into it. Claiming
    // (Task 7) is the third trigger for the same event, from a different path.
    let inboxStatus: string | null = null

    if (!existing) {
      // Best-effort: attaches the player's most recent session so a future
      // agent Game View can reach the player-state snapshot. Never rewritten
      // on reopen — see docs/specs/2026-08-06-chat-module-design.md.
      const [latestSession] = await tx
        .select({ id: session.id })
        .from(session)
        .where(eq(session.playerId, ctx.playerId))
        .orderBy(desc(session.startedAt))
        .limit(1)

      const [created] = await tx
        .insert(conversation)
        .values({ workspaceId: ctx.workspaceId, playerId: ctx.playerId, sessionId: latestSession?.id ?? null, status: 'open' })
        .returning({ id: conversation.id })
      if (!created) throw new Error('conversation insert returned nothing')
      conversationId = created.id
      inboxStatus = 'open'
    } else {
      conversationId = existing.id
      if (REOPENABLE_STATUSES.has(existing.status)) {
        await tx.update(conversation).set({ status: 'open', assignedAgentId: null }).where(eq(conversation.id, conversationId))
        await appendEvent(tx, {
          workspaceId: ctx.workspaceId,
          type: 'conversation_reopened',
          conversationId,
          actorId: ctx.playerId,
          actorType: 'player',
        })
        inboxStatus = 'open'
      }
    }

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'player',
      actorId: ctx.playerId,
      body: body.body,
    })

    return { conversationId, posted, inboxStatus }
  })

  const playerView = toPlayerView(result.posted)
  const agentView = toAgentView(result.posted)
  emitMessageToRooms(getIo(), result.conversationId, playerView, agentView)
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, result.conversationId, result.inboxStatus)
  }

  return { conversation_id: result.conversationId, message: playerView }
}

export async function getPlayerMessages(
  ctx: PlayerContext,
  query: { session_id: string },
): Promise<{ conversation_id: string | null; messages: PlayerMessageView[] } | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [ownedSession] = await tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.id, query.session_id), eq(session.playerId, ctx.playerId)))
      .limit(1)
    if (!ownedSession) return null

    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.playerId, ctx.playerId))
      .orderBy(desc(conversation.createdAt))
      .limit(1)
    if (!found) return { conversation_id: null, messages: [] }

    const rows = await tx.select().from(message).where(eq(message.conversationId, found.id)).orderBy(message.seq)
    const messages = rows.map(toPlayerView).filter((m): m is PlayerMessageView => m !== null)
    return { conversation_id: found.id, messages }
  })
}

export async function markPlayerMessagesRead(ctx: PlayerContext, body: MarkPlayerReadBodyType): Promise<boolean> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.playerId, ctx.playerId)).limit(1)
    if (!found) return false

    await tx
      .update(message)
      .set({ deliveryState: 'read' })
      .where(
        and(
          eq(message.conversationId, found.id),
          ne(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
    return true
  })
}
```

- [ ] **Step 4: Implement the controller**

`backend/src/surface/controllers/messagesController.ts`:

```ts
import type { RequestHandler } from 'express'
import { BootstrapQuery, MarkPlayerReadBody, SendMessageBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { getPlayerMessages, markPlayerMessagesRead, sendPlayerMessage } from '../services/messagesService.ts'

export const postMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const body = SendMessageBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'body must be a non-empty string.')
    return
  }
  const result = await sendPlayerMessage(ctx, body.data)
  res.status(200).json(result)
}

export const getMessagesHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const query = BootstrapQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'session_id must be a uuid.')
    return
  }
  const result = await getPlayerMessages(ctx, query.data)
  if (!result) {
    sendError(res, 404, 'not_found', 'Session not found.')
    return
  }
  res.status(200).json(result)
}

export const markReadHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!
  const body = MarkPlayerReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'up_to_seq must be a non-negative integer.')
    return
  }
  await markPlayerMessagesRead(ctx, body.data)
  res.status(200).json({ ok: true })
}
```

- [ ] **Step 5: Implement the router and mount it**

`backend/src/surface/routers/messagesRouter.ts`:

```ts
import { Router } from 'express'
import { getMessagesHandler, markReadHandler, postMessageHandler } from '../controllers/messagesController.ts'

export const messagesRouter = Router()
messagesRouter.post('/messages', postMessageHandler)
messagesRouter.get('/messages', getMessagesHandler)
messagesRouter.post('/messages/read', markReadHandler)
```

In `backend/src/surface/router.ts`, add the import and mount line:

```ts
import { messagesRouter } from './routers/messagesRouter.ts'
```

```ts
surfaceRouter.use(bootstrapRouter)
surfaceRouter.use(articleReadRouter)
surfaceRouter.use(messagesRouter)
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `pnpm --filter @support/api test -- surface.messages`
Expected: PASS (6 tests)

- [ ] **Step 7: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add backend/src/surface backend/tests/surface.messages.test.ts
git commit -m "feat(surface): POST/GET /surface/messages, POST /surface/messages/read"
```

---

## Task 7: Agent inbox + claim (`/agent/conversations*`)

**Batch:** 2

**Files:**
- Create: `backend/src/agent/services/conversationsService.ts`
- Create: `backend/src/agent/controllers/conversationsController.ts`
- Create: `backend/src/agent/routers/conversationsRouter.ts`
- Test: `backend/tests/agent.conversations.test.ts`

*(Does **not** touch `backend/src/agent/router.ts` — mounting `conversationsRouter` there happens
in the Batch 2 Checkpoint, after Task 8 has also landed, to avoid two parallel tasks editing the
same file. The test below builds its own tiny standalone Express app for just this router, so this
task's test run needs no mount at all — see Step 1.)*

**Interfaces:**
- Produces: `GET /agent/conversations?status=unassigned|mine` → `{ conversations: AgentConversationSummary[] }`;
  `POST /agent/conversations/:id/claim` → `{ claimed: boolean }`; `GET /agent/conversations/:id/messages` → `{ messages: AgentMessageView[] }` (404 if the conversation doesn't exist in the agent's workspace).
- Consumes: Task 2's `toAgentView`; Task 3's `emitInboxChanged`, `getIo`; Task 4's
  `AgentContext` (`backend/src/shared/middleware/requireAgentSession.ts`).

- [ ] **Step 1: Write the failing test**

`backend/tests/agent.conversations.test.ts`:

```ts
import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { errorMiddleware } from '../src/errors.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'

// A standalone app carrying just this router, gated by the real
// requireAgentSession middleware — not the shared app.ts, and it never
// touches agent/router.ts. conversationsRouter isn't mounted there until the
// Batch 2 Checkpoint, so this is the only way to exercise it before then, and
// it keeps this task's test run from racing Task 8's over the same file.
const app = express()
app.use(express.json())
app.use(requireAgentSession, conversationsRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('GET /agent/conversations', () => {
  it('lists unassigned conversations with a last-message preview', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'help please' })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.conversations).toHaveLength(1)
    expect(res.body.conversations[0].last_message_preview).toBe('help please')
  })
})

describe('POST /agent/conversations/:id/claim', () => {
  it('claims an unassigned conversation', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body).toEqual({ claimed: true })
  })

  it('a claim race: exactly one of two concurrent claims succeeds', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const agentA = await setupAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      rows[0]!.id,
    ])
    const tokenB = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceId })

    const [resA, resB] = await Promise.all([
      request(app).post(`/conversations/${conversationId}/claim`).set('Authorization', `Bearer ${agentA.token}`),
      request(app).post(`/conversations/${conversationId}/claim`).set('Authorization', `Bearer ${tokenB}`),
    ])

    const claimedFlags = [resA.body.claimed, resB.body.claimed].sort()
    expect(claimedFlags).toEqual([false, true])
  })
})

describe('GET /agent/conversations/:id/messages', () => {
  it('returns the full history via toAgentView', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player', body: 'hi' })
    const { token } = await setupAgent(workspaceId)

    const res = await request(app)
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.messages).toHaveLength(1)
    expect(res.body.messages[0]).toMatchObject({ author_type: 'player', body: 'hi' })
  })

  it('404s for a conversation outside the agent\'s workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const playerB = await seedPlayer(workspaceB)
    const conversationB = await seedConversation({ workspaceId: workspaceB, playerId: playerB })
    const { token } = await setupAgent(workspaceA)

    await request(app)
      .get(`/conversations/${conversationB}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- agent.conversations`
Expected: FAIL — `conversationsRouter.ts` not found

- [ ] **Step 3: Implement the service**

`backend/src/agent/services/conversationsService.ts`:

```ts
import { desc, eq, isNull } from 'drizzle-orm'
import type { AgentConversationSummary, AgentMessageView } from '@support/types'
import { toAgentView } from '../../domain/conversations/index.ts'
import { conversation, message, player } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export type ConversationsFilter = 'unassigned' | 'mine'

export async function listConversations(ctx: AgentContext, filter: ConversationsFilter): Promise<AgentConversationSummary[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({ id: conversation.id, status: conversation.status, externalPlayerId: player.externalId })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .where(filter === 'unassigned' ? isNull(conversation.assignedAgentId) : eq(conversation.assignedAgentId, ctx.agentId))
      .orderBy(desc(conversation.createdAt))

    // One extra query per row for the last-message preview. Fine at this
    // slice's inbox size; a lateral join is the fix if the inbox ever grows
    // large enough for this to matter.
    const summaries: AgentConversationSummary[] = []
    for (const row of rows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1)

      summaries.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
      })
    }
    return summaries
  })
}

export type ClaimResult = { claimed: boolean; status: string | null }

export async function claimConversation(ctx: AgentContext, conversationId: string): Promise<ClaimResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(eq(conversation.id, conversationId))
      .where(isNull(conversation.assignedAgentId))
      .returning({ id: conversation.id, status: conversation.status })
    const [row] = claimed
    return row ? { claimed: true, status: row.status } : { claimed: false, status: null }
  })
}

export async function getAgentConversationMessages(ctx: AgentContext, conversationId: string): Promise<AgentMessageView[] | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, conversationId)).limit(1)
    if (!found) return null

    const rows = await tx.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(message.seq)
    return rows.map(toAgentView)
  })
}
```

Note: Drizzle's `.where()` cannot be chained twice — fix the claim query to combine both
conditions with `and`:

```ts
import { and, desc, eq, isNull } from 'drizzle-orm'
```

```ts
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(and(eq(conversation.id, conversationId), isNull(conversation.assignedAgentId)))
      .returning({ id: conversation.id, status: conversation.status })
```

- [ ] **Step 4: Implement the controller**

`backend/src/agent/controllers/conversationsController.ts`:

```ts
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import { emitInboxChanged } from '../../shared/realtime/emit.ts'
import { claimConversation, getAgentConversationMessages, listConversations } from '../services/conversationsService.ts'

const ConversationsQuery = z.object({ status: z.enum(['unassigned', 'mine']) })
const ConversationIdParams = z.object({ id: z.uuid() })

export const listConversationsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const query = ConversationsQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'status must be "unassigned" or "mine".')
    return
  }
  const conversations = await listConversations(ctx, query.data.status)
  res.status(200).json({ conversations })
}

export const claimConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await claimConversation(ctx, params.data.id)
  if (result.claimed && result.status) {
    emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status)
  }
  res.status(200).json({ claimed: result.claimed })
}

export const getConversationMessagesHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const params = ConversationIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const messages = await getAgentConversationMessages(ctx, params.data.id)
  if (!messages) {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  res.status(200).json({ messages })
}
```

- [ ] **Step 5: Implement the router**

`backend/src/agent/routers/conversationsRouter.ts`:

```ts
import { Router } from 'express'
import {
  claimConversationHandler,
  getConversationMessagesHandler,
  listConversationsHandler,
} from '../controllers/conversationsController.ts'

export const conversationsRouter = Router()
conversationsRouter.get('/conversations', listConversationsHandler)
conversationsRouter.post('/conversations/:id/claim', claimConversationHandler)
conversationsRouter.get('/conversations/:id/messages', getConversationMessagesHandler)
```

(Not mounted into `agent/router.ts` yet — see the Batch 2 Checkpoint. The test above doesn't need
that mount; it builds its own standalone app around `conversationsRouter` directly.)

- [ ] **Step 6: Run the test to confirm it passes**

Run: `pnpm --filter @support/api test -- agent.conversations`
Expected: PASS (5 tests)

- [ ] **Step 7: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS (an unmounted router still typechecks — nothing needs to import it yet for it to be
free of compile errors)

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts \
        backend/src/agent/routers/conversationsRouter.ts backend/tests/agent.conversations.test.ts
git commit -m "feat(agent): inbox list, claim, conversation messages (not yet mounted)"
```

---

## Task 8: Agent messages — send, mark-read (`/agent/messages*`)

**Batch:** 2

**Files:**
- Modify: `backend/src/errors.ts` (add `'forbidden'` to `ErrorCode`)
- Create: `backend/src/agent/services/messagesService.ts`
- Create: `backend/src/agent/controllers/messagesController.ts`
- Create: `backend/src/agent/routers/messagesRouter.ts`
- Test: `backend/tests/agent.messages.test.ts`

*(Does **not** touch `backend/src/agent/router.ts` — same reasoning as Task 7: the test below
builds its own standalone Express app around `messagesRouter` directly.)*

**Interfaces:**
- Produces: `POST /agent/messages { conversation_id, body }` → `{ message: AgentMessageView }` (404
  if the conversation doesn't exist in the agent's workspace; 403 if it exists but isn't assigned
  to this agent); `POST /agent/messages/read { conversation_id, up_to_seq }` → `{ ok: true }`.
- Consumes: Task 2's `postMessage`, `toAgentView`, `toPlayerView`; Task 3's `emitMessageToRooms`,
  `getIo`; Task 4's `AgentContext`.

- [ ] **Step 1: Add the `forbidden` error code**

In `backend/src/errors.ts`:

```ts
export type ErrorCode =
  | 'unauthorized'
  | 'workspace_mismatch'
  | 'forbidden'
  | 'not_found'
  | 'unparseable_body'
  | 'invalid_request'
  | 'internal'
```

- [ ] **Step 2: Write the failing test**

`backend/tests/agent.messages.test.ts`:

```ts
import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { errorMiddleware } from '../src/errors.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts'
import { closeOwnerPool, ownerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

// Standalone app around just this router — see Task 7's test for why. Keeps
// this task's test run from racing Task 7's over agent/router.ts.
const app = express()
app.use(express.json())
app.use(requireAgentSession, messagesRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function setupAssignedAgent(workspaceId: string, conversationId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [conversationId, agentId])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('POST /agent/messages', () => {
  it('sends a message when the caller is the assigned agent', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'how can I help?' })
      .expect(200)
    expect(res.body.message).toMatchObject({ author_type: 'agent', body: 'how can I help?', seq: 1 })
  })

  it('403s when the conversation is not assigned to the caller', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      rows[0]!.id,
    ])
    const token = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceId })

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, body: 'hi' })
      .expect(403)
  })

  it('404s for a conversation outside the agent\'s workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const playerB = await seedPlayer(workspaceB)
    const conversationB = await seedConversation({ workspaceId: workspaceB, playerId: playerB })
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agentA@example.test', 'Agent A') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceA,
      rows[0]!.id,
    ])
    const token = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: workspaceA })

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationB, body: 'hi' })
      .expect(404)
  })
})

describe('POST /agent/messages/read', () => {
  it('marks player-authored messages up to seq as read', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body) values ($1, $2, 1, 'player', 'help')`,
      [workspaceId, conversationId],
    )
    const { token } = await setupAssignedAgent(workspaceId, conversationId)

    await request(app)
      .post('/messages/read')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversation_id: conversationId, up_to_seq: 1 })
      .expect(200)

    const { rows } = await ownerPool.query<{ delivery_state: string }>(
      `select delivery_state from message where conversation_id = $1 and seq = 1`,
      [conversationId],
    )
    expect(rows[0]!.delivery_state).toBe('read')
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @support/api test -- agent.messages`
Expected: FAIL — `messagesRouter.ts` not found

- [ ] **Step 4: Implement the service**

`backend/src/agent/services/messagesService.ts`:

```ts
import { and, eq, lte, ne } from 'drizzle-orm'
import type {
  AgentMessageView,
  MarkAgentReadBody as MarkAgentReadBodyType,
  SendAgentMessageBody as SendAgentMessageBodyType,
} from '@support/types'
import { postMessage, toAgentView, toPlayerView } from '../../domain/conversations/index.ts'
import { conversation, message } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import { emitMessageToRooms } from '../../shared/realtime/emit.ts'
import { getIo } from '../../shared/realtime/socketServer.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export type SendAgentMessageResult =
  | { outcome: 'ok'; message: AgentMessageView }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }

export async function sendAgentMessage(ctx: AgentContext, body: SendAgentMessageBodyType): Promise<SendAgentMessageResult> {
  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id, assignedAgentId: conversation.assignedAgentId })
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
    })
    return { outcome: 'ok', posted } as const
  })

  if (result.outcome !== 'ok') return result

  const agentView = toAgentView(result.posted)
  const playerView = toPlayerView(result.posted)
  emitMessageToRooms(getIo(), body.conversation_id, playerView, agentView)
  return { outcome: 'ok', message: agentView }
}

export async function markAgentMessagesRead(ctx: AgentContext, body: MarkAgentReadBodyType): Promise<boolean> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(eq(conversation.id, body.conversation_id)).limit(1)
    if (!found) return false

    await tx
      .update(message)
      .set({ deliveryState: 'read' })
      .where(
        and(
          eq(message.conversationId, found.id),
          eq(message.authorType, 'player'),
          ne(message.deliveryState, 'read'),
          lte(message.seq, body.up_to_seq),
        ),
      )
    return true
  })
}
```

- [ ] **Step 5: Implement the controller**

`backend/src/agent/controllers/messagesController.ts`:

```ts
import type { RequestHandler } from 'express'
import { MarkAgentReadBody, SendAgentMessageBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { markAgentMessagesRead, sendAgentMessage } from '../services/messagesService.ts'

export const postAgentMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const body = SendAgentMessageBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'conversation_id must be a uuid and body must be non-empty.')
    return
  }
  const result = await sendAgentMessage(ctx, body.data)
  if (result.outcome === 'not_found') {
    sendError(res, 404, 'not_found', 'Conversation not found.')
    return
  }
  if (result.outcome === 'forbidden') {
    sendError(res, 403, 'forbidden', 'This conversation is not assigned to you.')
    return
  }
  res.status(200).json({ message: result.message })
}

export const markAgentReadHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!
  const body = MarkAgentReadBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'conversation_id must be a uuid and up_to_seq must be a non-negative integer.')
    return
  }
  await markAgentMessagesRead(ctx, body.data)
  res.status(200).json({ ok: true })
}
```

- [ ] **Step 6: Implement the router**

`backend/src/agent/routers/messagesRouter.ts`:

```ts
import { Router } from 'express'
import { markAgentReadHandler, postAgentMessageHandler } from '../controllers/messagesController.ts'

export const messagesRouter = Router()
messagesRouter.post('/messages', postAgentMessageHandler)
messagesRouter.post('/messages/read', markAgentReadHandler)
```

(Not mounted into `agent/router.ts` yet — see the Batch 2 Checkpoint. The test above doesn't need
that mount.)

- [ ] **Step 7: Run the test to confirm it passes**

Run: `pnpm --filter @support/api test -- agent.messages`
Expected: PASS (4 tests)

- [ ] **Step 8: Run typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add backend/src/errors.ts backend/src/agent/services/messagesService.ts \
        backend/src/agent/controllers/messagesController.ts backend/src/agent/routers/messagesRouter.ts \
        backend/tests/agent.messages.test.ts
git commit -m "feat(agent): send/mark-read agent messages, 403 on unassigned reply (not yet mounted)"
```

---

## Task 9: Player chat panel (`SupportSurface.tsx`)

**Batch:** 2

**Files:**
- Create: `frontend/src/api/httpClient.ts`
- Modify: `frontend/src/api/surfaceApi.ts` (extract shared `apiCall` into `httpClient.ts`)
- Create: `frontend/src/api/playerChatApi.ts`
- Create: `frontend/src/pages/chatReconcile.ts`
- Test: `frontend/src/pages/chatReconcile.test.ts`
- Modify: `frontend/src/pages/SupportSurface.tsx`

**Interfaces:**
- Produces: `reconcilePending(serverMessages: ChatMessage[], pending: PendingMessage[]): ChatMessage[]`
  from `chatReconcile.ts` (pure function, unit-tested — the one piece of this task's UI logic that
  doesn't need a rendering harness to verify).
- Consumes: Task 2's `PlayerMessagesResponse`, `PlayerMessageView` (`@support/types`); Task 5's
  `ChatThread`, `Composer`, `ChatMessage` (`components/chat/*`), `createSocket` (`lib/socket.ts`);
  Task 6's `POST/GET /surface/messages*` (called over `fetch`, not imported — no TS coupling to
  the backend).

- [ ] **Step 1: Extract the shared HTTP client**

`frontend/src/api/httpClient.ts`:

```ts
const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

export async function apiCall<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    throw new Error(body?.error?.message ?? `Request failed with ${res.status}`)
  }
  return (await res.json()) as T
}
```

`frontend/src/api/surfaceApi.ts` — replace its contents to use it:

```ts
import type { BootstrapResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

export function fetchBootstrap(token: string, sessionId: string): Promise<BootstrapResponse> {
  return apiCall<BootstrapResponse>(`/surface/bootstrap?session_id=${encodeURIComponent(sessionId)}`, token)
}

export function reportArticleRead(token: string, sessionId: string, articleId: string): Promise<{ ok: true }> {
  return apiCall<{ ok: true }>('/surface/events/article_read', token, {
    method: 'POST',
    body: JSON.stringify({ session_id: sessionId, article_id: articleId }),
  })
}
```

- [ ] **Step 2: Write `playerChatApi.ts`**

`frontend/src/api/playerChatApi.ts`:

```ts
import type { PlayerMessageView, PlayerMessagesResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

export function fetchPlayerMessages(token: string, sessionId: string): Promise<PlayerMessagesResponse> {
  return apiCall<PlayerMessagesResponse>(`/surface/messages?session_id=${encodeURIComponent(sessionId)}`, token)
}

export function sendPlayerMessage(
  token: string,
  body: string,
): Promise<{ conversation_id: string; message: PlayerMessageView }> {
  return apiCall(`/surface/messages`, token, { method: 'POST', body: JSON.stringify({ body }) })
}

export function markPlayerMessagesRead(token: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/surface/messages/read`, token, { method: 'POST', body: JSON.stringify({ up_to_seq: upToSeq }) })
}
```

- [ ] **Step 3: Write the failing reconciliation test**

`frontend/src/pages/chatReconcile.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { reconcilePending } from './chatReconcile.ts'
import type { ChatMessage } from '../components/chat/types.ts'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'server-1', authorType: 'player', body: 'hi', createdAt: '2026-08-06T00:00:00Z', ...overrides }
}

describe('reconcilePending', () => {
  it('keeps a pending message when no server message matches it yet', () => {
    const pending = [{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }]
    expect(reconcilePending([], pending)).toEqual([{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }])
  })

  it('drops a pending message once a matching server message arrives', () => {
    const pending = [{ ...msg({ id: 'temp-1' }), tempId: 'temp-1' }]
    const result = reconcilePending([msg()], pending)
    expect(result).toEqual([msg()])
  })

  it('does not drop a pending message with a different body', () => {
    const pending = [{ ...msg({ id: 'temp-1', body: 'different' }), tempId: 'temp-1' }]
    const result = reconcilePending([msg()], pending)
    expect(result).toEqual([msg(), { ...msg({ id: 'temp-1', body: 'different' }), tempId: 'temp-1' }])
  })
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm --filter @support/web test -- chatReconcile`
Expected: FAIL — `chatReconcile.ts` not found

- [ ] **Step 5: Implement `chatReconcile.ts`**

`frontend/src/pages/chatReconcile.ts`:

```ts
import type { ChatMessage } from '../components/chat/types.ts'

export type PendingMessage = ChatMessage & { tempId: string }

/**
 * A pending (optimistic) message disappears once the server's own list
 * contains a message with the same author and body appended after it — an
 * id-based match isn't available until the send response lands, and matching
 * on body/author is the same fallback StrictMode-safe code elsewhere in this
 * codebase reaches for when there is no id yet to compare.
 */
export function reconcilePending(serverMessages: ChatMessage[], pending: PendingMessage[]): ChatMessage[] {
  const stillPending = pending.filter(
    (p) => !serverMessages.some((m) => m.authorType === p.authorType && m.body === p.body),
  )
  return [...serverMessages, ...stillPending]
}
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `pnpm --filter @support/web test -- chatReconcile`
Expected: PASS (3 tests)

- [ ] **Step 7: Add the chat panel to `SupportSurface.tsx`**

Add these imports to the top of `frontend/src/pages/SupportSurface.tsx`, alongside the existing ones:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchPlayerMessages, markPlayerMessagesRead, sendPlayerMessage } from '../api/playerChatApi.ts'
import { ChatThread } from '../components/chat/ChatThread.tsx'
import { Composer } from '../components/chat/Composer.tsx'
import type { ChatMessage } from '../components/chat/types.ts'
import { createSocket } from '../lib/socket.ts'
import { reconcilePending, type PendingMessage } from './chatReconcile.ts'
```

Add this helper above the `SupportSurface` function:

```tsx
function toChatMessage(m: { id: string; author_type: ChatMessage['authorType']; body: string; created_at: string; delivery_state: NonNullable<ChatMessage['deliveryState']> }): ChatMessage {
  return { id: m.id, authorType: m.author_type, body: m.body, createdAt: m.created_at, deliveryState: m.delivery_state }
}
```

Inside the `SupportSurface` component, add chat-panel state and wiring right after the existing
`onRead` handler:

```tsx
  const [chatOpen, setChatOpen] = useState(false)
  const [pending, setPending] = useState<PendingMessage[]>([])
  const queryClient = useQueryClient()

  const messagesQuery = useQuery({
    queryKey: ['playerMessages', boot?.sessionId],
    queryFn: () => fetchPlayerMessages(boot!.token, boot!.sessionId),
    enabled: chatOpen && boot !== null,
  })

  const send = useMutation({
    mutationFn: (body: string) => sendPlayerMessage(boot!.token, body),
    onMutate: (body: string) => {
      const tempId = `temp-${Date.now()}-${Math.random()}`
      setPending((current) => [
        ...current,
        { tempId, id: tempId, authorType: 'player', body, createdAt: new Date().toISOString(), deliveryState: 'sending' },
      ])
      return { tempId }
    },
    onSuccess: () => {
      // Deliberately does not clear `pending` here: chatReconcile.ts's
      // reconcilePending drops a pending entry only once the refetched server
      // list actually contains a matching message, so the optimistic bubble
      // never disappears and reappears in the gap before that refetch lands.
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot?.sessionId] })
    },
    onError: (_error, _body, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      )
    },
  })

  const onRetry = (failed: ChatMessage) => {
    setPending((current) => current.filter((p) => p.id !== failed.id))
    send.mutate(failed.body)
  }

  useEffect(() => {
    if (!chatOpen || !boot) return
    const socket = createSocket(boot.token, 'player')
    socket.on('connect', () => {
      const conversationId = messagesQuery.data?.conversation_id
      if (conversationId) socket.emit('join_conversation', { conversation_id: conversationId })
    })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['playerMessages', boot.sessionId] })
    })
    return () => {
      socket.close()
    }
  }, [chatOpen, boot, messagesQuery.data?.conversation_id, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!chatOpen || !boot || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markPlayerMessagesRead(boot.token, lastSeq)
  }, [chatOpen, boot, messagesQuery.data])

  const serverMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []
  const chatMessages = reconcilePending(serverMessages, pending)
```

Replace the final "Still need help? / Talk to a person" section with:

```tsx
      <section>
        <button type="button" onClick={() => setChatOpen(true)}>
          Still need help?
        </button>
        <button type="button" onClick={() => setChatOpen(true)}>
          Talk to a person
        </button>
        <button type="button" onClick={() => post({ type: 'close' })}>
          Close
        </button>
      </section>

      {chatOpen && (
        <section className="chat-panel">
          <div className="chat-panel__thread">
            <ChatThread messages={chatMessages} currentAuthorType="player" onRetry={onRetry} />
          </div>
          <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
        </section>
      )}
```

- [ ] **Step 8: Add minimal layout CSS for the chat panel**

Append to `frontend/src/styles.css`:

```css
.chat-panel { display: flex; flex-direction: column; height: 60vh; border-top: 1px solid #e5e7eb; }
.chat-panel__thread { flex: 1; overflow: hidden; }
```

- [ ] **Step 9: Run typecheck and build**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add frontend/src/api/httpClient.ts frontend/src/api/surfaceApi.ts frontend/src/api/playerChatApi.ts \
        frontend/src/pages/chatReconcile.ts frontend/src/pages/chatReconcile.test.ts \
        frontend/src/pages/SupportSurface.tsx frontend/src/styles.css
git commit -m "feat(web): player chat panel on SupportSurface — send/fetch/read, socket push"
```

---

## Task 10: Agent console (`AgentLogin`, `AgentInbox`, `AgentConversation`)

**Batch:** 2

**Files:**
- Create: `frontend/src/lib/agentSession.ts`
- Create: `frontend/src/api/agentApi.ts`
- Modify: `frontend/src/pages/AgentLogin.tsx` (replace placeholder)
- Modify: `frontend/src/pages/AgentInbox.tsx` (replace placeholder)
- Modify: `frontend/src/pages/AgentConversation.tsx` (replace placeholder)

**Interfaces:**
- Produces: `loadAgentSession()`, `saveAgentSession(session)`, `clearAgentSession()` from
  `lib/agentSession.ts` — a `localStorage`-backed stand-in for a real cookie/session, matching this
  slice's dev-picker scope.
- Consumes: Task 2's `AgentConversationsResponse`, `AgentMessagesResponse`, `ClaimResponse`
  (`@support/types`); Task 4's `POST /agent/auth/dev-login`, `GET /agent/auth/dev-agents`; Task 5's
  `ChatThread`, `Composer`, `createSocket`; Task 7/8's agent endpoints (called over `fetch`).

- [ ] **Step 1: Write the local agent-session store**

`frontend/src/lib/agentSession.ts`:

```ts
const STORAGE_KEY = 'support_agent_session'

export type StoredAgentSession = {
  token: string
  agentId: string
  displayName: string
  workspaceSlug: string
}

export function loadAgentSession(): StoredAgentSession | null {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as StoredAgentSession
  } catch {
    return null
  }
}

export function saveAgentSession(session: StoredAgentSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

export function clearAgentSession(): void {
  localStorage.removeItem(STORAGE_KEY)
}
```

- [ ] **Step 2: Write the agent API client**

`frontend/src/api/agentApi.ts`:

```ts
import type { AgentConversationsResponse, AgentMessagesResponse, ClaimResponse } from '@support/types'
import { apiCall } from './httpClient.ts'

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'

export type DevAgentOption = { id: string; email: string; display_name: string }
export type DevLoginResponse = {
  token: string
  agent: { id: string; display_name: string }
  workspace: { id: string; slug: string }
}

export async function fetchDevAgents(): Promise<{ agents: DevAgentOption[] }> {
  const res = await fetch(`${BASE}/agent/auth/dev-agents`)
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as { agents: DevAgentOption[] }
}

export async function devLogin(agentId: string): Promise<DevLoginResponse> {
  const res = await fetch(`${BASE}/agent/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId }),
  })
  if (!res.ok) throw new Error(`Request failed with ${res.status}`)
  return (await res.json()) as DevLoginResponse
}

export function fetchInbox(token: string, status: 'unassigned' | 'mine'): Promise<AgentConversationsResponse> {
  return apiCall(`/agent/conversations?status=${status}`, token)
}

export function claimConversation(token: string, conversationId: string): Promise<ClaimResponse> {
  return apiCall(`/agent/conversations/${conversationId}/claim`, token, { method: 'POST' })
}

export function fetchConversationMessages(token: string, conversationId: string): Promise<AgentMessagesResponse> {
  return apiCall(`/agent/conversations/${conversationId}/messages`, token)
}

export function sendAgentMessage(token: string, conversationId: string, body: string): Promise<{ message: unknown }> {
  return apiCall(`/agent/messages`, token, { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, body }) })
}

export function markAgentMessagesRead(token: string, conversationId: string, upToSeq: number): Promise<{ ok: true }> {
  return apiCall(`/agent/messages/read`, token, {
    method: 'POST',
    body: JSON.stringify({ conversation_id: conversationId, up_to_seq: upToSeq }),
  })
}
```

- [ ] **Step 3: Implement `AgentLogin`**

`frontend/src/pages/AgentLogin.tsx` — replace its contents:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { devLogin, fetchDevAgents } from '../api/agentApi.ts'
import { saveAgentSession } from '../lib/agentSession.ts'

export function AgentLogin() {
  const navigate = useNavigate()
  const agentsQuery = useQuery({ queryKey: ['devAgents'], queryFn: fetchDevAgents })

  const onPick = async (agentId: string) => {
    const result = await devLogin(agentId)
    saveAgentSession({
      token: result.token,
      agentId: result.agent.id,
      displayName: result.agent.display_name,
      workspaceSlug: result.workspace.slug,
    })
    navigate('/inbox')
  }

  return (
    <main className="agent-login">
      <h1>Sign in (dev picker)</h1>
      <p className="notice">Stands in for Google OAuth until that slice ships.</p>
      {agentsQuery.isPending && <p>Loading agents…</p>}
      {agentsQuery.isError && <p className="notice">Could not load agents.</p>}
      <ul>
        {agentsQuery.data?.agents.map((agent) => (
          <li key={agent.id}>
            <button type="button" onClick={() => onPick(agent.id)}>
              {agent.display_name} ({agent.email})
            </button>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

- [ ] **Step 4: Implement `AgentInbox`**

`frontend/src/pages/AgentInbox.tsx` — replace its contents:

```tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { claimConversation, fetchInbox } from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { createSocket } from '../lib/socket.ts'

export function AgentInbox() {
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [claimNotice, setClaimNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  const unassigned = useQuery({
    queryKey: ['inbox', 'unassigned'],
    queryFn: () => fetchInbox(session!.token, 'unassigned'),
    enabled: session !== null,
  })
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(session!.token, 'mine'),
    enabled: session !== null,
  })

  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(session!.token, conversationId),
    onSuccess: (result) => {
      setClaimNotice(result.claimed ? null : 'Already claimed by someone else.')
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
  })

  useEffect(() => {
    if (!session) return
    const socket = createSocket(session.token, 'agent')
    socket.on('conversation:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    })
    return () => {
      socket.close()
    }
  }, [session, queryClient])

  if (!session) return null

  return (
    <main className="agent-inbox">
      <h1>Inbox — {session.displayName}</h1>
      {claimNotice && <p className="notice">{claimNotice}</p>}

      <section>
        <h2>Unassigned</h2>
        <ul>
          {unassigned.data?.conversations.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/conversations/${c.id}`)}>
                {c.player.external_player_id} — {c.last_message_preview ?? '(no messages)'}
              </button>
              <button type="button" onClick={() => claim.mutate(c.id)} disabled={claim.isPending}>
                Claim
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Mine</h2>
        <ul>
          {mine.data?.conversations.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => navigate(`/conversations/${c.id}`)}>
                {c.player.external_player_id} — {c.last_message_preview ?? '(no messages)'}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 5: Implement `AgentConversation`**

`frontend/src/pages/AgentConversation.tsx` — replace its contents:

```tsx
import { useEffect } from 'react'
import type { AgentMessageView } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { createSocket } from '../lib/socket.ts'
import { ChatThread } from '../components/chat/ChatThread.tsx'
import { Composer } from '../components/chat/Composer.tsx'
import type { ChatMessage } from '../components/chat/types.ts'

function toChatMessage(m: AgentMessageView): ChatMessage {
  return { id: m.id, authorType: m.author_type, body: m.body, createdAt: m.created_at, deliveryState: m.delivery_state }
}

export function AgentConversation() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  const messagesQuery = useQuery({
    queryKey: ['conversation', id, 'messages'],
    queryFn: () => fetchConversationMessages(session!.token, id!),
    enabled: session !== null && id !== undefined,
  })

  const send = useMutation({
    mutationFn: (body: string) => sendAgentMessage(session!.token, id!, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    },
  })

  useEffect(() => {
    if (!session || !id) return
    const socket = createSocket(session.token, 'agent')
    socket.emit('join_conversation', { conversation_id: id })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', id, 'messages'] })
    })
    return () => {
      socket.emit('leave_conversation', { conversation_id: id })
      socket.close()
    }
  }, [session, id, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!session || !id || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markAgentMessagesRead(session.token, id, lastSeq)
  }, [session, id, messagesQuery.data])

  if (!session || !id) return null

  const chatMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []

  return (
    <main className="agent-conversation">
      <button type="button" onClick={() => navigate('/inbox')}>
        ← Back to inbox
      </button>
      <div className="agent-conversation__thread">
        <ChatThread messages={chatMessages} currentAuthorType="agent" />
      </div>
      <Composer onSend={(body) => send.mutate(body)} disabled={send.isPending} />
    </main>
  )
}
```

- [ ] **Step 6: Add layout CSS**

Append to `frontend/src/styles.css`:

```css
.agent-conversation { display: flex; flex-direction: column; height: 100vh; }
.agent-conversation__thread { flex: 1; overflow: hidden; }
```

- [ ] **Step 7: Run typecheck and build**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/agentSession.ts frontend/src/api/agentApi.ts frontend/src/pages/AgentLogin.tsx \
        frontend/src/pages/AgentInbox.tsx frontend/src/pages/AgentConversation.tsx frontend/src/styles.css
git commit -m "feat(web): agent console — dev login, inbox with claim, conversation view"
```

---

## Batch 2 Checkpoint

Three things happen here, in order, after all five of Tasks 6–10 are committed:

- [ ] **Step 1: Mount the two deferred agent routers**

In `backend/src/agent/router.ts`, add the imports and both `.use()` lines below the
`requireAgentSession` line:

```ts
import { conversationsRouter } from './routers/conversationsRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'
```

```ts
export const agentRouter = Router()

agentRouter.use(authRouter)

agentRouter.use(requireAgentSession)
agentRouter.use(conversationsRouter)
agentRouter.use(messagesRouter)
```

- [ ] **Step 2: Extend the cross-workspace isolation sweep**

In `backend/tests/isolation.test.ts`, add cases for the four new endpoint groups to the existing
`describe('workspace A cannot reach workspace B')` block. Add this setup near the top of the file
(alongside the existing `B_SESSION` constant):

```ts
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
```

Add these `it` blocks inside the existing `describe`:

```ts
  it('POST /surface/messages never lets A read or write into B\'s conversation', async () => {
    // A's own POST only ever touches A's own (auto-created) conversation — there
    // is no conversation_id in the request body for A to target B's with.
    const before = await rowCounts()
    await withA(request(app).post('/surface/messages')).send({ body: 'hello' }).expect(200)
    const after = await rowCounts()
    expect(after.conversation).toBe(before.conversation + 1)
    expect(after.message).toBe(before.message + 1)
  })

  it('GET /agent/conversations/:id/messages on B\'s conversation is 404 for an A agent', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent@example.test', 'A Agent') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      a.workspaceId,
      rows[0]!.id,
    ])
    const bConversation = await seedConversation({ workspaceId: b.workspaceId, playerId: b.playerId })
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: a.workspaceId })

    await request(app)
      .get(`/agent/conversations/${bConversation}/messages`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(404)
  })

  it('POST /agent/conversations/:id/claim on B\'s conversation is a no-op false claim for an A agent', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent2@example.test', 'A Agent 2') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      a.workspaceId,
      rows[0]!.id,
    ])
    const bConversation = await seedConversation({ workspaceId: b.workspaceId, playerId: b.playerId })
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: a.workspaceId })

    const res = await request(app)
      .post(`/agent/conversations/${bConversation}/claim`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200)
    expect(res.body).toEqual({ claimed: false })

    const { rows: check } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [bConversation],
    )
    expect(check[0]!.assigned_agent_id).toBeNull()
  })

  it('POST /agent/messages targeting B\'s conversation is 404 for an A agent, and writes nothing', async () => {
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a-agent3@example.test', 'A Agent 3') returning id`,
    )
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      a.workspaceId,
      rows[0]!.id,
    ])
    const bConversation = await seedConversation({ workspaceId: b.workspaceId, playerId: b.playerId })
    const agentToken = await signAgentSession({ agent_id: rows[0]!.id, workspace_id: a.workspaceId })

    const before = await rowCounts()
    await request(app)
      .post('/agent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ conversation_id: bConversation, body: 'leak attempt' })
      .expect(404)
    expect((await rowCounts()).message).toBe(before.message)
  })
```

`seedConversation` is already imported in this file (per the existing import list at the top) —
confirm it's still there; add it to the import line if not.

- [ ] **Step 3: Run the full repo validation**

```bash
pnpm typecheck
pnpm test
pnpm --filter @support/web build
```

All three must pass.

- [ ] **Step 4: Commit the checkpoint**

```bash
git add backend/src/agent/router.ts backend/tests/isolation.test.ts
git commit -m "chore(agent): mount conversations/messages routers, extend isolation sweep"
```

---

## Final Validation

After the Batch 2 Checkpoint is committed:

- [ ] **Step 1: Full repo check, once more, clean**

```bash
pnpm typecheck
pnpm test
pnpm --filter @support/web build
```

- [ ] **Step 2: Confirm the frozen SDK seam did not regress**

```bash
SEED_SECRET=<value printed by pnpm db:seed> ./scripts/verify-seam.sh
```

Expected: all steps in the script still pass — nothing in this plan should have touched
`backend/src/sdk/**`, but this is the existing regression guard for that frozen contract and costs
nothing to re-run.

- [ ] **Step 3: Manual smoke test of the actual loop**

```bash
pnpm dev
```

In one browser tab, open the web surface with a valid boot fragment (as `verify-seam.sh` or the
existing dev flow produces one) and click "Talk to a person" — confirm the chat panel opens and a
sent message appears with `Sending…` then settles.

In a second tab, open `http://localhost:5173/login`, pick a seeded agent, go to `/inbox`, confirm
the new conversation appears under **Unassigned**, click **Claim**, open it, confirm the player's
message is visible, and reply — confirm the reply appears in the first tab (live if the socket is
connected, or after a refresh otherwise).

- [ ] **Step 4: Confirm no stray temporary mount lines were left in `agent/router.ts`**

```bash
git diff backend/src/agent/router.ts
```

Expected: empty (the file should only contain the commits from Task 1, Task 4, and the Batch 2
Checkpoint — no leftover `// TEMP` lines from Tasks 7/8).
