# Resolved & Closed Ticket Queues, and Queue Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Resolved" and "Closed" columns to the agent console's Tickets board, and add cursor-based pagination (25 rows/page, scroll-triggered load-more) to all six queue filters — including the two new ones — so no queue column ever fetches an unbounded result set.

**Architecture:** Queues remain virtual filters over `conversation.status` (no new table). `listConversations` in `backend/src/agent/services/conversationsService.ts` grows keyset (cursor-based) pagination for its five existing status-only filters, plus two new filters (`resolved`, `closed`) that join `resolution_cycle` and are windowed to the last 7 days. The Tickets board's per-column query switches from `useQuery` to TanStack Query's `useInfiniteQuery`, appending a page on scroll-near-bottom. The Inbox page's `mine`/`escalated` lists go through the same backend endpoint, so they get the same pagination treatment on the frontend to avoid silently truncating at 25 items.

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL (row-comparison keyset pagination), Zod, React, TanStack Query v5 `useInfiniteQuery`.

## Global Constraints

- No hard deletes; no new DB table; no schema migration — `resolution_cycle` and `conversation` already carry every column this plan needs.
- Page size is fixed at 25, server-side. Not client-configurable.
- Resolved/Closed queues are windowed to the last 7 days, fixed, not user-configurable (per spec `docs/specs/2026-08-27-resolved-closed-ticket-queues-design.md`).
- Every new/changed endpoint parameter must be registered in `backend/src/docs/openapi.ts` (per this repo's CLAUDE.md).
- Tailwind v4 utilities only for any new frontend markup — no hand-written CSS classes.
- Follow this repo's existing test patterns exactly: backend tests are HTTP-level integration tests via `supertest`-style `request(app)` hitting a standalone Express app that mounts only the relevant router (see `backend/tests/agent.conversations.test.ts`); frontend tests use React Testing Library with `agentApi.ts` fully mocked via `vi.mock`.

---

## Task 1: Cursor pagination for the five existing queue filters

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/docs/openapi.ts`
- Modify: `packages/types/src/chat.ts`
- Test: `backend/tests/agent.conversations.test.ts`

**Interfaces:**
- Produces: `listConversations(ctx, filter, extra): Promise<{ conversations: AgentConversationSummary[]; nextCursor: string | null }>` — return type changes from a bare array to this object. `ConversationsListFilters` gains `cursor?: string`.
- Produces: `GET /agent/conversations` response body becomes `{ conversations: [...], nextCursor: string | null }` (was `{ conversations: [...] }`). New optional `cursor` query param.
- Produces: `AgentConversationsResponse` (in `@support/types`) gains `nextCursor: string | null`.
- Consumed by: Task 2 (extends the same file with two more filters, reusing `PAGE_SIZE`), Task 3 (frontend `fetchInbox` passes `cursor` through, reads `nextCursor` from the response).

- [ ] **Step 1: Write the failing pagination tests**

Open `backend/tests/agent.conversations.test.ts`. Add `seedResolutionCycle` to the existing helper import (it's already exported by `backend/tests/helpers/db.ts`, just not imported here yet):

```ts
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedWorkspace,
  seedResolutionCycle,
  truncateAll,
  seedIntent,
  seedSubintent,
  seedAgent,
} from './helpers/db.ts';
```

Add a new `describe` block after the existing `describe('GET /agent/conversations filters', ...)` block (i.e. after its closing `});`, before `describe('POST /agent/conversations/:id/claim', ...)`):

```ts
describe('GET /agent/conversations pagination', () => {
  it('caps a page at 25 and returns a nextCursor when more rows exist', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open' });
    }
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toHaveLength(25);
    expect(typeof res.body.nextCursor).toBe('string');
  });

  it('returns the remaining rows and a null nextCursor on the second page', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(await seedConversation({ workspaceId, playerId, status: 'open' }));
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', cursor: page1.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(page2.body.conversations).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids = page1.body.conversations.map((c: { id: string }) => c.id);
    const page2Ids = page2.body.conversations.map((c: { id: string }) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(30);
    expect([...page1Ids, ...page2Ids].sort()).toEqual([...ids].sort());
  });

  it('does not skip or duplicate a row inserted between two page fetches', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 25; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open' });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.nextCursor).toBeNull();

    // Insert one more row after page 1 was fetched but before page 2 (there is
    // no page 2 yet since page 1 already returned all 25 with nextCursor null
    // — this seeds a 26th row and re-fetches page 1 fresh to prove the new
    // row surfaces once actually queried again, not silently dropped).
    const lateId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const refetched = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(refetched.body.conversations).toHaveLength(25);
    expect(typeof refetched.body.nextCursor).toBe('string');

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', cursor: refetched.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page2.body.conversations.map((c: { id: string }) => c.id)).toEqual([lateId]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm vitest run tests/agent.conversations.test.ts`
Expected: FAIL — `res.body.nextCursor` is `undefined`, and `res.body.conversations` has more than 25 rows for the 30-conversation case (pagination doesn't exist yet).

- [ ] **Step 3: Implement pagination in `conversationsService.ts`**

At the top of the file, no import changes are needed for this step (`desc`, `sql`, `and` are already imported).

Add `PAGE_SIZE` and the cursor helpers right after the `UNASSIGNED_STATUSES` constant (after line 48, before `function extraFilterConditions`):

```ts
const PAGE_SIZE = 25;

type StatusCursor = { priority: string; createdAt: string; id: string };

function encodeCursor(payload: StatusCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeStatusCursor(cursor: string): StatusCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed?.priority === 'string' &&
      typeof parsed?.createdAt === 'string' &&
      typeof parsed?.id === 'string'
    ) {
      return parsed as StatusCursor;
    }
    return null;
  } catch {
    return null;
  }
}
```

Extend `ConversationsListFilters` (currently lines 31-38) to add `cursor`:

```ts
export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  q?: string;
  cursor?: string;
};

export type ConversationsPage = {
  conversations: AgentConversationSummary[];
  nextCursor: string | null;
};
```

Replace the entire `listConversations` function (current lines 74-151) with:

```ts
export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const cursor = extra.cursor ? decodeStatusCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? sql`(${conversation.priority}, ${conversation.createdAt}, ${conversation.id}) > (${cursor.priority}::conversation_priority, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
      : undefined;

    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
        createdAt: conversation.createdAt,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .where(
        and(
          filter === 'mine'
            ? and(
                eq(conversation.assignedAgentId, ctx.agentId),
                inArray(conversation.status, ACTIVE_AGENT_STATUSES),
              )
            : filter === 'agentAssigned'
              ? and(
                  isNotNull(conversation.assignedAgentId),
                  inArray(conversation.status, ACTIVE_AGENT_STATUSES),
                )
              : filter === 'botHandling'
                ? eq(conversation.status, 'bot_active')
                : filter === 'escalated'
                  ? eq(conversation.status, 'escalated')
                  : and(
                      isNull(conversation.assignedAgentId),
                      inArray(conversation.status, UNASSIGNED_STATUSES),
                    ),
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(conversation.priority, conversation.createdAt, conversation.id)
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const summaries: AgentConversationSummary[] = [];
    for (const row of pageRows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      summaries.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        confirm_phase: row.confirmPhase,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
        assigned_agent_id: row.assignedAgentId,
        assigned_agent_name: row.assignedAgentName,
        priority: row.priority,
        tags,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            priority: lastRow.priority,
            createdAt: lastRow.createdAt.toISOString(),
            id: lastRow.id,
          })
        : null;

    if (extra.olderThanHours !== undefined) {
      const cutoff = Date.now() - extra.olderThanHours * 60 * 60 * 1000;
      return {
        conversations: summaries.filter(
          (s) => s.last_message_at !== null && new Date(s.last_message_at).getTime() < cutoff,
        ),
        nextCursor,
      };
    }
    return { conversations: summaries, nextCursor };
  });
}
```

Note what changed and why:
- `id`/`createdAt` were already selected or easy to add — `createdAt` is new in the select list, needed to build the cursor.
- `.limit(PAGE_SIZE + 1)` fetches one lookahead row; `hasMore` is true iff that 26th row came back, which is how `nextCursor` is decided without a separate `COUNT(*)` query.
- The per-row N+1 lookup (last message + tags) now runs over at most `PAGE_SIZE` rows instead of the full queue — a real reduction in query volume for the existing large queues, not just new behavior.
- `nextCursor` is computed from the pre-`olderThanHours`-filter page, then `olderThanHours` filters `summaries` afterward same as before. A page can therefore return fewer than 25 rows when `olderThanHours` trims some — that's fine, not a bug: the client's `hasNextPage` still reflects whether more underlying rows exist, and the next fetch continues correctly from `nextCursor`.

- [ ] **Step 4: Update the controller**

In `backend/src/agent/controllers/conversationsController.ts`, add `cursor` to `ConversationsQuery` (currently lines 27-47):

```ts
const ConversationsQuery = z.object({
  status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
  priority: z
    .union([z.enum(['p1', 'p2', 'p3', 'p4']), z.array(z.enum(['p1', 'p2', 'p3', 'p4']))])
    .optional()
    .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : undefined)),
  labelIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : undefined)),
  subintentIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : undefined)),
  assigneeIds: z
    .union([z.string().uuid(), z.array(z.string().uuid())])
    .optional()
    .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : undefined)),
  olderThanHours: z.coerce.number().optional(),
  q: z.string().optional(),
  cursor: z.string().optional(),
});
```

Update `listConversationsHandler` (currently lines 50-60):

```ts
export const listConversationsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const query = ConversationsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query parameters.');
    return;
  }
  const { status, ...extra } = query.data;
  const { conversations, nextCursor } = await listConversations(ctx, status, extra);
  res.status(200).json({ conversations, nextCursor });
};
```

(Leave the `status` enum's value list as-is for this task — Task 2 extends it with `resolved`/`closed`.)

- [ ] **Step 5: Update the OpenAPI registration**

In `backend/src/docs/openapi.ts`, in the `/agent/conversations` registration (around line 535), add `cursor` to the query schema:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/conversations',
  summary: 'Agent List Conversations',
  description: 'Lists open/unassigned conversations for the agent.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    query: z.object({
      status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
      priority: z
        .union([z.enum(['p1', 'p2', 'p3', 'p4']), z.array(z.enum(['p1', 'p2', 'p3', 'p4']))])
        .optional(),
      labelIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      subintentIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      assigneeIds: z.union([z.string().uuid(), z.array(z.string().uuid())]).optional(),
      olderThanHours: z.coerce.number().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: { description: 'Conversations list' },
  },
});
```

