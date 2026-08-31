# Tickets List View and Widened Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent merge the Tickets board's six queues into one ranked list under active search/filters, and widen the filter bar with a Status multi-select and a Created-date range.

**Architecture:** A new `'all'` virtual queue in `conversationsService.listConversations` unions the where-clauses of the other six queues (restricted to an optional `statuses` subset), sorted by priority then most-recent-activity with real SQL keyset pagination. Two new AND-on-top filter params (`createdFrom`/`createdTo`) apply to every existing mode too. On the frontend, a URL-persisted `view` param toggles between the existing 6-column board and one new `TicketsListView` infinite list backed by the `'all'` mode.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (backend), React + TanStack Query + Tailwind v4 (frontend), Vitest + Testing Library.

## Global Constraints

- No schema migration — every field used already exists (`conversation.createdAt`, `message.createdAt`, `resolutionCycle.resolvedAt`/`closedAt`).
- Every new query param is AND'd on top of existing filters — never replaces one.
- `createdFrom`/`createdTo` apply identically to every filter mode (board columns included), not just the new merged mode.
- The 7-day Resolved/Closed window and its "latest cycle only" logic must be reused unchanged inside the merged mode — don't relax or duplicate its semantics incorrectly.
- Board mode's existing per-column sort, pagination, resizable height, drag-reorder, and real-time reconciliation are untouched.
- New endpoint/param → register in `backend/src/docs/openapi.ts` (repo convention, `CLAUDE.md`).
- Tailwind v4 utilities only — no hand-written CSS classes (`CLAUDE.md`).
- Filter/view state lives in URL params only, same pattern as every existing field in `useTicketsFilters.ts`.

---

## Task 1: Backend — Created-date range filter, applied to every existing mode

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts:45-53` (`ConversationsListFilters`), `:118-140` (`extraFilterConditions`)
- Modify: `backend/src/agent/controllers/conversationsController.ts:28-57` (`ConversationsQuery`)
- Modify: `backend/src/docs/openapi.ts:602-623` (`/agent/conversations` query schema)
- Test: `backend/tests/agent.conversations.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `ConversationsListFilters` type and `extraFilterConditions(extra)` function already used by every filter mode.
- Produces: `ConversationsListFilters.createdFrom?: string` and `.createdTo?: string` (`YYYY-MM-DD`), applied as two more conditions inside `extraFilterConditions`. Later tasks (Task 2) build on this same `extra` object.

- [ ] **Step 1: Write the failing backend test**

Add to `backend/tests/agent.conversations.test.ts`, inside the existing `describe('GET /agent/conversations', ...)` block:

```ts
it('filters by createdFrom/createdTo, AND-ed with the status mode', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const inRange = await seedConversation({
    workspaceId,
    playerId,
    status: 'open',
    createdAt: new Date('2026-08-15T00:00:00Z'),
  });
  await seedConversation({
    workspaceId,
    playerId,
    status: 'open',
    createdAt: new Date('2026-08-01T00:00:00Z'),
  });
  const { token } = await setupAgent(workspaceId);

  const res = await request(app)
    .get('/conversations')
    .query({ status: 'unassigned', createdFrom: '2026-08-10', createdTo: '2026-08-20' })
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .expect(200);

  expect(res.body.conversations).toHaveLength(1);
  expect(res.body.conversations[0].id).toBe(inRange);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test agent.conversations -- -t "createdFrom/createdTo"`
Expected: FAIL — `createdFrom`/`createdTo` aren't accepted/applied yet, so both conversations return (length 2, not 1).

- [ ] **Step 3: Add the fields and conditions**

In `conversationsService.ts`, extend the type:

```ts
export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  q?: string;
  cursor?: string;
  createdFrom?: string;
  createdTo?: string;
};
```

In `extraFilterConditions`, add two more pushes (date-only strings, `createdTo` inclusive of the whole day):

```ts
function extraFilterConditions(extra: ConversationsListFilters) {
  const conditions = [];
  if (extra.priority?.length) conditions.push(inArray(conversation.priority, extra.priority));
  if (extra.subintentIds?.length)
    conditions.push(inArray(conversation.subintentId, extra.subintentIds));
  if (extra.assigneeIds?.length)
    conditions.push(inArray(conversation.assignedAgentId, extra.assigneeIds));
  if (extra.labelIds?.length) {
    conditions.push(
      exists(
        sql`(select 1 from ${conversationTag} where ${conversationTag.conversationId} = ${conversation.id} and ${conversationTag.removedAt} is null and ${conversationTag.tagId} in ${extra.labelIds})`,
      ),
    );
  }
  if (extra.createdFrom) conditions.push(sql`${conversation.createdAt} >= ${extra.createdFrom}::date`);
  if (extra.createdTo)
    conditions.push(sql`${conversation.createdAt} < (${extra.createdTo}::date + interval '1 day')`);
  if (extra.q) {
    const term = `%${extra.q}%`;
    const qNum = parseInt(extra.q, 10);
    const numMatch = !isNaN(qNum) ? eq(conversation.number, qNum) : undefined;
    const qCond = or(numMatch, ilike(player.externalId, term), ilike(subintent.name, term));
    if (qCond) conditions.push(qCond);
  }
  return conditions;
}
```

