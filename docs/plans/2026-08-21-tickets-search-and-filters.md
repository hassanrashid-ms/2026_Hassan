# Tickets search and filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search bar and structured filters (priority, label, subintent, assignee, age) above the Tickets board that narrow all four queue columns at once, without changing which columns exist or how they're defined.

**Architecture:** Search/filter state lives in the URL. `GET /agent/conversations` gains optional query params that AND onto whatever `status` mode a column is already querying. A new `GET /agent/agents` endpoint supplies the assignee filter's options (no such endpoint exists yet). The frontend filter bar reads/writes the URL and feeds the same params into all four columns' existing per-column `useQuery` calls, so TanStack Query's cache keying and the existing socket-driven `invalidateQueries` calls keep working unmodified — a changed conversation is refetched with whatever filters are currently active.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (Postgres) on the backend; React + TanStack Query + react-router-dom `useSearchParams` + shadcn/ui (Popover/Command) on the frontend.

## Global Constraints

- No vector search, no `tsvector`, no message-body search — `q` matches only ticket number, player `external_player_id`, and subintent name.
- No player-state field filtering.
- No saved/named views — filter state is URL-only, not persisted server-side.
- Register every new/changed endpoint's query params in `backend/src/docs/openapi.ts` (repo convention).
- Never `console.*` — use `logger` if any logging is needed (none is expected in this plan).
- Tailwind v4 utility classes only for any new markup — no hand-written CSS.

---

## Task 1: Structured filters on `listConversations` (priority, label, subintent, assignee, age)

**Files:**

- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/docs/openapi.ts:437-447` (the `/agent/conversations` `registerPath`)
- Modify: `backend/tests/helpers/db.ts:119-155` (`seedConversation`)
- Modify: `backend/tests/agent.conversations.test.ts`

**Interfaces:**

- Produces: `ConversationsListFilters` type from `conversationsService.ts`:

  ```ts
  export type ConversationsListFilters = {
    priority?: ('p1' | 'p2' | 'p3' | 'p4')[];
    labelIds?: string[];
    subintentIds?: string[];
    assigneeIds?: string[];
    olderThanHours?: number;
  };
  ```

  and `listConversations(ctx: AgentContext, filter: ConversationsFilter, extra?: ConversationsListFilters): Promise<AgentConversationSummary[]>` — `extra` is optional and defaults to `{}`, so every existing call site (there are none outside `conversationsController.ts`) keeps compiling unchanged.

- [ ] **Step 1: Extend `seedConversation` to accept `priority` and `subintentId`**

In `backend/tests/helpers/db.ts`, the `seedConversation` args type and insert currently don't set `priority` or `subintent_id`. Add both:

```ts
export async function seedConversation(args: {
  workspaceId: string;
  playerId: string;
  sessionId?: string | null;
  createdAt?: Date;
  status?: 'new' | 'bot_active' | 'open' | 'awaiting_player' | 'escalated' | 'resolved' | 'closed';
  confirmPhase?: 'none' | 'bot_article' | 'agent_ask' | 'form' | 'inactivity_ask';
  assignedAgentId?: string | null;
  resolutionSource?: 'bot' | 'agent' | 'player_confirmed' | 'timed_out' | null;
  priority?: 'p1' | 'p2' | 'p3' | 'p4';
  subintentId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const { rows } = await ownerPool.query<{ ticket_seq: number }>(
    `update workspace set ticket_seq = ticket_seq + 1 where id = $1 returning ticket_seq`,
    [args.workspaceId],
  );
  const number = rows[0]!.ticket_seq;
  await ownerPool.query(
    `insert into conversation
       (id, workspace_id, player_id, session_id, number, created_at, status, confirm_phase, assigned_agent_id, resolution_source, priority, subintent_id)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), coalesce($7::conversation_status, 'bot_active'), coalesce($8::confirm_phase, 'none'), $9, $10::resolution_source, coalesce($11::conversation_priority, 'p3'), $12)`,
    [
      id,
      args.workspaceId,
      args.playerId,
      args.sessionId ?? null,
      number,
      args.createdAt ?? null,
      args.status ?? null,
      args.confirmPhase ?? null,
      args.assignedAgentId ?? null,
      args.resolutionSource ?? null,
      args.priority ?? null,
      args.subintentId ?? null,
    ],
  );
  return id;
}
```

- [ ] **Step 2: Write failing tests for each new filter param**

Add to `backend/tests/agent.conversations.test.ts`, inside a new `describe('GET /agent/conversations filters', ...)` block (add this describe block after the existing `describe('GET /agent/conversations', ...)` block, before `describe('POST /agent/conversations/:id/claim', ...)`):

```ts
describe('GET /agent/conversations filters', () => {
  it('filters by priority', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const p1Id = await seedConversation({ workspaceId, playerId, priority: 'p1' });
    await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', priority: 'p1' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([p1Id]);
  });

  it('filters by label', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const taggedId = await seedConversation({ workspaceId, playerId });
    await seedConversation({ workspaceId, playerId });
    const { rows: tagRows } = await ownerPool.query<{ id: string }>(
      `insert into tag (workspace_id, name, normalized_name, color_index) values ($1, 'Billing', 'billing', 0) returning id`,
      [workspaceId],
    );
    const tagId = tagRows[0]!.id;
    await ownerPool.query(
      `insert into conversation_tag (workspace_id, conversation_id, tag_id) values ($1, $2, $3)`,
      [workspaceId, taggedId, tagId],
    );
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', labelIds: tagId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([taggedId]);
  });

  it('filters by subintent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent(workspaceId);
    const subintentId = await seedSubintent({ workspaceId, intentId });
    const matchingId = await seedConversation({ workspaceId, playerId, subintentId });
    await seedConversation({ workspaceId, playerId });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', subintentIds: subintentId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([matchingId]);
  });

  it('filters agentAssigned down to specific assignees', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await setupAgent(workspaceId);
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent2@example.test', 'Agent Two') returning id`,
    );
    const agentBId = rows[0]!.id;
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, agentBId],
    );
    const conversationA = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: agentA.agentId,
    });
    await seedConversation({ workspaceId, playerId, status: 'open', assignedAgentId: agentBId });

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'agentAssigned', assigneeIds: agentA.agentId })
      .set('Authorization', `Bearer ${agentA.token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([conversationA]);
  });

  it('combines priority and label filters with AND', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const matchingId = await seedConversation({ workspaceId, playerId, priority: 'p1' });
    const wrongPriorityId = await seedConversation({ workspaceId, playerId, priority: 'p3' });
    const { rows: tagRows } = await ownerPool.query<{ id: string }>(
      `insert into tag (workspace_id, name, normalized_name, color_index) values ($1, 'Billing', 'billing', 0) returning id`,
      [workspaceId],
    );
    const tagId = tagRows[0]!.id;
    await ownerPool.query(
      `insert into conversation_tag (workspace_id, conversation_id, tag_id) values ($1, $2, $3), ($1, $4, $3)`,
      [workspaceId, matchingId, tagId, wrongPriorityId],
    );
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', priority: 'p1', labelIds: tagId })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([matchingId]);
  });

  it('filters out conversations whose last message is not older than the threshold', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const oldId = await seedConversation({ workspaceId, playerId });
    const recentId = await seedConversation({ workspaceId, playerId });
    const now = new Date();
    await seedMessage({
      workspaceId,
      conversationId: oldId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(now.getTime() - 10 * 60 * 60 * 1000),
    } as never);
    await seedMessage({ workspaceId, conversationId: recentId, seq: 1, authorType: 'player' });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'unassigned', olderThanHours: '4' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([oldId]);
  });
});
```

Add `seedIntent` and `seedSubintent` to that file's existing import from `./helpers/db.ts` (they already exist in the helper, just not yet imported here).

The last test (`olderThanHours`) passes a `createdAt` to `seedMessage`, which the helper does not currently accept — extend `seedMessage` in `backend/tests/helpers/db.ts` to take an optional `createdAt?: Date`, defaulting to `now()` exactly like `seedConversation` does, and drop the `as never` cast from the test once that's in place:

```ts
export async function seedMessage(args: {
  workspaceId: string;
  conversationId: string;
  seq: number;
  authorType: 'player' | 'agent' | 'bot' | 'system';
  visibility?: 'public' | 'internal';
  deliveryState?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  body?: string;
  createdAt?: Date;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into message (id, workspace_id, conversation_id, seq, author_type, visibility, delivery_state, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.seq,
      args.authorType,
      args.visibility ?? 'public',
      args.deliveryState ?? 'sent',
      args.body ?? 'test message',
      args.createdAt ?? null,
    ],
  );
  return id;
}
```

Then remove `as never` from the `olderThanHours` test's two `seedMessage` calls.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter backend test agent.conversations.test.ts`
Expected: the five new tests fail — either a 422 from the Zod schema rejecting unknown query params, or the filters simply having no effect (both rows returned instead of one).

- [ ] **Step 4: Implement the filters in `conversationsService.ts`**

Replace the full contents of `backend/src/agent/services/conversationsService.ts` lines 1–76 with:

```ts
import { and, desc, eq, exists, ilike, inArray, isNull, isNotNull, or, sql } from 'drizzle-orm';
import type { AgentConversationSummary, AgentMessageView } from '@support/types';
import {
  postMessage,
  toAgentView,
  type PostedMessageRow,
} from '../../domain/conversations/index.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import {
  agent,
  conversation,
  conversationTag,
  message,
  player,
} from '../../shared/db/schema/index.ts';
import { withWorkspace, type Tx } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { getConversationTags } from './tagsService.ts';

export type ConversationsFilter =
  'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated';

export type ConversationsListFilters = {
  priority?: (typeof conversation.priority.enumValues)[number][];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  /** Keeps only conversations whose last message is strictly older than this many hours. */
  olderThanHours?: number;
  /** Matches ticket number, player external id, or subintent name. */
  q?: string;
};

// The inbox is a work queue, not an archive — a finished ticket is noise there,
// and its history stays reachable through the context rail. A reopen flips the
// status back to `open`, so it returns to the queue on its own.
const ACTIVE_AGENT_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'open',
  'awaiting_player',
  'escalated',
];
const UNASSIGNED_STATUSES: (typeof conversation.status.enumValues)[number][] = [
  'open',
  'escalated',
];

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
  return conditions;
}

export async function listConversations(
  ctx: AgentContext,
  filter: ConversationsFilter,
  extra: ConversationsListFilters = {},
): Promise<AgentConversationSummary[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalPlayerId: player.externalId,
        confirmPhase: conversation.confirmPhase,
        assignedAgentId: conversation.assignedAgentId,
        assignedAgentName: agent.displayName,
        priority: conversation.priority,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
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
          ...extraFilterConditions(extra),
        ),
      )
      .orderBy(conversation.priority, conversation.createdAt);

    // One extra query per row for the last-message preview. Fine at this
    // slice's inbox size; a lateral join is the fix if the inbox ever grows
    // large enough for this to matter.
    const summaries: AgentConversationSummary[] = [];
    for (const row of rows) {
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

    // Computed from the same per-row last-message lookup above, not pushed
    // into the main WHERE — there is no materialized last-message timestamp
    // on `conversation` to filter on there. A conversation with no messages
    // at all can't be "older than" anything, so it's excluded rather than
    // treated as infinitely old.
    if (extra.olderThanHours !== undefined) {
      const cutoff = Date.now() - extra.olderThanHours * 60 * 60 * 1000;
      return summaries.filter(
        (s) => s.last_message_at !== null && new Date(s.last_message_at).getTime() < cutoff,
      );
    }
    return summaries;
  });
}
```

(`ilike` and `or` are imported here already because Task 2 needs them in this same file; they're unused after Task 1 alone, which `pnpm typecheck` does not flag — this repo has no `noUnusedLocals`. If running a linter standalone after this task only, drop `ilike`/`or` from the import list until Task 2 adds their usage.)

Leave the rest of the file (`claimConversation`, `takeOverConversation`, `postTakenOverNotice`, `getAgentConversationMessages`) untouched.

- [ ] **Step 5: Update the controller's Zod schema**

In `backend/src/agent/controllers/conversationsController.ts`, replace line 12:

```ts
const ConversationsQuery = z.object({
  status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
});
```

with:

```ts
const PRIORITY_VALUES = ['p1', 'p2', 'p3', 'p4'] as const;

const csvUuids = z
  .string()
  .transform((v) => v.split(',').filter(Boolean))
  .pipe(z.array(z.uuid()))
  .optional();

const csvPriorities = z
  .string()
  .transform((v) => v.split(',').filter(Boolean))
  .pipe(z.array(z.enum(PRIORITY_VALUES)))
  .optional();

const ConversationsQuery = z.object({
  status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
  priority: csvPriorities,
  labelIds: csvUuids,
  subintentIds: csvUuids,
  assigneeIds: csvUuids,
  olderThanHours: z.coerce.number().positive().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});
```

And replace the handler body (lines 15-24):

```ts
export const listConversationsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const query = ConversationsQuery.safeParse(req.query);
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'status must be a supported conversation filter.');
    return;
  }
  const { status, ...extra } = query.data;
  const conversations = await listConversations(ctx, status, extra);
  res.status(200).json({ conversations });
};
```

- [ ] **Step 6: Register the new query params in the OpenAPI spec**

In `backend/src/docs/openapi.ts`, replace line 442:

```ts
    query: z.object({ status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling']) }),
```

with:

```ts
    query: z.object({
      status: z.enum(['unassigned', 'mine', 'agentAssigned', 'botHandling', 'escalated']),
      priority: z.string().optional().openapi({ description: 'Comma-separated priority values (p1-p4).' }),
      labelIds: z.string().optional().openapi({ description: 'Comma-separated tag ids.' }),
      subintentIds: z.string().optional().openapi({ description: 'Comma-separated subintent ids.' }),
      assigneeIds: z.string().optional().openapi({ description: 'Comma-separated agent ids.' }),
      olderThanHours: z.coerce.number().optional().openapi({ description: 'Keeps only conversations whose last message is older than this many hours.' }),
      q: z.string().optional().openapi({ description: 'Matches ticket number, player external id, or subintent name.' }),
    }),
```

(This also fixes a pre-existing bug: the OpenAPI schema was missing `escalated`, which the Zod schema in the controller already accepted.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter backend test agent.conversations.test.ts`
Expected: PASS, including the pre-existing tests in that file (unaffected by the optional `extra` param).

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts backend/tests/helpers/db.ts backend/tests/agent.conversations.test.ts
git commit -m "Add priority, label, subintent, assignee, and age filters to agent conversations list"
```

---

## Task 2: Free-text search (`q`) on `listConversations`

**Files:**

- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/tests/agent.conversations.test.ts`

**Interfaces:**

- Consumes: `ConversationsListFilters.q` (already added to the type in Task 1), `extraFilterConditions` (already defined in Task 1).
- Produces: nothing new — `q` becomes a fully wired filter on the same `listConversations` signature from Task 1.

- [ ] **Step 1: Write failing tests**

Add to the `describe('GET /agent/conversations filters', ...)` block from Task 1:

```ts
it('search matches by ticket number', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const firstId = await seedConversation({ workspaceId, playerId });
  await seedConversation({ workspaceId, playerId });
  const { rows } = await ownerPool.query<{ number: number }>(
    'select number from conversation where id = $1',
    [firstId],
  );
  const { token } = await setupAgent(workspaceId);

  const res = await request(app)
    .get('/conversations')
    .query({ status: 'unassigned', q: String(rows[0]!.number) })
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([firstId]);
});

it('search matches by player external id', async () => {
  const workspaceId = await seedWorkspace();
  const targetPlayer = await seedPlayer(workspaceId, 'player-magpie');
  const otherPlayer = await seedPlayer(workspaceId, 'player-other');
  const matchingId = await seedConversation({ workspaceId, playerId: targetPlayer });
  await seedConversation({ workspaceId, playerId: otherPlayer });
  const { token } = await setupAgent(workspaceId);

  const res = await request(app)
    .get('/conversations')
    .query({ status: 'unassigned', q: 'magpie' })
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([matchingId]);
});

it('search matches by subintent name', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const intentId = await seedIntent(workspaceId);
  const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Double charge' });
  const matchingId = await seedConversation({ workspaceId, playerId, subintentId });
  await seedConversation({ workspaceId, playerId });
  const { token } = await setupAgent(workspaceId);

  const res = await request(app)
    .get('/conversations')
    .query({ status: 'unassigned', q: 'double charge' })
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual([matchingId]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test agent.conversations.test.ts`
Expected: the three new tests fail — `q` is accepted by the Zod schema (from Task 1) but has no effect yet, so both seeded conversations come back.

- [ ] **Step 3: Implement `q` in `conversationsService.ts`**

Add a `subintent` import and a search-condition builder, then wire it into the query. In `backend/src/agent/services/conversationsService.ts`:

Change the schema import line to also pull in `subintent`:

```ts
import {
  agent,
  conversation,
  conversationTag,
  message,
  player,
  subintent,
} from '../../shared/db/schema/index.ts';
```

Add this function next to `extraFilterConditions`:

```ts
function searchCondition(q: string) {
  const trimmed = q.trim();
  const numericPrefix = trimmed.replace(/^#/, '');
  const conditions = [
    ilike(player.externalId, `%${trimmed}%`),
    ilike(subintent.name, `%${trimmed}%`),
  ];
  if (/^\d+$/.test(numericPrefix)) {
    conditions.push(sql`${conversation.number}::text like ${numericPrefix + '%'}`);
  }
  return or(...conditions);
}
```

Add `or` to the drizzle-orm import line (already imports `and, asc, desc, eq, exists, ilike, inArray, isNull, isNotNull, lt, sql` from Task 1 — add `or` to that list).

In `extraFilterConditions`, append the search condition:

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
  if (extra.q) conditions.push(searchCondition(extra.q));
  return conditions;
}
```

And add a `leftJoin` with `subintent` in the main query in `listConversations`, right after the existing `leftJoin(agent, ...)`:

```ts
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test agent.conversations.test.ts`
Expected: PASS, all tests in the file including Task 1's.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/agent/services/conversationsService.ts backend/tests/agent.conversations.test.ts
git commit -m "Add free-text search over ticket number, player id, and subintent name"
```

---

## Task 3: `GET /agent/agents` endpoint (assignee filter options)

There is no existing endpoint that lists an agent's teammates within a workspace — `fetchDevAgents` only lists dev-login candidates, unscoped to a workspace. This task adds one, following the same service/controller/router split as `tagsService.ts`/`tagsController.ts`/`tagsRouter.ts`.

**Files:**

- Create: `backend/src/agent/services/agentsService.ts`
- Create: `backend/src/agent/controllers/agentsController.ts`
- Create: `backend/src/agent/routers/agentsRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Create: `backend/tests/agent.agents.test.ts`

**Interfaces:**

- Produces: `listWorkspaceAgents(ctx: AgentContext): Promise<{ id: string; display_name: string }[]>` from `agentsService.ts`; route `GET /agent/agents` returning `{ agents: { id: string; display_name: string }[] }`.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/agent.agents.test.ts`:

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { agentsRouter } from '../src/agent/routers/agentsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedWorkspace,
  truncateAll,
  seedWorkspaceMember,
} from './helpers/db.ts';

// Unlike conversationsRouter's handlers, agentsController never calls
// getIo() — no socket server needs to exist for this file's process.
const app = express();
app.use(express.json());
app.use(requireAgentSession, agentsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentWithMembership(
  workspaceId: string,
  displayName: string,
  opts: {
    role?: 'agent' | 'team_lead' | 'admin';
    status?: 'active' | 'on_leave' | 'deactivated';
    deactivatedAt?: Date | null;
  } = {},
) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, status) values ($1, $2, $3) returning id`,
    [
      `${displayName.toLowerCase().replace(/\s+/g, '.')}@example.test`,
      displayName,
      opts.status ?? 'active',
    ],
  );
  const agentId = rows[0]!.id;
  await seedWorkspaceMember({
    workspaceId,
    agentId,
    role: opts.role ?? 'agent',
    deactivatedAt: opts.deactivatedAt ?? null,
  });
  return agentId;
}

describe('GET /agent/agents', () => {
  it('lists active agents in the workspace by display name', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentWithMembership(workspaceId, 'Sarah Chen');
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });

    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.agents).toEqual([{ id: agentId, display_name: 'Sarah Chen' }]);
  });

  it('excludes agents from other workspaces', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const agentId = await seedAgentWithMembership(workspaceA, 'Sarah Chen');
    await seedAgentWithMembership(workspaceB, 'Other Workspace Agent');
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceA });

    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.agents.map((a: { id: string }) => a.id)).toEqual([agentId]);
  });

  it('excludes deactivated memberships', async () => {
    const workspaceId = await seedWorkspace();
    const activeId = await seedAgentWithMembership(workspaceId, 'Active Agent');
    await seedAgentWithMembership(workspaceId, 'Deactivated Agent', { deactivatedAt: new Date() });
    const token = await signAgentSession({ agent_id: activeId, workspace_id: workspaceId });

    const res = await request(app)
      .get('/agents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.agents.map((a: { id: string }) => a.id)).toEqual([activeId]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend test agent.agents.test.ts`
Expected: FAIL — `backend/src/agent/routers/agentsRouter.ts` does not exist yet, so the import fails.

- [ ] **Step 3: Implement the service**

Create `backend/src/agent/services/agentsService.ts`:

```ts
import { and, asc, eq, isNull } from 'drizzle-orm';
import { agent, workspaceMember } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

export type WorkspaceAgentOption = { id: string; display_name: string };

export async function listWorkspaceAgents(ctx: AgentContext): Promise<WorkspaceAgentOption[]> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx
      .select({ id: agent.id, displayName: agent.displayName })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(and(isNull(workspaceMember.deactivatedAt), eq(agent.status, 'active')))
      .orderBy(asc(agent.displayName));
    return rows.map((r) => ({ id: r.id, display_name: r.displayName }));
  });
}
```

`workspaceMember` is scoped by `workspace_id` under RLS the same way every other scoped table is — `withWorkspace` sets `app.workspace_id` for the transaction, so no explicit `eq(workspaceMember.workspaceId, ctx.workspaceId)` is needed, matching the pattern in `conversationsService.ts`.

- [ ] **Step 4: Implement the controller**

Create `backend/src/agent/controllers/agentsController.ts`:

```ts
import type { RequestHandler } from 'express';
import { listWorkspaceAgents } from '../services/agentsService.ts';

export const listAgentsHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const agents = await listWorkspaceAgents(ctx);
  res.status(200).json({ agents });
};
```

- [ ] **Step 5: Implement the router and register it**

Create `backend/src/agent/routers/agentsRouter.ts`:

```ts
import { Router } from 'express';
import { listAgentsHandler } from '../controllers/agentsController.ts';

export const agentsRouter = Router();
agentsRouter.get('/agents', listAgentsHandler);
```

In `backend/src/agent/router.ts`, add the import and registration alongside the other routers:

```ts
import { agentsRouter } from './routers/agentsRouter.ts';
```

```ts
agentRouter.use(agentsRouter);
```

(add both lines next to the existing `tagsRouter` import/use, keeping the same grouping style)

- [ ] **Step 6: Register the endpoint in OpenAPI**

In `backend/src/docs/openapi.ts`, add a new `registerPath` call near the `/agent/conversations` one (after its closing `})` at line 447):

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/agents',
  summary: 'Agent List Workspace Agents',
  description: 'Lists active agents in the workspace, for populating an assignee filter or picker.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Workspace agents',
      content: {
        'application/json': {
          schema: z.object({
            agents: z.array(z.object({ id: z.uuid(), display_name: z.string() })),
          }),
        },
      },
    },
  },
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter backend test agent.agents.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/agent/services/agentsService.ts backend/src/agent/controllers/agentsController.ts backend/src/agent/routers/agentsRouter.ts backend/src/agent/router.ts backend/src/docs/openapi.ts backend/tests/agent.agents.test.ts
git commit -m "Add GET /agent/agents endpoint for the tickets assignee filter"
```

---

## Task 4: Frontend API client additions

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: nothing new from earlier tasks (calls the endpoints from Tasks 1-3 by URL).
- Produces:
  ```ts
  export type TicketsQueryFilters = {
    q?: string;
    priority?: string[];
    labelIds?: string[];
    subintentIds?: string[];
    assigneeIds?: string[];
    olderThanHours?: number;
  };
  export type WorkspaceAgentOption = { id: string; display_name: string };
  export function fetchInbox(
    token: string,
    status: ConversationListFilter,
    filters?: TicketsQueryFilters,
  ): Promise<AgentConversationsResponse>;
  export function fetchWorkspaceAgents(token: string): Promise<{ agents: WorkspaceAgentOption[] }>;
  ```

There is no test file for `agentApi.ts` itself (existing tests mock it wholesale via `vi.mock`); this task is verified through the frontend tests in Tasks 5 and 6, which exercise these functions indirectly. Because that leaves this task with no test of its own, keep the change small and mechanical to keep review cheap.

- [ ] **Step 1: Add the query-string builder and extend `fetchInbox`**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, replace lines 64-68:

```ts
export type ConversationListFilter =
  'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated';

export function fetchInbox(
  token: string,
  status: ConversationListFilter,
): Promise<AgentConversationsResponse> {
  return apiCall(`/agent/conversations?status=${status}`, token);
}
```

with:

```ts
export type ConversationListFilter =
  'unassigned' | 'mine' | 'agentAssigned' | 'botHandling' | 'escalated';

export type TicketsQueryFilters = {
  q?: string;
  priority?: string[];
  labelIds?: string[];
  subintentIds?: string[];
  assigneeIds?: string[];
  olderThanHours?: number;
};

function buildTicketsQuery(status: ConversationListFilter, filters?: TicketsQueryFilters): string {
  const params = new URLSearchParams({ status });
  if (filters?.q) params.set('q', filters.q);
  if (filters?.priority?.length) params.set('priority', filters.priority.join(','));
  if (filters?.labelIds?.length) params.set('labelIds', filters.labelIds.join(','));
  if (filters?.subintentIds?.length) params.set('subintentIds', filters.subintentIds.join(','));
  if (filters?.assigneeIds?.length) params.set('assigneeIds', filters.assigneeIds.join(','));
  if (filters?.olderThanHours) params.set('olderThanHours', String(filters.olderThanHours));
  return params.toString();
}

export function fetchInbox(
  token: string,
  status: ConversationListFilter,
  filters?: TicketsQueryFilters,
): Promise<AgentConversationsResponse> {
  return apiCall(`/agent/conversations?${buildTicketsQuery(status, filters)}`, token);
}
```

This keeps every existing call site (`Inbox.tsx`, `ConversationList.tsx`, their tests) compiling unchanged — `filters` is optional and omitting it produces the exact same query string as before (`status=<value>`).

- [ ] **Step 2: Add `fetchWorkspaceAgents`**

Add near `fetchIntents` (after line 119's closing brace, i.e. right before `export function fetchTags`):

```ts
export type WorkspaceAgentOption = { id: string; display_name: string };

export function fetchWorkspaceAgents(token: string): Promise<{ agents: WorkspaceAgentOption[] }> {
  return apiCall('/agent/agents', token);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Extend fetchInbox with optional filters and add fetchWorkspaceAgents"
```

---

## Task 5: `MultiSelectFilter` component and `useTicketsFilters` URL-state hook

**Files:**

- Create: `frontend/src/surfaces/agent-console/components/MultiSelectFilter.tsx`
- Create: `frontend/src/surfaces/agent-console/components/MultiSelectFilter.test.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts`
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx`

**Interfaces:**

- Produces:

  ```ts
  export type MultiSelectOption = { value: string; label: string };
  export function MultiSelectFilter(props: {
    label: string;
    options: MultiSelectOption[];
    selected: string[];
    onChange: (next: string[]) => void;
  }): JSX.Element;
  ```

  and

  ```ts
  export type TicketsFilters = {
    q: string;
    priority: string[];
    labelIds: string[];
    subintentIds: string[];
    assigneeIds: string[];
    olderThanHours: string;
  };
  export function useTicketsFilters(): [TicketsFilters, (next: Partial<TicketsFilters>) => void];
  ```

- [ ] **Step 1: Write the failing test for `MultiSelectFilter`**

Create `frontend/src/surfaces/agent-console/components/MultiSelectFilter.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MultiSelectFilter } from './MultiSelectFilter.tsx';

const OPTIONS = [
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
];

describe('MultiSelectFilter', () => {
  it('shows the selected count on the trigger', () => {
    render(
      <MultiSelectFilter label="Priority" options={OPTIONS} selected={['p1']} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: /Priority/ })).toHaveTextContent('(1)');
  });

  it('adds a value when an unselected option is clicked', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter label="Priority" options={OPTIONS} selected={[]} onChange={onChange} />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith(['p1']);
  });

  it('removes a value when an already-selected option is clicked', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="Priority"
        options={OPTIONS}
        selected={['p1', 'p2']}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith(['p2']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend test MultiSelectFilter`
Expected: FAIL — `MultiSelectFilter.tsx` doesn't exist yet.

- [ ] **Step 3: Implement `MultiSelectFilter`**

Create `frontend/src/surfaces/agent-console/components/MultiSelectFilter.tsx`:

```tsx
import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button } from './ui/button.tsx';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from './ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.tsx';
import { cn } from '../lib/cn.ts';

export type MultiSelectOption = { value: string; label: string };

export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {label}
          {selected.length > 0 && (
            <span className="ml-1 text-xs text-muted">({selected.length})</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0" align="start">
        <Command>
          <CommandList>
            {options.length === 0 && <CommandEmpty>No options.</CommandEmpty>}
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => toggle(option.value)}
                >
                  <Check
                    className={cn(
                      'size-4',
                      selected.includes(option.value) ? 'opacity-100' : 'opacity-0',
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

Note the relative import paths: this file lives directly under `components/`, one level above `pages/Inbox/components/TagPicker.tsx` — hence `./ui/button.tsx` and `../lib/cn.ts` rather than `../../../...`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test MultiSelectFilter`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `useTicketsFilters`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTicketsFilters } from './useTicketsFilters.ts';

function renderWithRouter(initialEntry: string) {
  return renderHook(() => useTicketsFilters(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
    ),
  });
}

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
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter frontend test useTicketsFilters`
Expected: FAIL — `useTicketsFilters.ts` doesn't exist yet.

- [ ] **Step 7: Implement `useTicketsFilters`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts`:

```ts
import { useSearchParams } from 'react-router-dom';

export type TicketsFilters = {
  q: string;
  priority: string[];
  labelIds: string[];
  subintentIds: string[];
  assigneeIds: string[];
  olderThanHours: string;
};

function parseCsv(value: string | null): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/**
 * Filter state lives in the URL, not component state — a filtered board is
 * then shareable, bookmarkable, and survives a refresh, matching the pattern
 * already used for search on the webview's SupportSearch page.
 */
export function useTicketsFilters(): [TicketsFilters, (next: Partial<TicketsFilters>) => void] {
  const [params, setParams] = useSearchParams();

  const filters: TicketsFilters = {
    q: params.get('q') ?? '',
    priority: parseCsv(params.get('priority')),
    labelIds: parseCsv(params.get('labelIds')),
    subintentIds: parseCsv(params.get('subintentIds')),
    assigneeIds: parseCsv(params.get('assigneeIds')),
    olderThanHours: params.get('olderThanHours') ?? '',
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
    setParams(nextParams, { replace: true });
  }

  return [filters, update];
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter frontend test useTicketsFilters`
Expected: PASS.

- [ ] **Step 9: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add frontend/src/surfaces/agent-console/components/MultiSelectFilter.tsx frontend/src/surfaces/agent-console/components/MultiSelectFilter.test.tsx frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx
git commit -m "Add MultiSelectFilter component and URL-backed tickets filter state"
```

---

## Task 6: Wire the filter bar into the Tickets page

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`