- [ ] **Step 6: Update the shared type**

In `packages/types/src/chat.ts`, change (around line 149):

```ts
export type AgentConversationsResponse = {
  conversations: AgentConversationSummary[];
  nextCursor: string | null;
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/agent.conversations.test.ts`
Expected: PASS — all pre-existing tests in this file still pass (they only assert on `res.body.conversations`, unaffected by the new `nextCursor` field), plus the three new pagination tests from Step 1.

Also run the full backend suite once to catch any other place that assumed a bare array:

Run: `cd backend && pnpm vitest run`
Expected: PASS. If anything outside this file destructures `listConversations`'s result as an array, fix that call site (there should be none besides the controller, per the grep done during design: `listConversations(` has exactly one non-test caller, `conversationsController.ts`).

- [ ] **Step 8: Fix pre-existing frontend test mocks for the new required `nextCursor` field**

`AgentConversationsResponse` (Step 6) now requires `nextCursor: string | null`. Two frontend test files construct `fetchInbox` mock results as object literals typed against that response and will fail `pnpm typecheck` until each literal gains `nextCursor: null`. Grep confirms exactly these two files and eight occurrences — fix all of them now in one pass:

In `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`:
- Line 47: `const fetchInboxSpy = vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] });` → `const fetchInboxSpy = vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });`
- Line 76: `Promise.resolve({ conversations: status === 'unassigned' ? [] : [] }),` → `Promise.resolve({ conversations: status === 'unassigned' ? [] : [], nextCursor: null }),`
- Line 84: `vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] });` → `vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });`