In `conversationsController.ts`, extend `ConversationsQuery`:

```ts
const ConversationsQuery = z.object({
  status: z.enum([
    'unassigned',
    'mine',
    'agentAssigned',
    'botHandling',
    'escalated',
    'resolved',
    'closed',
  ]),
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
  createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
```

(`status` enum gains `'all'` in Task 2 — leave it as-is here.)

In `openapi.ts`, mirror the same two fields in the `/agent/conversations` query schema (around line 619-621):

```ts
      olderThanHours: z.coerce.number().optional(),
      q: z.string().optional(),
      cursor: z.string().optional(),
      createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test agent.conversations -- -t "createdFrom/createdTo"`
Expected: PASS

- [ ] **Step 5: Run the full backend suite**

Run: `pnpm --filter backend test`
Expected: PASS (no regressions in the other `agent.conversations.test.ts` cases or elsewhere `extraFilterConditions` is exercised)

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts backend/tests/agent.conversations.test.ts
git commit -m "Add createdFrom/createdTo date-range filter to agent conversations list"
```

---

## Task 2: Backend — merged `'all'` queue with Status subset, priority+activity sort, pagination

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts` (add `ConversationsFilter = 'all'`, `ConversationsListFilters.statuses`, `queueCondition`, `resolvedOrClosedCondition`, `listAllConversations`, dispatcher branch)
- Modify: `backend/src/agent/controllers/conversationsController.ts` (`status` enum gains `'all'`, new `statuses` param)
- Modify: `backend/src/docs/openapi.ts` (mirror both)
- Test: `backend/tests/agent.conversations.test.ts`

**Interfaces:**
- Consumes: `extraFilterConditions(extra)` and the `createdFrom`/`createdTo` fields from Task 1; `PAGE_SIZE`, `Tx` type, `withWorkspace`, existing table imports — all already present in the file.
- Produces: `listConversations(ctx, 'all', extra)` — same `ConversationsPage` return shape (`{ conversations, nextCursor }`) as every other mode. `ConversationsListFilters.statuses?: Exclude<ConversationsFilter, 'all' | 'mine'>[]` — later tasks (frontend) send this as repeated `statuses` query params.

- [ ] **Step 1: Write the failing backend tests**

Add to `backend/tests/agent.conversations.test.ts`:

```ts
describe('GET /agent/conversations?status=all', () => {
  it('merges unassigned, escalated, and resolved conversations, sorted by priority then activity', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);

    const p2Unassigned = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
    });
    const p1Escalated = await seedConversation({
      workspaceId,
      playerId,
      status: 'escalated',
      priority: 'p1',
    });
    const p1ResolvedRecent = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p1',
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId: p1ResolvedRecent,
      resolvedAt: new Date(),
    });
    const p1ResolvedStale = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p1',
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId: p1ResolvedStale,
      resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    });
    await seedMessage({
      workspaceId,
      conversationId: p1Escalated,
      seq: 1,
      authorType: 'agent',
      body: 'checking on this',
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'all' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const ids = res.body.conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(p2Unassigned);
    expect(ids).toContain(p1Escalated);
    expect(ids).toContain(p1ResolvedRecent);
    // Outside the 7-day resolved window — excluded exactly like the dedicated resolved queue.
    expect(ids).not.toContain(p1ResolvedStale);
    // p1s before the p2, and among the p1s the one with the most recent
    // activity (p1Escalated has a message just now) sorts before the other.
    expect(ids.indexOf(p1Escalated)).toBeLessThan(ids.indexOf(p2Unassigned));
    expect(ids.indexOf(p1Escalated)).toBeLessThan(ids.indexOf(p1ResolvedRecent));
  });

  it('restricts to the requested statuses subset', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const unassigned = await seedConversation({ workspaceId, playerId, status: 'open' });
    const botHandling = await seedConversation({ workspaceId, playerId, status: 'bot_active' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'all', statuses: ['unassigned'] })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const ids = res.body.conversations.map((c: { id: string }) => c.id);
    expect(ids).toContain(unassigned);
    expect(ids).not.toContain(botHandling);
  });

  it('paginates with a stable keyset cursor', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p3' });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'all' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.conversations).toHaveLength(25);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await request(app)
      .get('/conversations')
      .query({ status: 'all', cursor: page1.body.nextCursor })
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

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter backend test agent.conversations -- -t "status=all"`
Expected: FAIL — `status: 'all'` is rejected by the zod enum (422) today.

- [ ] **Step 3: Implement `queueCondition`, `resolvedOrClosedCondition`, and `listAllConversations`**

In `conversationsService.ts`, extend `ConversationsFilter` and `ConversationsListFilters`:

```ts
export type ConversationsFilter =
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed'
  | 'all';

export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  q?: string;
  cursor?: string;
  createdFrom?: string;
  createdTo?: string;
  statuses?: Exclude<ConversationsFilter, 'all' | 'mine'>[];
};
```

Add the six-queue default and a per-queue condition builder, right after `UNASSIGNED_STATUSES`:

```ts
const ALL_QUEUE_STATUSES: Exclude<ConversationsFilter, 'all' | 'mine'>[] = [
  'unassigned',
  'botHandling',
  'agentAssigned',
  'escalated',
  'resolved',
  'closed',
];

// Reused by the 'all' merged mode so a conversation only counts as
// resolved/closed there under the exact same 7-day-window + latest-cycle
// rule the dedicated resolved/closed queues already enforce — expressed as
// an EXISTS condition (not a join) so it composes into the single-query,
// no-row-multiplication shape the other five queues use.
function resolvedOrClosedCondition(tx: Tx, status: 'resolved' | 'closed') {
  const cycle = alias(resolutionCycle, `${status}_cycle`);
  const laterCycle = alias(resolutionCycle, `${status}_later_cycle`);
  const timestampCol = status === 'resolved' ? cycle.resolvedAt : cycle.closedAt;
  return and(
    eq(conversation.status, status),
    exists(
      tx
        .select({ one: sql`1` })
        .from(cycle)
        .where(
          and(
            eq(cycle.conversationId, conversation.id),
            isNotNull(timestampCol),
            sql`${timestampCol} >= now() - interval '7 days'`,
            notExists(
              tx
                .select({ one: sql`1` })
                .from(laterCycle)
                .where(
                  and(
                    eq(laterCycle.conversationId, cycle.conversationId),
                    sql`${laterCycle.cycleNo} > ${cycle.cycleNo}`,
                  ),
                ),
            ),
          ),
        ),
    ),
  );
}

function queueCondition(tx: Tx, queue: Exclude<ConversationsFilter, 'all' | 'mine'>) {
  switch (queue) {
    case 'unassigned':
      return and(
        isNull(conversation.assignedAgentId),
        inArray(conversation.status, UNASSIGNED_STATUSES),
      );
    case 'agentAssigned':
      return and(
        isNotNull(conversation.assignedAgentId),
        inArray(conversation.status, ACTIVE_AGENT_STATUSES),
      );
    case 'botHandling':
      return eq(conversation.status, 'bot_active');
    case 'escalated':
      return eq(conversation.status, 'escalated');
    case 'resolved':
      return resolvedOrClosedCondition(tx, 'resolved');
    case 'closed':
      return resolvedOrClosedCondition(tx, 'closed');
  }
}
```

Add cursor helpers next to the existing `encodeCursor`/`decodeStatusCursor` pair:

```ts
type AllCursor = { priority: string; activity: string; id: string };

function encodeAllCursor(payload: AllCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAllCursor(cursor: string): AllCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed?.priority === 'string' &&
      typeof parsed?.activity === 'string' &&
      typeof parsed?.id === 'string'
    ) {
      return parsed as AllCursor;
    }
    return null;
  } catch {
    return null;
  }
}
```

Add `listAllConversations`, right before `listResolvedOrClosedConversations`:

```ts
async function listAllConversations(
  ctx: AgentContext,
  extra: ConversationsListFilters,
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const statuses = extra.statuses?.length ? extra.statuses : ALL_QUEUE_STATUSES;
    // "Most recent activity" falls back to conversation.createdAt when there
    // are no messages yet — entering a state (creation) counts as activity
    // (see CLAUDE.md), and it keeps the sort/cursor comparison total, with no
    // NULLS-LAST branch to get wrong.
    const activity = sql<Date>`coalesce((select max(m.created_at) from message m where m.conversation_id = ${conversation.id}), ${conversation.createdAt})`;
    const activityMs = sql`date_trunc('millisecond', ${activity})`;
    const cursor = extra.cursor ? decodeAllCursor(extra.cursor) : null;
    // Priority ASC, activity DESC is a mixed-direction sort, so the keyset
    // condition can't be one tuple comparison like the single-direction
    // queues use — it's the three-branch OR form for a 2-column sort where
    // the columns disagree on direction.
    const cursorCondition = cursor
      ? sql`(
          ${conversation.priority} > ${cursor.priority}::conversation_priority
          or (${conversation.priority} = ${cursor.priority}::conversation_priority and ${activityMs} < ${cursor.activity}::timestamptz)
          or (${conversation.priority} = ${cursor.priority}::conversation_priority and ${activityMs} = ${cursor.activity}::timestamptz and ${conversation.id} < ${cursor.id}::uuid)
        )`
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
        activity,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .where(
        and(
          or(...statuses.map((queue) => queueCondition(tx, queue))),
          cursorCondition,
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(conversation.priority, desc(activityMs), desc(conversation.id))
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
        ? encodeAllCursor({
            priority: lastRow.priority,
            activity: lastRow.activity.toISOString(),
            id: lastRow.id,
          })
        : null;

    return { conversations: summaries, nextCursor };
  });
}
```