**Interfaces:**

- Consumes: `MultiSelectFilter`, `useTicketsFilters`/`TicketsFilters` (Task 5), `fetchInbox`/`TicketsQueryFilters`/`fetchWorkspaceAgents` (Task 4), `fetchTags`, `fetchIntents` (pre-existing).
- Produces: `TicketsFilterBar(props: { token: string; filters: TicketsFilters; onChange: (next: Partial<TicketsFilters>) => void }): JSX.Element`, exported for the test; not consumed outside this task.

- [ ] **Step 1: Write the failing test for `TicketsFilterBar`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TicketsFilterBar } from './TicketsFilterBar.tsx';
import * as agentApi from '../../api/agentApi.ts';

vi.mock('../../api/agentApi.ts');

const EMPTY_FILTERS = {
  q: '',
  priority: [],
  labelIds: [],
  subintentIds: [],
  assigneeIds: [],
  olderThanHours: '',
};

function renderBar(onChange = vi.fn()) {
  vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
  vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
  vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onChange,
    ...render(
      <QueryClientProvider client={queryClient}>
        <TicketsFilterBar token="t" filters={EMPTY_FILTERS} onChange={onChange} />
      </QueryClientProvider>,
    ),
  };
}

describe('TicketsFilterBar', () => {
  it('renders a Priority filter control', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Priority/ })).toBeInTheDocument();
  });

  it('debounces search input before calling onChange', async () => {
    const { onChange } = renderBar();
    await userEvent.type(screen.getByPlaceholderText(/Search/i), 'refund');

    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ q: 'refund' }), { timeout: 1000 });
  });

  it('toggling the Priority p1 option calls onChange with the selection', async () => {
    const { onChange } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: /Priority/ }));
    await userEvent.click(await screen.findByText('P1'));

    expect(onChange).toHaveBeenCalledWith({ priority: ['p1'] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter frontend test TicketsFilterBar`
Expected: FAIL — `TicketsFilterBar.tsx` doesn't exist yet.

- [ ] **Step 3: Implement `TicketsFilterBar`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx`:

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
import type { TicketsFilters } from './useTicketsFilters.ts';

const PRIORITY_OPTIONS = [
  { value: 'p1', label: 'P1' },
  { value: 'p2', label: 'P2' },
  { value: 'p3', label: 'P3' },
  { value: 'p4', label: 'P4' },
];

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

  // The URL is the source of truth (back/forward, a bookmarked filtered
  // board), so a change made anywhere else — not just from typing here —
  // has to resync this field.
  useEffect(() => setSearchInput(filters.q), [filters.q]);

  useEffect(() => {
    if (searchInput === filters.q) return;
    const timer = setTimeout(() => onChange({ q: searchInput }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test TicketsFilterBar`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `Tickets.tsx`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Tickets } from './Tickets.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';
import * as agentApi from '../../api/agentApi.ts';

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>(
    '../../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});
vi.mock('../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({ on: vi.fn(), close: vi.fn() }),
}));
vi.mock('../../api/agentApi.ts');

function renderTickets(path = '/tickets') {
  vi.mocked(loadAgentSession).mockReturnValue({
    token: 'tok',
    agentId: 'agent-1',
    workspaceId: 'ws-1',
  } as never);
  vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
  vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
  vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/tickets/:conversationId" element={<Tickets />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Tickets filtering', () => {
  it('passes the active filters through to fetchInbox for every column', async () => {
    const fetchInboxSpy = vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] });
    renderTickets('/tickets?priority=p1');

    await waitFor(() =>
      expect(fetchInboxSpy).toHaveBeenCalledWith(
        'tok',
        'unassigned',
        expect.objectContaining({ priority: ['p1'] }),
      ),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'botHandling',
      expect.objectContaining({ priority: ['p1'] }),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'agentAssigned',
      expect.objectContaining({ priority: ['p1'] }),
    );
    expect(fetchInboxSpy).toHaveBeenCalledWith(
      'tok',
      'escalated',
      expect.objectContaining({ priority: ['p1'] }),
    );
  });

  it('shows a filtered-empty message distinct from a genuinely empty column', async () => {
    vi.mocked(agentApi.fetchInbox).mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [] : [] }),
    );
    renderTickets('/tickets?priority=p1');

    await screen.findAllByText('No tickets match your filters.');
  });

  it('shows the default empty state with no filters active', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [] });
    renderTickets('/tickets');

    await waitFor(() => expect(agentApi.fetchInbox).toHaveBeenCalled());
    expect(screen.queryByText('No tickets match your filters.')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter frontend test Tickets.test`
Expected: FAIL — `Tickets.tsx` doesn't render a filter bar yet, so no filters reach `fetchInbox`, and there's no "No tickets match your filters." text (currently a column with zero rows renders nothing at all — see line 26 of the current file: `if (queue.data && queue.data.conversations.length === 0) return null`).

- [ ] **Step 7: Wire the filter bar into `Tickets.tsx`**

Replace the full contents of `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`:

```tsx
import { useEffect } from 'react';
import type { ConversationStatusValue } from '@support/types';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  claimConversation,
  fetchInbox,
  type ConversationListFilter,
  type TicketsQueryFilters,
} from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../../lib/authErrorHandling.ts';
import { ConversationDetailPane } from '../../components/ConversationDetailPane.tsx';
import { ConversationRow } from '../Inbox/components/ConversationRow.tsx';
import { TicketsFilterBar } from './TicketsFilterBar.tsx';
import { useTicketsFilters } from './useTicketsFilters.ts';

const COLUMNS: { title: string; filter: ConversationListFilter; claimable?: boolean }[] = [
  { title: 'Unassigned', filter: 'unassigned', claimable: true },
  { title: 'Bot Handling', filter: 'botHandling' },
  { title: 'Agent Assigned', filter: 'agentAssigned' },
  { title: 'Escalated', filter: 'escalated' },
];

function toQueryFilters(f: ReturnType<typeof useTicketsFilters>[0]): TicketsQueryFilters {
  return {
    q: f.q || undefined,
    priority: f.priority.length ? f.priority : undefined,
    labelIds: f.labelIds.length ? f.labelIds : undefined,
    subintentIds: f.subintentIds.length ? f.subintentIds : undefined,
    assigneeIds: f.assigneeIds.length ? f.assigneeIds : undefined,
    olderThanHours: f.olderThanHours ? Number(f.olderThanHours) : undefined,
  };
}

function hasActiveFilters(f: TicketsQueryFilters): boolean {
  return Boolean(
    f.q || f.priority || f.labelIds || f.subintentIds || f.assigneeIds || f.olderThanHours,
  );
}

function QueueColumn({
  token,
  title,
  filter,
  queryFilters,
  filtersActive,
  claimable = false,
  onSelect,
}: {
  token: string;
  title: string;
  filter: ConversationListFilter;
  queryFilters: TicketsQueryFilters;
  filtersActive: boolean;
  claimable?: boolean;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['tickets', filter, queryFilters],
    queryFn: () => fetchInbox(token, filter, queryFilters),
  });
  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets'] }),
  });
  if (queue.data && queue.data.conversations.length === 0 && !filtersActive) return null;
  return (
    <section className="flex h-[calc(100vh-12rem)] min-h-0 flex-col rounded-card border border-slate-200 bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-xs text-muted">{queue.data?.conversations.length ?? 0}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {queue.data?.conversations.length === 0 && filtersActive && (
          <p className="p-3 text-xs text-muted">No tickets match your filters.</p>
        )}
        {queue.data?.conversations.map((conversation) => (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            selected={false}
            onSelect={() => onSelect(conversation.id)}
            onClaim={claimable ? () => claim.mutate(conversation.id) : undefined}
            claiming={claim.isPending}
          />
        ))}
        {queue.isError && <p className="p-3 text-xs text-muted">Could not load tickets.</p>}
      </div>
    </section>
  );
}

export function Tickets() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const [filters, updateFilters] = useTicketsFilters();
  const queryFilters = toQueryFilters(filters);
  const filtersActive = hasActiveFilters(queryFilters);

  useEffect(() => {
    if (!session) return;
    const socket = createSocket(session.token, 'agent');
    socket.on('connect_error', (error) => {
      if (error.message === 'unauthorized') handleSessionExpired();
    });
    socket.on(
      'conversation:changed',
      (payload: { conversation_id?: unknown; status?: unknown }) => {
        const status = payload.status as ConversationStatusValue | undefined;
        const filtersToInvalidate: ConversationListFilter[] =
          status === 'bot_active' ? ['botHandling'] : ['unassigned', 'agentAssigned', 'escalated'];
        for (const filter of filtersToInvalidate)
          void queryClient.invalidateQueries({ queryKey: ['tickets', filter] });
        const changedId = payload.conversation_id;
        if (typeof changedId === 'string')
          void queryClient.invalidateQueries({ queryKey: ['conversation', changedId, 'detail'] });
      },
    );
    return () => {
      socket.close();
    };
  }, [session, queryClient]);

  const queueQueries = useQueries({
    queries: COLUMNS.map(({ filter }) => ({
      queryKey: ['tickets', filter, queryFilters],
      queryFn: () => fetchInbox(session!.token, filter, queryFilters),
      enabled: session !== null,
    })),
  });

  const summary = (() => {
    if (!conversationId) return undefined;
    for (const query of queueQueries) {
      const found = query.data?.conversations.find(
        (conversation) => conversation.id === conversationId,
      );
      if (found) return found;
    }
    return undefined;
  })();

  if (!session) return null;
  if (conversationId) {
    return (
      <ConversationDetailPane
        token={session.token}
        agentId={session.agentId}
        conversationId={conversationId}
        summary={summary}
        onBack={() => navigate('/tickets')}
      />
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4">
        <h1 className="text-lg font-semibold">Tickets</h1>
        <p className="text-sm text-muted">All active queues at a glance</p>
      </div>
      <TicketsFilterBar token={session.token} filters={filters} onChange={updateFilters} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {COLUMNS.map(({ title, filter, claimable }) => (
          <QueueColumn
            key={filter}
            token={session.token}
            title={title}
            filter={filter}
            queryFilters={queryFilters}
            filtersActive={filtersActive}
            claimable={claimable}
            onSelect={(id) => navigate(`/tickets/${id}`)}
          />
        ))}
      </div>
    </div>
  );
}
```

Note on the invalidate-on-socket-event handler: it invalidates `['tickets', filter]` (no third element), and TanStack Query's default `invalidateQueries` matching is a _prefix_ match — `['tickets', 'unassigned', queryFilters]` still matches the `['tickets', 'unassigned']` predicate and gets refetched, automatically re-querying with whatever `queryFilters` are active at that moment. No change to that handler is required for filters to work correctly with real-time updates.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter frontend test Tickets.test`
Expected: PASS.

- [ ] **Step 9: Run the full frontend test suite to check for regressions**

Run: `pnpm --filter frontend test`
Expected: PASS, including `Inbox.test.tsx` / `ConversationList.test.tsx` (unaffected — they call `fetchInbox` with two args, which still works).

- [ ] **Step 10: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/
git commit -m "Wire search and filter bar into the Tickets board"
```

---

## Final check

- [ ] Run `pnpm test` (full workspace suite; requires Postgres up per `CLAUDE.md`) and `pnpm typecheck` once more from the repo root.
- [ ] Manually verify in the running app (`pnpm dev`): open `/tickets`, confirm the filter bar appears above the board, that selecting a priority narrows all four columns, that clearing it restores them, and that the URL reflects the active filters (a page refresh keeps them).