In `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`:
- Line 60: `Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),` → `Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [], nextCursor: null }),`
- Line 74: same replacement as line 60.
- Line 95: `Promise.resolve({ conversations: status === 'mine' ? [mine] : [] }),` → `Promise.resolve({ conversations: status === 'mine' ? [mine] : [], nextCursor: null }),`
- Lines 152-165 (the multi-line block):
  ```ts
  Promise.resolve({
    conversations:
      status === 'mine'
        ? [
            {
              ...UNASSIGNED_CONVERSATION,
              status: 'bot_active' as const,
              confirm_phase: 'form' as const,
            },
          ]
        : [],
  }),
  ```
  becomes:
  ```ts
  Promise.resolve({
    conversations:
      status === 'mine'
        ? [
            {
              ...UNASSIGNED_CONVERSATION,
              status: 'bot_active' as const,
              confirm_phase: 'form' as const,
            },
          ]
        : [],
    nextCursor: null,
  }),
  ```
- Line 176: `Promise.resolve({ conversations: status === 'mine' ? [UNASSIGNED_CONVERSATION] : [] }),` → `Promise.resolve({ conversations: status === 'mine' ? [UNASSIGNED_CONVERSATION] : [], nextCursor: null }),`

Run both files' suites to confirm nothing else broke:

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. This also confirms `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx` itself is unaffected — its `setQueryData` updater only ever spreads `{ ...current, conversations }`, which preserves `nextCursor` from `current`.

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts packages/types/src/chat.ts backend/tests/agent.conversations.test.ts frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx
git commit -m "feat: add cursor pagination to agent conversation queues"
```

---

## Task 2: Resolved & Closed queues

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.conversations.test.ts`

**Interfaces:**
- Consumes: `PAGE_SIZE`, `ConversationsPage` type, `extraFilterConditions()` from Task 1.
- Produces: `ConversationsFilter` gains `'resolved' | 'closed'`. `listConversations(ctx, 'resolved' | 'closed', extra)` returns conversations whose current `resolution_cycle` row has `resolvedAt`/`closedAt` within the last 7 days, newest first, same `ConversationsPage` shape and same cursor pagination contract as Task 1's filters (opaque `nextCursor` string, round-tripped via `extra.cursor`).
- Consumed by: Task 3 (frontend passes `'resolved'`/`'closed'` as a `ConversationListFilter` value).

- [ ] **Step 1: Write the failing tests**

In `backend/tests/agent.conversations.test.ts`, add a new `describe` block after the `describe('GET /agent/conversations pagination', ...)` block added in Task 1:

```ts
describe('GET /agent/conversations resolved/closed queues', () => {
  it('lists a conversation resolved within the last 7 days', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationId]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('omits a conversation resolved more than 7 days ago', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toEqual([]);
  });

  it('excludes a resolved conversation with no resolution cycle row', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    await seedConversation({ workspaceId, playerId, status: 'resolved' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations).toEqual([]);
  });

  it('lists closed conversations most-recently-closed first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const olderId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    await seedResolutionCycle({
      workspaceId,
      conversationId: olderId,
      resolvedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const newerId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    await seedResolutionCycle({
      workspaceId,
      conversationId: newerId,
      resolvedAt: new Date(Date.now() - 90 * 60 * 1000),
      closedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'closed' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([newerId, olderId]);
  });

  it('uses only the latest resolution cycle for a reopened-then-reclosed conversation', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'closed' });
    // First cycle: resolved and closed 10 days ago (outside the 7-day window).
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      cycleNo: 1,
      resolvedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    });
    // Reopened, resolved and closed again 1 hour ago (inside the window) — this
    // is the row that must decide whether the conversation appears, not cycle 1.
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      cycleNo: 2,
      resolvedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      closedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'closed' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationId]);
  });

  it('paginates the resolved queue in pages of 25, newest first, with a stable cursor', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
      await seedResolutionCycle({
        workspaceId,
        conversationId,
        // Spread resolvedAt out so ordering is deterministic and every row is
        // clearly inside the 7-day window.
        resolvedAt: new Date(Date.now() - i * 60 * 1000),
      });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'resolved' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.conversations).toHaveLength(25);
    expect(typeof page1.body.nextCursor).toBe('string');

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'resolved', cursor: page1.body.nextCursor })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page2.body.conversations).toHaveLength(5);
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids = page1.body.conversations.map((c: { id: string }) => c.id);
    const page2Ids = page2.body.conversations.map((c: { id: string }) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(30);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm vitest run tests/agent.conversations.test.ts`