Wire the dispatcher (`listConversations`'s current first line):

```ts
export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<ConversationsPage> {
  if (filter === 'all') return listAllConversations(ctx, extra);
  if (filter === 'resolved' || filter === 'closed') {
    return listResolvedOrClosedConversations(ctx, filter, extra);
  }
  return withWorkspace(ctx.workspaceId, async (tx) => {
    // ...unchanged
```

In `conversationsController.ts`, extend `ConversationsQuery`:

```ts
const ConversationsQuery = z.object({
  status: z.enum([
    'unassigned',
    'mine',
    'agentAssigned',
    'botHandling',
    'escalated',
    'resolved',
    'closed',
    'all',
  ]),
  // ...priority/labelIds/subintentIds/assigneeIds/olderThanHours/q/cursor/createdFrom/createdTo unchanged from Task 1
  statuses: z
    .union([
      z.enum(['unassigned', 'agentAssigned', 'botHandling', 'escalated', 'resolved', 'closed']),
      z.array(z.enum(['unassigned', 'agentAssigned', 'botHandling', 'escalated', 'resolved', 'closed'])),
    ])
    .optional()
    .transform((v) => (v ? (Array.isArray(v) ? v : [v]) : undefined)),
});
```

In `openapi.ts`, mirror both the `'all'` enum value and the `statuses` param in the `/agent/conversations` query schema.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter backend test agent.conversations`
Expected: PASS

- [ ] **Step 5: Run the full backend suite and typecheck**

Run: `pnpm --filter backend test && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts backend/tests/agent.conversations.test.ts
git commit -m "Add merged 'all' conversations queue with status subset and priority/activity sort"
```

---

## Task 3: Frontend — shared queue options, `agentApi.ts` types and query builder

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/queues.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx:38-45` (`COLUMNS`, to build off the shared list instead of duplicating it)
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts:118-146` (`ConversationListFilter`, `TicketsQueryFilters`, `buildTicketsQuery`)
- Test: none new (covered by Task 4/5/6 tests exercising these through the UI); typecheck is the gate here.

**Interfaces:**
- Consumes: nothing new.
- Produces: `QUEUE_OPTIONS: { value: Exclude<ConversationListFilter, 'mine' | 'all'>; title: string }[]` — the single source of the six queue names, consumed by Task 5 (`TicketsFilterBar`'s Status filter) and Task 6 (`Tickets.tsx` board mode + list mode). `ConversationListFilter` gains `'all'`. `TicketsQueryFilters` gains `statuses?: string[]`, `createdFrom?: string`, `createdTo?: string`.

- [ ] **Step 1: Create the shared queue list**

```ts
// frontend/src/surfaces/agent-console/pages/Tickets/queues.ts
import type { ConversationListFilter } from '../../api/agentApi.ts';

export type BoardQueue = Exclude<ConversationListFilter, 'mine' | 'all'>;

export const QUEUE_OPTIONS: { value: BoardQueue; title: string }[] = [
  { value: 'unassigned', title: 'Unassigned' },
  { value: 'botHandling', title: 'Bot Handling' },
  { value: 'agentAssigned', title: 'Agent Assigned' },
  { value: 'escalated', title: 'Escalated' },
  { value: 'resolved', title: 'Resolved' },
  { value: 'closed', title: 'Closed' },
];
```

- [ ] **Step 2: Extend `agentApi.ts` types and query builder**

```ts
export type ConversationListFilter =
  | 'unassigned'
  | 'mine'
  | 'agentAssigned'
  | 'botHandling'
  | 'escalated'
  | 'resolved'
  | 'closed'
  | 'all';

export type TicketsQueryFilters = {
  q?: string;
  priority?: string[];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
  statuses?: string[];
  createdFrom?: string;
  createdTo?: string;
};

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
  if (filters?.statuses?.length) filters.statuses.forEach((s) => params.append('statuses', s));
  if (filters?.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters?.createdTo) params.set('createdTo', filters.createdTo);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}
```

- [ ] **Step 3: Point `Tickets.tsx`'s `COLUMNS` at the shared list**

```ts
import { QUEUE_OPTIONS } from './queues.ts';

const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] =
  QUEUE_OPTIONS.map((q) => ({
    title: q.title,
    filter: q.value,
    claimable: q.value === 'unassigned',
  }));
```

- [ ] **Step 4: Typecheck and run the existing frontend suite**

Run: `pnpm typecheck && pnpm --filter frontend test`
Expected: PASS — `Tickets.tsx`'s rendered column titles/order are unchanged (`QUEUE_OPTIONS` is in the same order as the old `COLUMNS` literal), so `Tickets.test.tsx` needs no changes.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/queues.ts frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Extract shared Tickets queue list, add 'all' filter and widened query params to agentApi"
```

---

## Task 4: Frontend — `useTicketsFilters`: `statuses`, `createdFrom`, `createdTo`, `view`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TicketsFilters.statuses: string[]`, `.createdFrom: string`, `.createdTo: string`, `.view: 'board' | 'list'` — consumed by Task 5 (`TicketsFilterBar`) and Task 6 (`Tickets.tsx`).

- [ ] **Step 1: Update the failing tests first**

Replace the four equality assertions in `useTicketsFilters.test.tsx` (each currently lists all fields) to include the four new ones, and add one new test for `view`:

```ts
describe('useTicketsFilters', () => {
  it('parses csv params from the URL', () => {
    const { result } = renderWithRouter('/tickets?priority=p1,p2&labelIds=abc');
    const [filters] = result.current;
    expect(filters.priority).toEqual(['p1', 'p2']);
    expect(filters.labelIds).toEqual(['abc']);
    expect(filters.q).toBe('');
  });

  it('defaults to empty filters with no params', () => {
    const { result } = renderWithRouter('/tickets');
    const [filters] = result.current;
    expect(filters).toEqual({
      q: '',
      priority: [],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
      view: 'board',
    });
  });

  it('merges a partial update into the current filters', () => {
    const { result } = renderWithRouter('/tickets?priority=p1');
    act(() => {
      const [, update] = result.current;
      update({ q: 'refund' });
    });
    const [filters] = result.current;
    expect(filters).toEqual({
      q: 'refund',
      priority: ['p1'],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
      view: 'board',
    });
  });

  it('drops a filter from the URL when set back to empty', () => {
    const { result } = renderWithRouter('/tickets?priority=p1');
    act(() => {
      const [, update] = result.current;
      update({ priority: [] });
    });
    const [filters] = result.current;
    expect(filters.priority).toEqual([]);
  });

  it('reads and updates the view param', () => {
    const { result } = renderWithRouter('/tickets?view=list');
    expect(result.current[0].view).toBe('list');
    act(() => {
      const [, update] = result.current;
      update({ view: 'board' });
    });
    expect(result.current[0].view).toBe('board');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter frontend test useTicketsFilters`
Expected: FAIL — actual `filters` object is missing the four new keys, and `view` isn't parsed.

- [ ] **Step 3: Implement the new fields**

```ts
import { useSearchParams } from 'react-router-dom';

export type TicketsFilters = {
  q: string;
  priority: string[];
  labelIds: string[];
  subintentIds: string[];
  assigneeIds: string[];
  olderThanHours: string;
  statuses: string[];
  createdFrom: string;
  createdTo: string;
  view: 'board' | 'list';
};

function parseCsv(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

export function useTicketsFilters(): [TicketsFilters, (next: Partial<TicketsFilters>) => void] {
  const [params, setParams] = useSearchParams();

  const filters: TicketsFilters = {
    q: params.get('q') ?? '',
    priority: parseCsv(params.get('priority')),
    labelIds: parseCsv(params.get('labelIds')),
    subintentIds: parseCsv(params.get('subintentIds')),
    assigneeIds: parseCsv(params.get('assigneeIds')),
    olderThanHours: params.get('olderThanHours') ?? '',
    statuses: parseCsv(params.get('statuses')),
    createdFrom: params.get('createdFrom') ?? '',
    createdTo: params.get('createdTo') ?? '',
    view: params.get('view') === 'list' ? 'list' : 'board',
  };

  function update(next: Partial<TicketsFilters>) {
    const merged = { ...filters, ...next };
    const nextParams = new URLSearchParams();
    if (merged.q) nextParams.set('q', merged.q);
    if (merged.priority.length) nextParams.set('priority', merged.priority.join(','));
    if (merged.labelIds.length) nextParams.set('labelIds', merged.labelIds.join(','));
    if (merged.subintentIds.length) nextParams.set('subintentIds', merged.subintentIds.join(','));
    if (merged.assigneeIds.length) nextParams.set('assigneeIds', merged.assigneeIds.join(','));
    if (merged.olderThanHours) nextParams.set('olderThanHours', merged.olderThanHours);
    if (merged.statuses.length) nextParams.set('statuses', merged.statuses.join(','));
    if (merged.createdFrom) nextParams.set('createdFrom', merged.createdFrom);
    if (merged.createdTo) nextParams.set('createdTo', merged.createdTo);
    if (merged.view === 'list') nextParams.set('view', 'list');
    setParams(nextParams, { replace: true });
  }

  return [filters, update];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter frontend test useTicketsFilters`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx
git commit -m "Add statuses, createdFrom, createdTo, and view fields to useTicketsFilters"
```

---

## Task 5: Frontend — `TicketsFilterBar`: Status multi-select and Created date range

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx`

**Interfaces:**
- Consumes: `QUEUE_OPTIONS` (Task 3), `TicketsFilters.statuses/createdFrom/createdTo` (Task 4), `MultiSelectFilter` (existing), `Input` (existing, `type="date"` supported natively).
- Produces: nothing new consumed elsewhere — this is a leaf UI component; `onChange` calls already flow into `useTicketsFilters`'s `update`.