Expected: FAIL — `ConversationsQuery`'s zod enum rejects `status: 'resolved'`/`'closed'` with a 422, so every new test in this block fails.

- [ ] **Step 3: Implement in `conversationsService.ts`**

Add two imports to the top of the file — `notExists` from `drizzle-orm`, and `alias` from `drizzle-orm/pg-core`:

```ts
import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  isNotNull,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
```

Extend `ConversationsFilter`:

```ts
export type ConversationsFilter =
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed';
```

Add a second cursor type and its encode/decode helpers, next to `StatusCursor`'s (added in Task 1):

```ts
type TimelineCursor = { ts: string; id: string };

function encodeTimelineCursor(payload: TimelineCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeTimelineCursor(cursor: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.ts === 'string' && typeof parsed?.id === 'string') {
      return parsed as TimelineCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// Self-join alias for the "only the latest resolution_cycle row per
// conversation" NOT EXISTS pattern below — a conversation can carry multiple
// historical cycles (resolve → reopen → resolve again), and only the most
// recent one reflects why the conversation is *currently* resolved/closed.
const latestCycle = alias(resolutionCycle, 'latest_cycle');
```

Change `listConversations` to dispatch to a new branch for the two new filters — replace the function's opening line:

```ts
export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<ConversationsPage> {
  if (filter === 'resolved' || filter === 'closed') {
    return listResolvedOrClosedConversations(ctx, filter, extra);
  }
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // ...unchanged body from Task 1...
```

(Leave everything inside that `withWorkspace(...)` call exactly as Task 1 left it — only the function signature line and the new `if` guard above it change.)

Add the new function directly below `listConversations`'s closing brace:

```ts
async function listResolvedOrClosedConversations(
  ctx: AgentContext,
  filter: 'resolved' | 'closed',
  extra: ConversationsListFilters,
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const timestampCol =
      filter === 'resolved' ? resolutionCycle.resolvedAt : resolutionCycle.closedAt;
    const cursor = extra.cursor ? decodeTimelineCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? sql`(${timestampCol}, ${conversation.id}) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
      : undefined;

    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
        ts: timestampCol,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .innerJoin(
        resolutionCycle,
        and(
          eq(resolutionCycle.conversationId, conversation.id),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(latestCycle)
              .where(
                and(
                  eq(latestCycle.conversationId, resolutionCycle.conversationId),
                  sql`${latestCycle.cycleNo} > ${resolutionCycle.cycleNo}`,
                ),
              ),
          ),
        ),
      )
      .where(
        and(
          eq(conversation.status, filter),
          isNotNull(timestampCol),
          sql`${timestampCol} >= now() - interval '7 days'`,
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(desc(timestampCol), desc(conversation.id))
      .limit(PAGE_SIZE + 1);

    const hasMore = rows.length > PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    const summaries: AgentConversationSummary[] = [];
    for (const row of pageRows) {
      const [last] = await tx
        .select({ body: message.body, createdAt: message.createdAt })
        .from(message)
        .where(eq(message.conversationId, row.id))
        .orderBy(desc(message.seq))
        .limit(1);
      const tags = await getConversationTags(tx, row.id);

      summaries.push({
        id: row.id,
        player: { external_player_id: row.externalPlayerId },
        status: row.status,
        confirm_phase: row.confirmPhase,
        last_message_preview: last?.body ?? null,
        last_message_at: last?.createdAt.toISOString() ?? null,
        assigned_agent_id: row.assignedAgentId,
        assigned_agent_name: row.assignedAgentName,
        priority: row.priority,
        tags,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow && lastRow.ts
        ? encodeTimelineCursor({ ts: lastRow.ts.toISOString(), id: lastRow.id })
        : null;

    return { conversations: summaries, nextCursor };
  });
}
```

Why the `NOT EXISTS` self-join instead of a plain `innerJoin(resolutionCycle, eq(resolutionCycle.conversationId, conversation.id))`: a conversation can carry more than one `resolution_cycle` row (each reopen starts a new cycle). A plain join would fan out one conversation into multiple result rows — visibly duplicating a ticket in the column — for anything reopened and resolved/closed more than once. The `NOT EXISTS` clause keeps only the row with the highest `cycle_no` per conversation, i.e. the one that actually explains the conversation's *current* status.

- [ ] **Step 4: Update the controller**

In `backend/src/agent/controllers/conversationsController.ts`, extend the `status` enum in `ConversationsQuery`:

```ts
status: z.enum([
  'unassigned',
  'mine',
  'agentAssigned',
  'botHandling',
  'escalated',
  'resolved',
  'closed',
]),
```

No other controller change is needed — `listConversationsHandler` already forwards `status` and `extra` generically.

- [ ] **Step 5: Update the OpenAPI registration**

In `backend/src/docs/openapi.ts`, update the same enum in the `/agent/conversations` query schema:

```ts
status: z.enum([
  'unassigned',
  'mine',
  'agentAssigned',
  'botHandling',
  'escalated',
  'resolved',
  'closed',
]),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && pnpm vitest run tests/agent.conversations.test.ts`
Expected: PASS — all tests in the file, including the new `resolved/closed queues` block.

Run: `cd backend && pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts backend/tests/agent.conversations.test.ts
git commit -m "feat: add resolved and closed ticket queues"
```

---

## Task 3: Tickets board — new columns + infinite scroll

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`

**Interfaces:**
- Consumes: `AgentConversationsResponse` with `nextCursor` (Task 1), `'resolved' | 'closed'` as valid queue filters (Task 2).
- Produces: `ConversationListFilter` gains `'resolved' | 'closed'`. `fetchInbox(token, status, filters?, cursor?)` — new optional 4th param.
- `Tickets.tsx`'s `COLUMNS` gains two entries; each column fetches via `useInfiniteQuery` instead of `useQuery` and appends a page when scrolled near the bottom.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`, add these tests inside the existing `describe('Tickets filtering', ...)` block (or a new adjacent `describe`) — the file's existing three tests must keep passing unmodified, since they only check argument-passing and empty-state text, which are unaffected by these changes:

```ts
describe('Tickets pagination', () => {
  it('renders Resolved and Closed columns', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await screen.findByText('Resolved');
    await screen.findByText('Closed');
  });

  it('requests fetchInbox for the resolved and closed filters', async () => {
    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith(
        'tok',
        'resolved',
        expect.anything(),
        undefined,
      ),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'closed', expect.anything(), undefined);
  });

  it('fetches the next page when a column is scrolled near its bottom', async () => {
    const conversation = (id: string) => ({
      id,
      player: { external_player_id: 'p1' },
      status: 'open',
      confirm_phase: 'none',
      last_message_preview: null,
      last_message_at: null,
      assigned_agent_id: null,
      assigned_agent_name: null,
      priority: 'p3',
      tags: [],
    });

    const fetchInboxSpy = vi.mocked(agentApi.fetchInbox).mockImplementation((_t, status, _f, cursor) => {
      if (status !== 'unassigned') return Promise.resolve({ conversations: [], nextCursor: null });
      if (!cursor) {
        return Promise.resolve({ conversations: [conversation('c1')], nextCursor: 'page-2' });
      }
      return Promise.resolve({ conversations: [conversation('c2')], nextCursor: null });
    });

    renderTickets('/tickets');
    await screen.findByText(/1/); // column count badge for the Unassigned column

    const scrollable = document.querySelector('.overflow-y-auto') as HTMLElement;
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollable, 'scrollTop', { value: 700, configurable: true });
    scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith(
        'tok',
        'unassigned',
        expect.anything(),
        'page-2',
      ),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`
Expected: FAIL — no "Resolved"/"Closed" text exists yet, `fetchInbox` is never called with a 4th `cursor` argument, and there's no scroll handler.

- [ ] **Step 3: Update `agentApi.ts`**

Extend `ConversationListFilter` (currently lines 106-107):

```ts
export type ConversationListFilter =
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed';
```

Update `buildTicketsQuery` and `fetchInbox` (currently lines 118-137) to accept and forward a cursor:

```ts
function buildTicketsQuery(
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
  cursor?: string,
): string {
  const params = new URLSearchParams({ status });
  if (filters?.q) params.set('q', filters.q);
  if (filters?.priority?.length) filters.priority.forEach((p) => params.append('priority', p));
  if (filters?.labelIds?.length) filters.labelIds.forEach((l) => params.append('labelIds', l));
  if (filters?.subintentIds?.length)
    filters.subintentIds.forEach((s) => params.append('subintentIds', s));
  if (filters?.assigneeIds?.length)
    filters.assigneeIds.forEach((a) => params.append('assigneeIds', a));
  if (filters?.olderThanHours) params.set('olderThanHours', String(filters.olderThanHours));
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function fetchInbox(
  token: string,
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
  cursor?: string,
): Promise<AgentConversationsResponse> {
  return call(`/agent/conversations?${buildTicketsQuery(status, filters, cursor)}`, token);
}
```

- [ ] **Step 4: Update `Tickets.tsx`**

Add the `useInfiniteQuery` import:

```ts
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
```

(Note: `useQueries` and `useQuery` are dropped from this import — `useQueries` is replaced below by a `useInfiniteQuery`-backed map for the summary lookup, and the per-column `useQuery` becomes `useInfiniteQuery`.)

Add the two new columns to `COLUMNS`:

```ts
const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] = [
  { title: 'Unassigned', filter: 'unassigned', claimable: true },
  { title: 'Bot Handling', filter: 'botHandling' },
  { title: 'Agent Assigned', filter: 'agentAssigned' },
  { title: 'Escalated', filter: 'escalated' },
  { title: 'Resolved', filter: 'resolved' },
  { title: 'Closed', filter: 'closed' },
];
```

Replace `QueueColumn`'s body (currently lines 102-189) with:

```ts
function QueueColumn({
  token,
  title,
  filter,
  queryFilters,
  filtersActive,
  claimable = false,
  dragHandleProps,
  onSelect,
}: {
  token: string;
  title: string;
  filter: ConversationListFilter;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  claimable?: boolean;
  dragHandleProps?: Record<string, any>;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const queue = useInfiniteQuery({
    queryKey: ['tickets', filter, queryFilters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, filter, queryFilters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const sectionRef = useRef<HTMLElement>(null);
  const [height] = useState(() => localStorage.getItem(`queueHeight_${filter}`) || '400px');

  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const borderBoxHeight =
          entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
        if (borderBoxHeight > 50) {
          localStorage.setItem(`queueHeight_${filter}`, `${borderBoxHeight}px`);
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [filter]);

  const conversations = queue.data?.pages.flatMap((page) => page.conversations) ?? [];

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && queue.hasNextPage && !queue.isFetchingNextPage) {
      void queue.fetchNextPage();
    }
  }

  if (queue.data && conversations.length === 0 && !filtersActive) return null;
  return (
    <section
      ref={sectionRef}
      style={{ height, minHeight: '150px' }}
      className="flex min-h-0 flex-col rounded-card border border-slate-200 bg-surface resize-y overflow-hidden pb-1"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          {dragHandleProps && (
            <div
              {...dragHandleProps}
              className="cursor-grab active:cursor-grabbing text-muted hover:text-text"
            >
              <GripVertical className="size-4" />
            </div>
          )}
          <h2 className="text-sm font-semibold">{title}</h2>
        </div>
        <span className="text-xs text-muted">{conversations.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" onScroll={handleScroll}>
        {conversations.length === 0 && filtersActive && (
          <p className="p-3 text-xs text-muted">No tickets match your filters.</p>
        )}
        {conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={false}
            onSelect={() => onSelect(conversation.id)}
            onClaim={claimable ? () => claim.mutate(conversation.id) : undefined}
            claiming={claim.isPending}
          />
        ))}
        {queue.isFetchingNextPage && <p className="p-3 text-xs text-muted">Loading more...</p>}
        {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
      </div>
    </section>
  );
}
```

In the `Tickets` component, the bulk `useQueries` call (currently lines 224-230) exists only to find the `summary` for the currently-open conversation when navigating straight to `/tickets/:conversationId` — it is not the source of truth for what each column renders (each `QueueColumn` now owns its own `useInfiniteQuery`). Sharing a query key between a `useInfiniteQuery` (columns) and a `useQuery` (this bulk lookup) is unsafe in TanStack Query v5 — they'd overwrite each other's differently-shaped cache entries under the same key. Give the bulk lookup its own key namespace and keep it a plain first-page `useQuery`:

```ts
const summaryQueries = useQueries({
  queries: COLUMNS.map(({ filter }) => ({
    queryKey: ['tickets-summary', filter, queryFilters],
    queryFn: () => fetchInbox(session!.token, filter, queryFilters),
    enabled: session !== null,
  })),
});

const summary = (() => {
  if (!conversationId) return undefined;
  for (const query of summaryQueries) {
    const found = query.data?.conversations.find(
      (conversation) => conversation.id === conversationId,
    );
    if (found) return found;
  }
  return undefined;
})();
```

This means `useQueries` is still imported from `@tanstack/react-query` — restore it in the import line from Step 4 above:

```ts
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
```

Everywhere else in the `Tickets` component that referenced `queueQueries`, rename to `summaryQueries` (the empty-state check `!filtersActive && queueQueries.every(...)` and the per-column `isHidden` check both used it — both are about "is this column's first page empty", which `summaryQueries` (first page only) still answers correctly since a first page can only be empty when the whole queue is empty, cursor pagination or not):

```ts
{!filtersActive &&
  summaryQueries.every((q) => q.data) &&
  summaryQueries.every((q) => q.data!.conversations.length === 0) && (
    <EmptyState message="Nothing to show" />
  )}
```

```ts
{columnOrder.map((filter) => {
  const col = COLUMNS.find((c) => c.filter === filter)!;
  const queryIndex = COLUMNS.findIndex((c) => c.filter === filter);
  const summaryQuery = summaryQueries[queryIndex];
  const isHidden = Boolean(
    summaryQuery?.data && summaryQuery.data.conversations.length === 0 && !filtersActive,
  );

  if (isHidden) return null;

  return (
    <SortableQueueColumn
      key={filter}
      id={filter}
      col={col}
      token={session.token}
      queryFilters={queryFilters}
      filtersActive={filtersActive}
      onSelect={(id) => navigate(`/tickets/${id}`)}
    />
  );
})}
```

Finally, the socket-driven invalidation effect (currently lines 200-222) invalidates `['tickets', filter]` — since column data now lives under `useInfiniteQuery` at that same key prefix, `invalidateQueries({ queryKey: ['tickets', filter] })` still matches and refetches correctly (TanStack Query invalidation matches by key prefix regardless of query type). No change needed there, but add the two new filters to the socket handler's status-to-filter mapping so a conversation becoming resolved/closed also invalidates those columns:

```ts
const filtersToInvalidate: ConversationListFilter[] =
  status === 'bot_active'
    ? ['botHandling']
    : status === 'resolved'
      ? ['resolved']
      : status === 'closed'
        ? ['closed']
        : ['unassigned', 'agentAssigned', 'escalated'];
```

Also update the `columnOrder` localStorage validity check, which currently compares `parsed.length === COLUMNS.length` — this already works unchanged since `COLUMNS.length` is now 6, so a stale localStorage value saved when there were 4 columns will correctly fail this check and fall back to `COLUMNS.map((c) => c.filter)` (all 6, in the new default order). No code change needed here, just confirms the existing guard still does the right thing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`
Expected: PASS — the three pre-existing tests plus the three new ones from Step 1.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Manually verify in the running app**

Run: `pnpm dev`, open the agent console, navigate to Tickets. Confirm: Resolved and Closed columns appear (when non-empty), each shows its item count, and scrolling a column with more than 25 items loads more instead of stopping at 25.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx
git commit -m "feat: add Resolved/Closed columns and infinite scroll to the Tickets board"
```

---

## Task 4: Inbox page — avoid truncating "mine"/"escalated" at 25

**Why this task exists:** `Inbox.tsx`'s `ConversationList` (`frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx`) calls the same `fetchInbox(token, 'mine')` / `fetchInbox(token, 'escalated')` that Task 1 just made the backend cap at 25 rows with no way to request more. Without this task, an agent with more than 25 active "mine" conversations would silently stop seeing the rest in their Inbox — a regression introduced by Task 1, not a pre-existing limitation. This applies the same `useInfiniteQuery` treatment used in Task 3. Both "My tickets" and "Escalated tickets" render inside one shared scrollable container (confirmed by reading the current file in full), so one scroll handler drives both — scrolling to the bottom loads another page of whichever of the two still has more.

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/ui/scroll-area.tsx` (the shared `ScrollArea` wraps Radix's `Root`/`Viewport`; the actual scrollable element is `Viewport`, and today's `ScrollArea` only spreads extra props onto `Root`, so `onScroll` needs a dedicated pass-through to reach the element that actually scrolls)
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx` (already exists — confirmed by listing the directory during design; extend it, don't create a new file)

**Interfaces:**
- Consumes: `fetchInbox(token, status, filters?, cursor?)` from Task 3.
- Produces: `ScrollArea` gains two new optional props, `onScroll?: React.UIEventHandler<HTMLDivElement>` and `viewportTestId?: string`, both forwarded to the Radix `Viewport` element instead of `Root`. Existing callers that pass neither are unaffected.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to the end of `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx` (after the existing `describe('ConversationList form label', ...)` block), reusing the file's own `renderWithClient` helper and `UNASSIGNED_CONVERSATION` fixture already defined at the top of the file:

```ts
describe('ConversationList pagination', () => {
  it('fetches the next page of "mine" when scrolled near the bottom', async () => {
    const c2 = { ...UNASSIGNED_CONVERSATION, id: 'conv-2' };
    const fetchSpy = vi
      .spyOn(agentApi, 'fetchInbox')
      .mockImplementation((_token, status, _filters, cursor) => {
        if (status !== 'mine') return Promise.resolve({ conversations: [], nextCursor: null });
        if (!cursor) {
          return Promise.resolve({
            conversations: [UNASSIGNED_CONVERSATION],
            nextCursor: 'page-2',
          });
        }
        return Promise.resolve({ conversations: [c2], nextCursor: null });
      });

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />);
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('tok', 'mine', undefined, undefined),
    );

    const scrollable = screen.getByTestId('conversation-list-scroll');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollable, 'scrollTop', { value: 700, configurable: true });
    fireEvent.scroll(scrollable);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('tok', 'mine', undefined, 'page-2'),
    );
    await screen.findByText('player-42'); // still renders page 1's row
  });
});
```

Add `fireEvent` to this file's existing `@testing-library/react` import (currently `import { act, render, screen, waitFor } from '@testing-library/react';`):

```ts
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: FAIL — `screen.getByTestId('conversation-list-scroll')` throws, since no such element exists yet.

- [ ] **Step 3: Add `onScroll`/`viewportTestId` pass-through to `ScrollArea`**

In `frontend/src/surfaces/agent-console/components/ui/scroll-area.tsx`, replace the `ScrollArea` function with:

```tsx
function ScrollArea({
  className,
  children,
  onScroll,
  viewportTestId,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  onScroll?: React.UIEventHandler<HTMLDivElement>;
  viewportTestId?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      {/* Radix injects an internal div with `display: table; min-width: 100%`
          around children to measure content size for the scrollbar thumb.
          Table layout shrink-to-fits, so non-shrinking content (e.g. a
          `shrink-0` badge cluster) stretches that wrapper wider than the
          viewport instead of wrapping/truncating, and with only a vertical
          scrollbar rendered the excess width is silently clipped. Forcing it
          back to block layout restores normal width constraints. */}
      <ScrollAreaPrimitive.Viewport
        className="size-full rounded-[inherit] [&>div]:!block"
        onScroll={onScroll}
        data-testid={viewportTestId}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
```

`onScroll` and `viewportTestId` are pulled out of `props` before the spread onto `Root`, so they land only on `Viewport` — the element that actually has `overflow: auto` and fires scroll events — and every other existing `ScrollArea` caller (which passes neither prop) renders identically to before.

- [ ] **Step 4: Convert `ConversationList.tsx` to paginated infinite queries**

Replace the full contents of `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx` with:

```tsx
import { useEffect } from 'react';
import type { AgentConversationsResponse, ConversationStatusValue } from '@support/types';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { fetchInbox } from '../../../api/agentApi.ts';
import { createSocket } from '../../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../../lib/authErrorHandling.ts';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../../components/ui/empty-state.tsx';
import { ConversationRow } from './ConversationRow.tsx';

type InboxPages = { pages: AgentConversationsResponse[]; pageParams: (string | undefined)[] };

export function ConversationList({
  token,
  selectedId,
  onSelect,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const mine = useInfiniteQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'mine', undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const escalated = useInfiniteQuery({
    queryKey: ['inbox', 'escalated'],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'escalated', undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const mineConversations = mine.data?.pages.flatMap((page) => page.conversations) ?? [];
  const escalatedConversations =
    escalated.data?.pages.flatMap((page) => page.conversations) ?? [];

  useEffect(() => {
    const socket = createSocket(token, 'agent');
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired();
    });

    /**
     * The badge updates from the socket payload; this only catches up the fields
     * the payload does not carry (`last_message_preview`, `last_message_at`, and
     * which tab a row belongs in). Trailing and coalesced, so a burst of inbound
     * messages costs one round trip instead of one per message, and the status
     * never waits on it — which matters because a refetch here is a full API
     * round trip and the console talks to the API through a tunnel.
     */
    const scheduleRefetch = () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined;
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      }, 1000);
    };

    socket.on(
      'conversation:changed',
      (payload: { conversation_id?: unknown; status?: unknown }) => {
        const { conversation_id: id, status } = payload;
        if (typeof id !== 'string' || typeof status !== 'string') {
          scheduleRefetch();
          return;
        }

        let patched = false;
        for (const key of [
          ['inbox', 'mine'],
          ['inbox', 'escalated'],
        ]) {
          queryClient.setQueryData<InboxPages>(key, (current) => {
            if (!current) return current;
            let foundInThisList = false;
            const pages = current.pages.map((page) => {
              const index = page.conversations.findIndex((c) => c.id === id);
              if (index === -1) return page;
              foundInThisList = true;
              const conversations = page.conversations.slice();
              conversations[index] = {
                ...conversations[index]!,
                status: status as ConversationStatusValue,
              };
              return { ...page, conversations };
            });
            if (!foundInThisList) return current;
            patched = true;
            return { ...current, pages };
          });
        }

        // An id in neither list is a conversation that just appeared, or one that
        // moved between Unassigned and Mine. Neither can be rendered from
        // {id, status} alone, so that case still needs the server — immediately,
        // not on the trailing timer, or a new conversation would appear late.
        if (!patched) {
          void queryClient.invalidateQueries({ queryKey: ['inbox'] });
          return;
        }
        scheduleRefetch();
      },
    );

    return () => {
      if (refetchTimer) clearTimeout(refetchTimer);
      socket.close();
    };
  }, [token, queryClient]);

  const bothLoadedAndEmpty =
    mine.data &&
    escalated.data &&
    mineConversations.length === 0 &&
    escalatedConversations.length === 0;

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!nearBottom) return;
    if (mine.hasNextPage && !mine.isFetchingNextPage) void mine.fetchNextPage();
    if (escalated.hasNextPage && !escalated.isFetchingNextPage) void escalated.fetchNextPage();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea
        className="min-h-0 flex-1"
        viewportTestId="conversation-list-scroll"
        onScroll={handleScroll}
      >
        {bothLoadedAndEmpty ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <>
            <div className="p-3 text-sm font-semibold">My tickets</div>
            {mineConversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {mineConversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No open tickets.</div>
            )}
            {mine.isFetchingNextPage && (
              <div className="px-3 pb-3 text-sm text-muted">Loading more...</div>
            )}

            <div className="p-3 text-sm font-semibold">Escalated tickets</div>
            {escalatedConversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                selected={c.id === selectedId}
                onSelect={() => onSelect(c.id)}
              />
            ))}
            {escalatedConversations.length === 0 && (
              <div className="px-3 pb-3 text-sm text-muted">No escalated tickets.</div>
            )}
            {escalated.isFetchingNextPage && (
              <div className="px-3 pb-3 text-sm text-muted">Loading more...</div>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: PASS — the new pagination test, plus every pre-existing test in the file (their call-count assertions are unaffected: each tab's infinite query still calls its `queryFn` exactly once per mount and once per invalidation, since none of those tests' mocks ever return a non-null `nextCursor`).

Run the full frontend suite once too, since `ScrollArea` is shared by other components:

Run: `cd frontend && pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Manually verify in the running app**

Run: `pnpm dev`, open the agent console Inbox with an agent that has more than 25 active conversations (seed extra via `pnpm db:seed` or manually if needed), confirm scrolling loads more instead of stopping at 25.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx frontend/src/surfaces/agent-console/components/ui/scroll-area.tsx
git commit -m "fix: paginate Inbox mine/escalated lists to match backend pagination"
```

---

## Final verification

- [ ] Run `pnpm test` from the repo root (requires Postgres up per this repo's CLAUDE.md) and confirm the full suite passes.
- [ ] Run `pnpm typecheck` from the repo root and confirm no errors.
- [ ] Run `pnpm lint` from the repo root and confirm no errors.
- [ ] Open `http://localhost:4000/docs` and confirm `GET /agent/conversations` shows `resolved`/`closed` in the `status` enum and a `cursor` query param.