- [ ] **Step 1: Write the failing tests**

Add to `TicketsFilterBar.test.tsx` (update `EMPTY_FILTERS` first, then add two tests):

```ts
const EMPTY_FILTERS = {
  q: '',
  priority: [],
  labelIds: [],
  subintentIds: [],
  assigneeIds: [],
  olderThanHours: '',
  statuses: [],
  createdFrom: '',
  createdTo: '',
  view: 'board' as const,
};
```

```ts
it('renders a Status filter control', () => {
  renderBar();
  expect(screen.getByRole('button', { name: /Status/ })).toBeInTheDocument();
});

it('toggling the Status Escalated option calls onChange with the selection', async () => {
  const { onChange } = renderBar();
  await userEvent.click(screen.getByRole('button', { name: /Status/ }));
  await userEvent.click(await screen.findByText('Escalated'));

  expect(onChange).toHaveBeenCalledWith({ statuses: ['escalated'] });
});

it('changing the Created-from date calls onChange', async () => {
  const { onChange } = renderBar();
  const [fromInput] = screen.getAllByLabelText(/Created from/i);
  await userEvent.type(fromInput, '2026-08-01');

  expect(onChange).toHaveBeenCalledWith({ createdFrom: '2026-08-01' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter frontend test TicketsFilterBar`
Expected: FAIL — no Status button, no "Created from" labeled input exist yet.

- [ ] **Step 3: Implement the two new controls**

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { fetchIntents, fetchTags, fetchWorkspaceAgents } from '../../api/agentApi.ts';
import { Input } from '../../components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import { MultiSelectFilter } from '../../components/MultiSelectFilter.tsx';
import { QUEUE_OPTIONS } from './queues.ts';
import type { TicketsFilters } from './useTicketsFilters.ts';

const PRIORITY_OPTIONS = [
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
  { value: 'p3', label: 'P3' },
  { value: 'p4', label: 'P4' },
];

const STATUS_OPTIONS = QUEUE_OPTIONS.map((q) => ({ value: q.value, label: q.title }));

const AGE_OPTIONS = [
  { value: 'any', label: 'Any age' },
  { value: '4', label: 'Older than 4 hours' },
  { value: '24', label: 'Older than 1 day' },
  { value: '72', label: 'Older than 3 days' },
];

const SEARCH_DEBOUNCE_MS = 300;

export function TicketsFilterBar({
  token,
  filters,
  onChange,
}: {
  token: string;
  filters: TicketsFilters;
  onChange: (next: Partial<TicketsFilters>) => void;
}) {
  const [searchInput, setSearchInput] = useState(filters.q);

  useEffect(() => setSearchInput(filters.q), [filters.q]);

  useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = setTimeout(() => onChange({ q: searchInput }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const tagsQuery = useQuery({ queryKey: ['tags', ''], queryFn: () => fetchTags(token) });
  const intentsQuery = useQuery({ queryKey: ['intents'], queryFn: () => fetchIntents(token) });
  const agentsQuery = useQuery({
    queryKey: ['workspaceAgents'],
    queryFn: () => fetchWorkspaceAgents(token),
  });

  const labelOptions = (tagsQuery.data ?? []).map((tag) => ({ value: tag.id, label: tag.name }));
  const subintentOptions = (intentsQuery.data?.intents ?? []).flatMap((intent) =>
    intent.subintents.map((sub) => ({ value: sub.id, label: `${intent.name} / ${sub.name}` })),
  );
  const agentOptions = (agentsQuery.data?.agents ?? []).map((a) => ({
    value: a.id,
    label: a.display_name,
  }));

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          placeholder="Search ticket #, player, or subintent..."
          className="w-64 pl-8"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>
      <MultiSelectFilter
        label="Status"
        options={STATUS_OPTIONS}
        selected={filters.statuses}
        onChange={(v) => onChange({ statuses: v })}
      />
      <MultiSelectFilter
        label="Priority"
        options={PRIORITY_OPTIONS}
        selected={filters.priority}
        onChange={(v) => onChange({ priority: v })}
      />
      <MultiSelectFilter
        label="Label"
        options={labelOptions}
        selected={filters.labelIds}
        onChange={(v) => onChange({ labelIds: v })}
      />
      <MultiSelectFilter
        label="Subintent"
        options={subintentOptions}
        selected={filters.subintentIds}
        onChange={(v) => onChange({ subintentIds: v })}
      />
      <MultiSelectFilter
        label="Assignee"
        options={agentOptions}
        selected={filters.assigneeIds}
        onChange={(v) => onChange({ assigneeIds: v })}
      />
      <Select
        value={filters.olderThanHours || 'any'}
        onValueChange={(v) => onChange({ olderThanHours: v === 'any' ? '' : v })}
      >
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label className="flex items-center gap-1 text-xs text-muted">
        Created from
        <Input
          aria-label="Created from"
          type="date"
          className="w-36"
          value={filters.createdFrom}
          onChange={(e) => onChange({ createdFrom: e.target.value })}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-muted">
        to
        <Input
          aria-label="Created to"
          type="date"
          className="w-36"
          value={filters.createdTo}
          onChange={(e) => onChange({ createdTo: e.target.value })}
        />
      </label>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter frontend test TicketsFilterBar`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx
git commit -m "Add Status and Created-date filters to TicketsFilterBar"
```

---

## Task 6: Frontend — `Tickets.tsx`: view toggle, status-filtered columns, merged `TicketsListView`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`

**Interfaces:**
- Consumes: `filters.view`/`filters.statuses`/`filters.createdFrom`/`filters.createdTo` (Task 4), `QUEUE_OPTIONS` (Task 3), `fetchInbox`/`claimConversation` (existing `agentApi.ts`), `ConversationRow` (existing, unchanged props).
- Produces: `TicketsListView` — a new, locally-scoped component in this file, not exported elsewhere (matches `QueueColumn`'s existing scoping).

- [ ] **Step 1: Write the failing tests**

Add to `Tickets.test.tsx`:

```ts
describe('Tickets view toggle', () => {
  it('defaults to board view with all six columns visible', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets');

    await screen.findByText('Unassigned');
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument();
  });

  it('switches to list view and fetches the merged "all" filter', async () => {
    const fetchInboxSpy = vi
      .mocked(agentApi.fetchInbox)
      .mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets?view=list');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith('tok', 'all', expect.anything(), undefined),
    );
    expect(screen.queryByText('Unassigned')).not.toBeInTheDocument();
  });

  it('hides board columns not in the Status filter', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    renderTickets('/tickets?statuses=unassigned');

    await screen.findByText('Unassigned');
    expect(screen.queryByText('Bot Handling')).not.toBeInTheDocument();
  });

  it('renders a claim action only for unassigned rows in list view', async () => {
    const row = (id: string, status: 'open' | 'escalated', assignedAgentId: string | null) => ({
      id,
      player: { external_player_id: id },
      status,
      confirm_phase: 'none' as const,
      last_message_preview: null,
      last_message_at: null,
      assigned_agent_id: assignedAgentId,
      assigned_agent_name: assignedAgentId ? 'Agent One' : null,
      priority: 'p3' as const,
      tags: [],
    });
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({
      conversations: [row('unassigned-1', 'open', null), row('escalated-1', 'escalated', 'a1')],
      nextCursor: null,
    });
    renderTickets('/tickets?view=list');

    await screen.findByText('unassigned-1');
    const claimButtons = await screen.findAllByRole('button', { name: 'Claim' });
    expect(claimButtons).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter frontend test Tickets.test`
Expected: FAIL — no Board/List toggle exists, `status: 'all'` is never requested, Status filter doesn't hide columns.

- [ ] **Step 3: Implement the toggle, column visibility, and `TicketsListView`**

Add near the top of `Tickets.tsx`, alongside `toQueryFilters`:

```ts
function toQueryFilters(f: ReturnType<typeof useTicketsFilters>[0]): TicketsQueryFilters {
  return {
    q: f.q || undefined,
    priority: f.priority.length ? f.priority : undefined,
    labelIds: f.labelIds.length ? f.labelIds : undefined,
    subintentIds: f.subintentIds.length ? f.subintentIds : undefined,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : undefined,
    olderThanHours: f.olderThanHours ? Number(f.olderThanHours) : undefined,
    statuses: f.statuses.length ? f.statuses : undefined,
    createdFrom: f.createdFrom || undefined,
    createdTo: f.createdTo || undefined,
  };
}

function hasActiveFilters(f: TicketsQueryFilters): boolean {
  return Boolean(
    f.q ||
      f.priority ||
      f.labelIds ||
      f.subintentIds ||
      f.assigneeIds ||
      f.olderThanHours ||
      f.statuses ||
      f.createdFrom ||
      f.createdTo,
  );
}
```

Add `TicketsListView`, a simplified sibling of `QueueColumn` (no resize/reorder/height-persistence — it's the only "column" in this view):

```tsx
function TicketsListView({
  token,
  queryFilters,
  onSelect,
}: {
  token: string;
  queryFilters: TicketsQueryFilters;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const queue = useInfiniteQuery({
    queryKey: ['tickets', 'all', queryFilters],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      fetchInbox(token, 'all', queryFilters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });

  const conversations = queue.data?.pages.flatMap((page) => page.conversations) ?? [];

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom && queue.hasNextPage && !queue.isFetchingNextPage) {
      void queue.fetchNextPage();
    }
  }

  return (
    <div
      style={{ height: '70vh' }}
      className="min-h-0 flex-1 overflow-y-auto rounded-card border border-slate-200 bg-surface"
      onScroll={handleScroll}
    >
      {conversations.length === 0 && !queue.isLoading && (
        <p className="p-3 text-xs text-muted">No tickets match your filters.</p>
      )}
      {conversations.map((conversation) => {
        const claimable =
          conversation.assigned_agent_id === null &&
          (conversation.status === 'open' || conversation.status === 'escalated');
        return (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={false}
            onSelect={() => onSelect(conversation.id)}
            onClaim={claimable ? () => claim.mutate(conversation.id) : undefined}
            claiming={claim.isPending}
          />
        );
      })}
      {queue.isFetchingNextPage && <p className="p-3 text-xs text-muted">Loading more...</p>}
      {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
    </div>
  );
}
```

In the `Tickets` component: add the view toggle next to the filter bar, gate column visibility by `filters.statuses`, and branch the body on `filters.view`:

```tsx
      <div className="mb-4 flex items-center gap-4">
        <TicketsFilterBar token={session.token} filters={filters} onChange={updateFilters} />
        <div className="flex shrink-0 gap-1 rounded-md border border-slate-200 p-0.5">
          <button
            type="button"
            aria-pressed={filters.view === 'board'}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium',
              filters.view === 'board' ? 'bg-accent-soft text-accent-fg' : 'text-muted',
            )}
            onClick={() => updateFilters({ view: 'board' })}
          >
            Board
          </button>
          <button
            type="button"
            aria-pressed={filters.view === 'list'}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium',
              filters.view === 'list' ? 'bg-accent-soft text-accent-fg' : 'text-muted',
            )}
            onClick={() => updateFilters({ view: 'list' })}
          >
            List
          </button>
        </div>
      </div>
      {filters.view === 'list' ? (
        <TicketsListView
          token={session.token}
          queryFilters={queryFilters}
          onSelect={(id) => navigate(`/tickets/${id}`)}
        />
      ) : (
        <>
          {!filtersActive &&
            summaryQueries.every((q) => q.data) &&
            summaryQueries.every((q) => q.data!.conversations.length === 0) && (
              <EmptyState message="Nothing to show" />
            )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={columnOrder} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                {[
                  columnOrder.filter((_, i) => i % 2 === 0),
                  columnOrder.filter((_, i) => i % 2 === 1),
                ].map((filters_, columnIndex) => (
                  <div key={columnIndex} className="flex flex-col gap-4">
                    {filters_.map((filter) => {
                      const col = COLUMNS.find((c) => c.filter === filter)!;
                      const queryIndex = COLUMNS.findIndex((c) => c.filter === filter);
                      const summaryQuery = summaryQueries[queryIndex];
                      const emptyAndUnfiltered = Boolean(
                        summaryQuery?.data &&
                          summaryQuery.data.conversations.length === 0 &&
                          !filtersActive,
                      );
                      const excludedByStatusFilter =
                        filters.statuses.length > 0 && !filters.statuses.includes(filter);
                      if (emptyAndUnfiltered || excludedByStatusFilter) return null;

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
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </>
      )}
```

(The inner `.map((filters, columnIndex) => ...)` callback param is renamed `filters_` here purely to avoid shadowing the outer `filters` from `useTicketsFilters` that `excludedByStatusFilter` now needs — the existing code already shadowed it harmlessly since it never referenced the outer one before.)

Add the `cn` import used by the toggle buttons: `import { cn } from '../../../../lib/cn.ts';` (same relative depth as other shared imports already in this file — confirm against an existing `cn` import elsewhere in `pages/Tickets/` or `pages/Inbox/` and match it exactly).

In the existing `conversation:changed` socket handler inside `Tickets()` (the `useEffect` that builds `filtersToInvalidate` and invalidates `['tickets', filter]` per status), add one unconditional invalidation of the merged list — any status change can affect which rows the `'all'` query returns, so unlike the five status-specific branches there's no cheap way to know in advance whether it applies:

```ts
        for (const filter of filtersToInvalidate)
          void queryClient.invalidateQueries({ queryKey: ['tickets', filter] });
        void queryClient.invalidateQueries({ queryKey: ['tickets', 'all'] });
        const changedId = payload.conversation_id;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter frontend test Tickets.test`
Expected: PASS

- [ ] **Step 5: Run the full frontend suite, typecheck, and lint**

Run: `pnpm --filter frontend test && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: Manually verify in the browser**

Run: `pnpm dev`, open the agent console's Tickets page.
- Toggle to List view with no filters — confirm one merged, scrollable list appears sorted priority-first.
- Apply a Status filter of just "Escalated" in Board view — confirm only the Escalated column renders.
- Apply the same Status filter in List view — confirm only escalated tickets appear.
- Set a Created-date range spanning today — confirm today's tickets still show; a range excluding today confirms the list/columns go empty with "No tickets match your filters."
- Claim a ticket from List view — confirm it disappears from the merged list's unassigned rows.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx
git commit -m "Add Board/List view toggle and merged TicketsListView to the Tickets page"
```
