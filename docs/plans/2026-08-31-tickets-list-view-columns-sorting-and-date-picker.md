# Tickets List View: Date-Range Picker, Reset Filters, More Columns, Sortable Headers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tickets filter bar's native date inputs with a shadcn range picker, add a "Reset filters" button, add Created/Subintent/Ticket# columns to the List view table, and make all List view columns sortable (2-key cap, default Priority asc → Created asc).

**Architecture:** Frontend: a new shadcn `Calendar` primitive (react-day-picker) + `DateRangeFilter` popover replace the two native date inputs in `TicketsFilterBar`; sort state (`sortBy`/`sortDir`/`sortBy2`/`sortDir2`) joins the existing URL-persisted filter state in `useTicketsFilters`. Backend: `AgentConversationSummary` gains `created_at`/`subintent`/`number`; `listAllConversations`'s single hardcoded sort (priority asc, activity desc) becomes a small sort-key registry driving both `ORDER BY` and a generalized 2-key keyset cursor, replacing the current `AllCursor` fixed shape.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (backend), React + TanStack Query + Tailwind v4 + react-day-picker (frontend), Vitest + Testing Library.

Builds on top of `docs/plans/2026-08-21-tickets-search-and-filters.md` and `docs/plans/2026-08-31-tickets-list-view-and-filters-plan.md`, both already implemented — this plan only touches what those left in place (`TicketsFilterBar.tsx`, `TicketsListView` in `Tickets.tsx`, `listAllConversations`).

## Global Constraints

- Spec: `docs/specs/2026-08-31-tickets-filter-bar-date-range-and-reset-design.md`.
- No changes to the `createdFrom`/`createdTo` URL param contract or value format (`YYYY-MM-DD`) — only new `sortBy`/`sortDir`/`sortBy2`/`sortDir2` params are added alongside it.
- `view` (board/list) is never touched by "Reset filters" — it's a display mode, not a filter.
- Board view (`QueueColumn`, `listConversations`, `listResolvedOrClosedConversations`) is untouched by every task in this plan.
- Tailwind v4 utilities only — no hand-written CSS classes (`CLAUDE.md`).
- New endpoint query params → register in `backend/src/docs/openapi.ts` (`CLAUDE.md`).
- `id` (`conversation.id`) remains the unconditional final keyset tiebreaker on every query in `conversationsService.ts` — never drop it, the keyset must stay total.
- Nulls-last on assignee/lastMessage/subintent sort keys — unassigned/no-message/no-subintent rows never jump to the top on an ascending sort.

---

## Task 1: Backend — expose `created_at`, `subintent`, `number` on `AgentConversationSummary`

**Files:**
- Modify: `packages/types/src/chat.ts:149-167` (`AgentConversationSummary`)
- Modify: `backend/src/agent/services/conversationsService.ts:384-434` (`listAllConversations`'s `rows` select and `summaries` push)
- Test: `backend/tests/agent.conversations.test.ts`

No `openapi.ts` change in this task — `/agent/conversations`'s existing registration (`:596-638`) only documents the request query shape, not a response schema, and this task doesn't touch the query shape (Task 2 does).

**Interfaces:**
- Consumes: nothing new.
- Produces: `AgentConversationSummary.created_at: string`, `.subintent: { id: string; name: string } | null`, `.number: number` — Task 8 (frontend columns) reads these three fields directly off each row.

- [ ] **Step 1: Write the failing backend test**

Add to the `describe('GET /agent/conversations?status=all', ...)` block in `backend/tests/agent.conversations.test.ts` (after the existing tests, before the closing `});` at line 820):

```ts
  it('includes created_at, subintent, and ticket number on each row', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const intentId = await seedIntent({ workspaceId, name: 'Billing' });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refund request' });
    const createdAt = new Date('2026-08-15T10:00:00Z');
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      createdAt,
      subintentId,
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'all' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const row = res.body.conversations.find((c: { id: string }) => c.id === conversationId);
    expect(row.created_at).toBe(createdAt.toISOString());
    expect(row.subintent).toEqual({ id: subintentId, name: 'Refund request' });
    expect(typeof row.number).toBe('number');
  });
```

Check `seedIntent`'s and `seedSubintent`'s exact signatures in `backend/tests/helpers/db.ts` before running — if either takes different argument names than shown, match what's there rather than what's written here.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- agent.conversations.test.ts -t "includes created_at, subintent, and ticket number"`
Expected: FAIL — `row.created_at` is `undefined` (field doesn't exist on the response yet).

- [ ] **Step 3: Add the fields to the type**

In `packages/types/src/chat.ts`, inside `AgentConversationSummary` (after the `tags: TagView[];` line):

```ts
  /** ISO timestamp. */
  created_at: string;
  subintent: { id: string; name: string } | null;
  number: number;
```

- [ ] **Step 4: Select and populate the new fields in `listAllConversations`**

In `backend/src/agent/services/conversationsService.ts`, in `listAllConversations`'s `rows` select (around line 384-394), add three columns:

```ts
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
        createdAt: conversation.createdAt,
        subintentId: subintent.id,
        subintentName: subintent.name,
        number: conversation.number,
      })
```

Then in the `summaries.push(...)` block right below (around line 422-433), add the three fields:

```ts
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
        created_at: row.createdAt.toISOString(),
        subintent: row.subintentId ? { id: row.subintentId, name: row.subintentName! } : null,
        number: row.number,
      });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/api test -- agent.conversations.test.ts -t "includes created_at, subintent, and ticket number"`
Expected: PASS

- [ ] **Step 6: Run full backend suite to check for type errors elsewhere**

Run: `pnpm --filter @support/api typecheck && pnpm --filter @support/api test`
Expected: all pass — `AgentConversationSummary` is a superset change (new required fields), so anything else constructing this type (e.g. `listConversations`, `listResolvedOrClosedConversations` for Board view) will now fail to typecheck until they're updated too.

If Board view's `listConversations`/`listResolvedOrClosedConversations` fail to typecheck because they build `AgentConversationSummary` objects missing the three new fields, add the same three fields to their `rows` selects and `summaries.push` calls (`subintent` join is already present in both — verify at `conversationsService.ts:279-281` and `:396` before this task's changes; add `createdAt: conversation.createdAt, subintentId: subintent.id, subintentName: subintent.name, number: conversation.number` to each select and the corresponding three fields to each push). This is required to keep the whole file compiling even though Board view doesn't display these columns — the type is shared across all three list functions.

- [ ] **Step 7: Commit**

```bash
git add packages/types/src/chat.ts backend/src/agent/services/conversationsService.ts backend/tests/agent.conversations.test.ts
git commit -m "feat: expose created_at, subintent, and ticket number on conversation summaries"
```

---

## Task 2: Backend — generalize `listAllConversations` sort into a 2-key registry + keyset cursor

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts:173-193` (`AllCursor`/`encodeAllCursor`/`decodeAllCursor`), `:359-448` (`listAllConversations`)
- Modify: `backend/src/agent/controllers/conversationsController.ts:28-67` (`ConversationsQuery`)
- Modify: `backend/src/docs/openapi.ts:596-638` (`/agent/conversations` query schema)
- Test: `backend/tests/agent.conversations.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1 other than the already-selected `createdAt`/`subintentId`/`subintentName`/`number` columns (reused as sortable columns, not re-selected).
- Produces: `ConversationsListFilters.sortBy?: SortKey`, `.sortDir?: 'asc' | 'desc'`, `.sortBy2?: SortKey`, `.sortDir2?: 'asc' | 'desc'` where `SortKey = 'player' | 'status' | 'priority' | 'assignee' | 'lastMessage' | 'tags' | 'created' | 'subintent' | 'number'`. Defaults when unset: `sortBy: 'priority', sortDir: 'asc', sortBy2: 'created', sortDir2: 'asc'`. Task 3 (frontend `agentApi.ts`) sends these four params by name.

- [ ] **Step 1: Write the failing backend tests**

Replace the existing first test in `describe('GET /agent/conversations?status=all', ...)` (`'merges unassigned, escalated, and resolved conversations, sorted by priority then activity'`, lines 705-769) — its ordering assertions describe the *old* default (priority, then most-recent-activity). The new default is priority, then created-at ascending. Since `p1Escalated` is seeded before `p1ResolvedRecent` in that test, `createdAt` ordering happens to produce the same relative order as the old activity-based assertion for those two rows, but the test's comment is about to be wrong and must be corrected, and a new dedicated ordering test should replace reliance on that coincidence:

```ts
  it('merges unassigned, escalated, and resolved conversations, sorted by priority then created (default)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);

    const p2Unassigned = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const p1Older = await seedConversation({
      workspaceId,
      playerId,
      status: 'escalated',
      priority: 'p1',
      createdAt: new Date('2026-08-01T00:00:00Z'),
    });
    const p1Newer = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p1',
      createdAt: new Date('2026-08-10T00:00:00Z'),
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId: p1Newer,
      resolvedAt: new Date(),
    });
    const p1ResolvedStale = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      priority: 'p1',
      createdAt: new Date('2026-08-02T00:00:00Z'),
    });
    await seedResolutionCycle({
      workspaceId,
      conversationId: p1ResolvedStale,
      resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
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
    expect(ids).toContain(p1Older);
    expect(ids).toContain(p1Newer);
    // Outside the 7-day resolved window — excluded exactly like the dedicated resolved queue.
    expect(ids).not.toContain(p1ResolvedStale);
    // Both p1s sort before the p2 (priority is primary), and among the p1s
    // the older-created one sorts first (created asc is the secondary key).
    expect(ids.indexOf(p1Older)).toBeLessThan(ids.indexOf(p2Unassigned));
    expect(ids.indexOf(p1Newer)).toBeLessThan(ids.indexOf(p2Unassigned));
    expect(ids.indexOf(p1Older)).toBeLessThan(ids.indexOf(p1Newer));
  });

  it('sorts by an explicit two-key request (assignee desc, number asc)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { agentId: bravoId } = await setupAssignedAgentNamed(workspaceId, 'Bravo');
    const { agentId: alphaId } = await setupAssignedAgentNamed(workspaceId, 'Alpha');
    const unassigned = await seedConversation({ workspaceId, playerId, status: 'open' });
    const assignedToAlpha = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: alphaId,
    });
    const assignedToBravo = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: bravoId,
    });
    const { token } = await setupAgent(workspaceId);

    const res = await request(app)
      .get('/conversations')
      .query({ status: 'all', sortBy: 'assignee', sortDir: 'desc', sortBy2: 'number', sortDir2: 'asc' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const ids = res.body.conversations.map((c: { id: string }) => c.id);
    // desc + nulls-last: Bravo, then Alpha, then the unassigned (null) row last.
    expect(ids.indexOf(assignedToBravo)).toBeLessThan(ids.indexOf(assignedToAlpha));
    expect(ids.indexOf(assignedToAlpha)).toBeLessThan(ids.indexOf(unassigned));
  });

  it('paginates with a stable keyset cursor under a non-default sort', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    for (let i = 0; i < 30; i++) {
      await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p3' });
    }
    const { token } = await setupAgent(workspaceId);

    const page1 = await request(app)
      .get('/conversations')
      .query({ status: 'all', sortBy: 'created', sortDir: 'desc', sortBy2: 'number', sortDir2: 'desc' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page1.body.conversations).toHaveLength(25);

    const page2 = await request(app)
      .get('/conversations')
      .query({
        status: 'all',
        sortBy: 'created',
        sortDir: 'desc',
        sortBy2: 'number',
        sortDir2: 'desc',
        cursor: page1.body.nextCursor,
      })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(page2.body.conversations).toHaveLength(5);

    const page1Ids = page1.body.conversations.map((c: { id: string }) => c.id);
    const page2Ids = page2.body.conversations.map((c: { id: string }) => c.id);
    expect(new Set([...page1Ids, ...page2Ids]).size).toBe(30);
  });
```

Add a `setupAssignedAgentNamed` helper right above the `describe('GET /agent/conversations?status=all', ...)` block (the existing `setupAssignedAgent` at line 68 hardcodes the display name — this variant parameterizes it):

```ts
async function setupAssignedAgentNamed(workspaceId: string, displayName: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($2, $1) returning id`,
    [displayName, `${displayName.toLowerCase()}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return { agentId };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @support/api test -- agent.conversations.test.ts`
Expected: the two new tests FAIL (`sortBy` query param not recognized / ignored, so results come back in the old fixed order); the rewritten default-order test passes already (createdAt-asc happens to match by coincidence) — that's fine, it'll be exercised for real once Step 3-5 land.

- [ ] **Step 3: Add sort params to the controller and OpenAPI schema**

In `backend/src/agent/controllers/conversationsController.ts`, add to `ConversationsQuery` (after the `statuses` field):

```ts
  sortBy: z
    .enum(['player', 'status', 'priority', 'assignee', 'lastMessage', 'tags', 'created', 'subintent', 'number'])
    .optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  sortBy2: z
    .enum(['player', 'status', 'priority', 'assignee', 'lastMessage', 'tags', 'created', 'subintent', 'number'])
    .optional(),
  sortDir2: z.enum(['asc', 'desc']).optional(),
```

Mirror the same four fields in `backend/src/docs/openapi.ts`'s `/agent/conversations` query object (`:596-638`), same enum values.

- [ ] **Step 4: Add the sort-key registry and generalize the query in `listAllConversations`**

In `backend/src/agent/services/conversationsService.ts`, replace `AllCursor`/`encodeAllCursor`/`decodeAllCursor` (lines 173-193) with a generic 2-key cursor:

```ts
export type SortKey =
  | 'player'
  | 'status'
  | 'priority'
  | 'assignee'
  | 'lastMessage'
  | 'tags'
  | 'created'
  | 'subintent'
  | 'number';

type AllCursor = { primary: string; secondary: string; id: string };

function encodeAllCursor(payload: AllCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeAllCursor(cursor: string): AllCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed?.primary === 'string' &&
      typeof parsed?.secondary === 'string' &&
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

Add the registry just above `listAllConversations` (needs `lastMessageAt`/`tagCount` as correlated subqueries — define them as functions taking no args since they reference `conversation.id`/`message`/`conversationTag` directly, matching the existing `activity` subquery style at line 369):

```ts
const lastMessageAtExpr = sql<Date | null>`(select max(m.created_at) from ${message} m where m.conversation_id = ${conversation.id})`;
const tagCountExpr = sql<number>`(select count(*) from ${conversationTag} ct where ct.conversation_id = ${conversation.id} and ct.removed_at is null)`;

const SORT_COLUMNS: Record<SortKey, { expr: any; sqlType: string; nullsLast?: boolean }> = {
  player: { expr: player.externalId, sqlType: 'text' },
  status: { expr: conversation.status, sqlType: 'conversation_status' },
  priority: { expr: conversation.priority, sqlType: 'conversation_priority' },
  assignee: { expr: agent.displayName, sqlType: 'text', nullsLast: true },
  lastMessage: { expr: lastMessageAtExpr, sqlType: 'timestamptz', nullsLast: true },
  tags: { expr: tagCountExpr, sqlType: 'int' },
  created: { expr: conversation.createdAt, sqlType: 'timestamptz' },
  subintent: { expr: subintent.name, sqlType: 'text', nullsLast: true },
  number: { expr: conversation.number, sqlType: 'int' },
};

function orderExpr(key: SortKey, dir: 'asc' | 'desc') {
  const col = SORT_COLUMNS[key];
  const direction = dir === 'asc' ? sql`asc` : sql`desc`;
  const nulls = col.nullsLast ? sql`nulls last` : sql``;
  return sql`${col.expr} ${direction} ${nulls}`;
}

// Generalizes the old fixed priority-asc/activity-desc/id-desc three-branch
// OR (see git history) to any (primary, secondary, id) triple with
// independent per-key directions. id is always the final tiebreaker, always
// ascending, so the keyset stays total regardless of what's being sorted.
function buildAllCursorCondition(
  primaryKey: SortKey,
  primaryDir: 'asc' | 'desc',
  secondaryKey: SortKey,
  secondaryDir: 'asc' | 'desc',
  cursor: AllCursor,
) {
  const primary = SORT_COLUMNS[primaryKey];
  const secondary = SORT_COLUMNS[secondaryKey];
  const primaryOp = primaryDir === 'asc' ? sql`>` : sql`<`;
  const secondaryOp = secondaryDir === 'asc' ? sql`>` : sql`<`;
  return sql`(
    ${primary.expr} ${primaryOp} ${cursor.primary}::${sql.raw(primary.sqlType)}
    or (${primary.expr} = ${cursor.primary}::${sql.raw(primary.sqlType)} and ${secondary.expr} ${secondaryOp} ${cursor.secondary}::${sql.raw(secondary.sqlType)})
    or (${primary.expr} = ${cursor.primary}::${sql.raw(primary.sqlType)} and ${secondary.expr} = ${cursor.secondary}::${sql.raw(secondary.sqlType)} and ${conversation.id} > ${cursor.id}::uuid)
  )`;
}
```

Update `ConversationsListFilters` (lines 52-63) to add the four sort fields:

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
  statuses?: Exclude<ConversationsFilter, 'all' | 'mine'>[];
  sortBy?: SortKey;
  sortDir?: 'asc' | 'desc';
  sortBy2?: SortKey;
  sortDir2?: 'asc' | 'desc';
};
```

Now rewrite the query portion of `listAllConversations` (lines 359-407) to use the registry instead of the hardcoded `activity`/`cursorCondition`/`.orderBy(...)`:

```ts
async function listAllConversations(
  ctx: AgentContext,
  extra: ConversationsListFilters,
): Promise<ConversationsPage> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const statuses = extra.statuses?.length ? extra.statuses : ALL_QUEUE_STATUSES;
    const primaryKey: SortKey = extra.sortBy ?? 'priority';
    const primaryDir: 'asc' | 'desc' = extra.sortDir ?? 'asc';
    const secondaryKey: SortKey = extra.sortBy2 ?? 'created';
    const secondaryDir: 'asc' | 'desc' = extra.sortDir2 ?? 'asc';
    const cursor = extra.cursor ? decodeAllCursor(extra.cursor) : null;
    const cursorCondition = cursor
      ? buildAllCursorCondition(primaryKey, primaryDir, secondaryKey, secondaryDir, cursor)
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
        subintentId: subintent.id,
        subintentName: subintent.name,
        number: conversation.number,
        primarySortValue: sql<string>`${SORT_COLUMNS[primaryKey].expr}::text`,
        secondarySortValue: sql<string>`${SORT_COLUMNS[secondaryKey].expr}::text`,
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
      .orderBy(orderExpr(primaryKey, primaryDir), orderExpr(secondaryKey, secondaryDir), conversation.id)
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
        created_at: row.createdAt.toISOString(),
        subintent: row.subintentId ? { id: row.subintentId, name: row.subintentName! } : null,
        number: row.number,
      });
    }

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeAllCursor({
            primary: lastRow.primarySortValue,
            secondary: lastRow.secondarySortValue,
            id: lastRow.id,
          })
        : null;

    return { conversations: summaries, nextCursor };
  });
}
```

Note the `id` tiebreak direction changed from the old code's `desc(conversation.id)` to a plain ascending `conversation.id` in both `.orderBy(...)` and `buildAllCursorCondition`'s `>` — this is an intentional simplification (id has no business meaning, any fixed direction is equally correct) and must stay consistent between the two.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @support/api test -- agent.conversations.test.ts`
Expected: PASS, including the two new sort tests and the rewritten default-order test.

- [ ] **Step 6: Run full backend suite and typecheck**

Run: `pnpm --filter @support/api typecheck && pnpm --filter @support/api test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/docs/openapi.ts backend/tests/agent.conversations.test.ts
git commit -m "feat: generalize list-view sort into a 2-key registry with keyset pagination"
```

---

## Task 3: Frontend — `agentApi.ts` sends the four sort params

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts:128-159` (`TicketsQueryFilters`, `buildTicketsQuery`)
- Test: `frontend/src/surfaces/agent-console/api/agentApi.test.ts` if it exists — check with `ls frontend/src/surfaces/agent-console/api/*.test.ts` first; if there's no existing test file for this module, skip a dedicated unit test here and rely on Task 9's `TicketsListView` integration test to exercise the full path (this repo doesn't unit-test `buildTicketsQuery` directly today — grep confirms `TicketsFilterBar.test.tsx` and `Tickets.test.tsx` are the coverage for this query-building logic).

**Interfaces:**
- Consumes: nothing new.
- Produces: `TicketsQueryFilters.sortBy?: string`, `.sortDir?: 'asc' | 'desc'`, `.sortBy2?: string`, `.sortDir2?: 'asc' | 'desc'`. Task 4 (`useTicketsFilters`) and Task 9 (`TicketsListView`) build this object.

- [ ] **Step 1: Add the four fields to `TicketsQueryFilters` and `buildTicketsQuery`**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, extend `TicketsQueryFilters` (lines 128-138):

```ts
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
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  sortBy2?: string;
  sortDir2?: 'asc' | 'desc';
};
```

Add to `buildTicketsQuery` (after the `createdTo` line, before `if (cursor)`):

```ts
  if (filters?.sortBy) params.set('sortBy', filters.sortBy);
  if (filters?.sortDir) params.set('sortDir', filters.sortDir);
  if (filters?.sortBy2) params.set('sortBy2', filters.sortBy2);
  if (filters?.sortDir2) params.set('sortDir2', filters.sortDir2);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/web typecheck`
Expected: PASS (this is a pure additive type change; nothing consumes the new fields yet, so nothing can be broken).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat: add sort query params to fetchInbox"
```

---

## Task 4: Frontend — sort state on `useTicketsFilters`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TicketsFilters.sortBy: string`, `.sortDir: 'asc' | 'desc'`, `.sortBy2: string`, `.sortDir2: 'asc' | 'desc'` — defaulting to `'priority'`/`'asc'`/`'created'`/`'asc'` when absent from the URL. Task 9 (`TicketsListView`) reads and writes these through the same `update` function every other filter uses.

- [ ] **Step 1: Fix the existing exact-match default-filters test, and write the failing new tests**

`useTicketsFilters.test.tsx` already has a test called `'defaults to empty filters with no params'` that asserts the *entire* filters object with `toEqual` against a fixed literal (no `sortBy`/`sortDir`/etc. keys). Adding the four new fields to `TicketsFilters` will make that literal incomplete and fail. Update it in place to include the four new defaults:

```ts
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
      sortBy: 'priority',
      sortDir: 'asc',
      sortBy2: 'created',
      sortDir2: 'asc',
    });
  });
```

Then add two new tests using the file's existing `renderWithRouter(initialEntry)` helper (defined at the top of the file — it wraps `useTicketsFilters()` in a `MemoryRouter` and returns the `renderHook` result, whose `result.current` is the `[filters, update]` tuple):

```ts
it('reads a non-default sort from the URL', () => {
  const { result } = renderWithRouter('/tickets?sortBy=assignee&sortDir=desc&sortBy2=number');
  const [filters] = result.current;
  expect(filters.sortBy).toBe('assignee');
  expect(filters.sortDir).toBe('desc');
  expect(filters.sortBy2).toBe('number');
  expect(filters.sortDir2).toBe('asc');
});

it('round-trips a non-default sort through the URL on update, omitting defaulted slots', () => {
  const { result } = renderWithRouter('/tickets');
  act(() => {
    const [, update] = result.current;
    update({ sortBy: 'assignee', sortDir: 'desc', sortBy2: 'number', sortDir2: 'asc' });
  });
  const [filters] = result.current;
  expect(filters.sortBy).toBe('assignee');
  expect(filters.sortDir).toBe('desc');
  expect(filters.sortBy2).toBe('number');
  // sortDir2 'asc' is the default for the secondary slot, so it's omitted
  // from the URL — but reading it back still resolves to 'asc' either way,
  // matching how every other filter field round-trips only when non-default.
  expect(filters.sortDir2).toBe('asc');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @support/web test -- useTicketsFilters.test.tsx`
Expected: the two new tests FAIL (`filters.sortBy` is `undefined`); the updated default-filters test also FAILS until Step 3 lands, since the type doesn't produce those fields yet.

- [ ] **Step 3: Implement**

In `useTicketsFilters.ts`, add to the `TicketsFilters` type:

```ts
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
  sortBy: string;
  sortDir: 'asc' | 'desc';
  sortBy2: string;
  sortDir2: 'asc' | 'desc';
};
```

In the `filters` object construction:

```ts
    sortBy: params.get('sortBy') ?? 'priority',
    sortDir: params.get('sortDir') === 'desc' ? 'desc' : 'asc',
    sortBy2: params.get('sortBy2') ?? 'created',
    sortDir2: params.get('sortDir2') === 'desc' ? 'desc' : 'asc',
```

In `update`, after the `view` line:

```ts
    if (merged.sortBy !== 'priority') nextParams.set('sortBy', merged.sortBy);
    if (merged.sortDir !== 'asc') nextParams.set('sortDir', merged.sortDir);
    if (merged.sortBy2 !== 'created') nextParams.set('sortBy2', merged.sortBy2);
    if (merged.sortDir2 !== 'asc') nextParams.set('sortDir2', merged.sortDir2);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test -- useTicketsFilters.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.ts frontend/src/surfaces/agent-console/pages/Tickets/useTicketsFilters.test.tsx
git commit -m "feat: add sort state to useTicketsFilters"
```

---

## Task 5: Frontend — add `react-day-picker`/`date-fns` and the `Calendar` primitive

**Files:**
- Modify: `frontend/package.json` (new dependencies)
- Create: `frontend/src/surfaces/agent-console/components/ui/calendar.tsx`
- Test: none (a styled wrapper around a third-party component; exercised indirectly by Task 6's `DateRangeFilter` test)

**Interfaces:**
- Consumes: `Button`/`buttonVariants` from `./button.tsx` (already exists, shown above).
- Produces: `Calendar` component with props `{ mode: 'range'; selected?: { from?: Date; to?: Date }; onSelect: (range: { from?: Date; to?: Date } | undefined) => void }` (react-day-picker's own `DateRange` type). Task 6 renders `<Calendar mode="range" .../>` inside a `Popover`.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm --filter @support/web add react-day-picker date-fns`

- [ ] **Step 2: Create the Calendar primitive**

Create `frontend/src/surfaces/agent-console/components/ui/calendar.tsx`:

```tsx
import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import { cn } from '../../lib/cn.ts';
import { buttonVariants } from './button.tsx';

function Calendar({
  className,
  classNames,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-2',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center w-full',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1 absolute inset-x-0 justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-70 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'size-7 bg-transparent p-0 opacity-70 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'text-muted rounded-md w-8 font-normal text-xs',
        week: 'flex w-full mt-1',
        day: 'size-8 text-center text-sm p-0 relative',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-8 p-0 font-normal aria-selected:opacity-100',
        ),
        range_start: 'rounded-l-md bg-accent text-accent-fg',
        range_end: 'rounded-r-md bg-accent text-accent-fg',
        range_middle: 'bg-accent-soft text-text rounded-none',
        selected: 'bg-accent text-accent-fg',
        today: 'font-semibold',
        outside: 'text-muted opacity-50',
        disabled: 'text-muted opacity-50',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @support/web typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml frontend/src/surfaces/agent-console/components/ui/calendar.tsx
git commit -m "feat: add shadcn Calendar primitive (react-day-picker)"
```

---

## Task 6: Frontend — `DateRangeFilter` component

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.test.tsx`

**Interfaces:**
- Consumes: `Calendar` (Task 5), `Popover`/`PopoverTrigger`/`PopoverContent` (existing), `Button` (existing).
- Produces: `DateRangeFilter({ from, to, onChange }: { from: string; to: string; onChange: (next: { createdFrom: string; createdTo: string }) => void })`. Task 7 (`TicketsFilterBar`) renders this in place of the two native date inputs.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangeFilter } from './DateRangeFilter.tsx';

describe('DateRangeFilter', () => {
  it('shows a placeholder label when no range is set', () => {
    render(<DateRangeFilter from="" to="" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Created date/ })).toBeInTheDocument();
  });

  it('shows the formatted range when both bounds are set', () => {
    render(<DateRangeFilter from="2026-08-01" to="2026-08-15" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Aug 1.*Aug 15/ })).toBeInTheDocument();
  });

  it('selecting a day range calls onChange with YYYY-MM-DD bounds', async () => {
    const onChange = vi.fn();
    render(<DateRangeFilter from="" to="" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /Created date/ }));

    const day1 = await screen.findByRole('gridcell', { name: '1' });
    await userEvent.click(day1.querySelector('button')!);
    const day5 = screen.getByRole('gridcell', { name: '5' });
    await userEvent.click(day5.querySelector('button')!);

    expect(onChange).toHaveBeenCalled();
    const [call] = onChange.mock.calls[onChange.mock.calls.length - 1]!;
    expect(call.createdFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(call.createdTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test -- DateRangeFilter.test.tsx`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Implement**

Create `frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.tsx`:

```tsx
import { format } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { Button } from '../../components/ui/button.tsx';
import { Calendar } from '../../components/ui/calendar.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';

/** Local YYYY-MM-DD, matching the wire format already used by createdFrom/createdTo. */
function toLocalDateString(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function fromLocalDateString(value: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

function triggerLabel(from: string, to: string): string {
  if (!from && !to) return 'Created date';
  if (from && to) return `${format(fromLocalDateString(from)!, 'MMM d')} – ${format(fromLocalDateString(to)!, 'MMM d')}`;
  if (from) return `From ${format(fromLocalDateString(from)!, 'MMM d')}`;
  return `Until ${format(fromLocalDateString(to)!, 'MMM d')}`;
}

export function DateRangeFilter({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (next: { createdFrom: string; createdTo: string }) => void;
}) {
  const selected: DateRange | undefined =
    from || to ? { from: fromLocalDateString(from), to: fromLocalDateString(to) } : undefined;

  function handleSelect(range: DateRange | undefined) {
    onChange({
      createdFrom: range?.from ? toLocalDateString(range.from) : '',
      createdTo: range?.to ? toLocalDateString(range.to) : '',
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {triggerLabel(from, to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="range" selected={selected} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test -- DateRangeFilter.test.tsx`
Expected: PASS. If the calendar grid's accessible roles/names don't match `getByRole('gridcell', ...)` exactly (react-day-picker's DOM structure), inspect the rendered output (`screen.debug()`) and adjust the test's queries — the day-cell button's accessible name is the day-of-month text by default, but confirm rather than assume.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.tsx frontend/src/surfaces/agent-console/pages/Tickets/DateRangeFilter.test.tsx
git commit -m "feat: add DateRangeFilter shadcn date-range picker"
```

---

## Task 7: Frontend — wire `DateRangeFilter` + add "Reset filters" into `TicketsFilterBar`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx`

**Interfaces:**
- Consumes: `DateRangeFilter` (Task 6).
- Produces: nothing new consumed by later tasks — this is a leaf UI change.

- [ ] **Step 1: Update the existing date-input tests to match the new control**

In `TicketsFilterBar.test.tsx`, replace the last test (`'changing the Created-from date calls onChange'`, lines 73-79):

```tsx
  it('selecting a date range calls onChange with both bounds', async () => {
    const { onChange } = renderBar();
    await userEvent.click(screen.getByRole('button', { name: /Created date/ }));
    const day1 = await screen.findByRole('gridcell', { name: '1' });
    await userEvent.click(day1.querySelector('button')!);
    const day5 = screen.getByRole('gridcell', { name: '5' });
    await userEvent.click(day5.querySelector('button')!);

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        createdFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        createdTo: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      }),
    );
  });
```

Add new tests for the reset button:

```tsx
  it('disables Reset filters when no filters are active', () => {
    renderBar();
    expect(screen.getByRole('button', { name: /Reset filters/ })).toBeDisabled();
  });

  it('enables Reset filters once a filter is set, and clears everything on click', async () => {
    const onChange = vi.fn();
    vi.mocked(agentApi.fetchTags).mockResolvedValue([]);
    vi.mocked(agentApi.fetchIntents).mockResolvedValue({ intents: [] });
    vi.mocked(agentApi.fetchWorkspaceAgents).mockResolvedValue({ agents: [] });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TicketsFilterBar
          token="t"
          filters={{ ...EMPTY_FILTERS, priority: ['p1'] }}
          onChange={onChange}
        />
      </QueryClientProvider>,
    );

    const resetButton = screen.getByRole('button', { name: /Reset filters/ });
    expect(resetButton).not.toBeDisabled();
    await userEvent.click(resetButton);

    expect(onChange).toHaveBeenCalledWith({
      q: '',
      priority: [],
      labelIds: [],
      subintentIds: [],
      assigneeIds: [],
      olderThanHours: '',
      statuses: [],
      createdFrom: '',
      createdTo: '',
    });
  });
```

This second test renders directly instead of through `renderBar()` because it needs non-default `filters` — `renderBar()` hardcodes `EMPTY_FILTERS`. `QueryClient`/`QueryClientProvider` and `render` are already imported at the top of the file (lines 2, 4), so no new imports are needed beyond what's already there.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @support/web test -- TicketsFilterBar.test.tsx`
Expected: FAIL — `DateRangeFilter`'s "Created date" button doesn't exist yet (still native inputs), and no "Reset filters" button exists.

- [ ] **Step 3: Implement**

In `TicketsFilterBar.tsx`, replace the import of `Input` usage for dates — add the import:

```ts
import { DateRangeFilter } from './DateRangeFilter.tsx';
```

Replace the two `<label>...<Input type="date" .../></label>` blocks (lines 129-167) with:

```tsx
      <DateRangeFilter
        from={filters.createdFrom}
        to={filters.createdTo}
        onChange={(next) => onChange(next)}
      />
```

Add the reset button after it:

```tsx
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!hasActiveFilters}
        onClick={() => {
          setSearchInput('');
          onChange({
            q: '',
            priority: [],
            labelIds: [],
            subintentIds: [],
            assigneeIds: [],
            olderThanHours: '',
            statuses: [],
            createdFrom: '',
            createdTo: '',
          });
        }}
      >
        Reset filters
      </Button>
```

Add the `Button` import (`import { Button } from '../../components/ui/button.tsx';`) and compute `hasActiveFilters` right before the `return` statement:

```ts
  const hasActiveFilters =
    filters.q !== '' ||
    filters.priority.length > 0 ||
    filters.labelIds.length > 0 ||
    filters.subintentIds.length > 0 ||
    filters.assigneeIds.length > 0 ||
    filters.olderThanHours !== '' ||
    filters.statuses.length > 0 ||
    filters.createdFrom !== '' ||
    filters.createdTo !== '';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @support/web test -- TicketsFilterBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.tsx frontend/src/surfaces/agent-console/pages/Tickets/TicketsFilterBar.test.tsx
git commit -m "feat: swap native date inputs for DateRangeFilter, add Reset filters button"
```

---

## Task 8: Frontend — Created/Subintent/Ticket# columns in `TicketsListView`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx` (`TicketsListView`)
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`

**Interfaces:**
- Consumes: `conversation.created_at`/`.subintent`/`.number` (Task 1).
- Produces: nothing new consumed elsewhere — table markup only. Task 9 adds sort behavior on top of these same `<th>` cells.

- [ ] **Step 1: Fix the existing `row()` mock helper, then write the failing test**

`Tickets.test.tsx` already has a local `row(id, status, assignedAgentId)` helper (used by `'renders a claim action only for unassigned rows in list view'`) that builds an `AgentConversationSummary`-shaped object without `created_at`/`subintent`/`number`. Once Task 1 lands, that helper will fail to typecheck. Update it in place:

```ts
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
      created_at: '2026-08-01T00:00:00.000Z',
      subintent: null,
      number: 1,
    });
```

Then add a new test using the file's existing `renderTickets(path)` helper (defined at the top of the file, takes an optional path and defaults to `/tickets`):

```tsx
it('renders Created, Subintent, and Ticket # columns in list view', async () => {
  vi.mocked(agentApi.fetchInbox).mockResolvedValue({
    conversations: [
      {
        id: 'c1',
        player: { external_player_id: 'p1' },
        status: 'open',
        confirm_phase: 'none',
        last_message_preview: null,
        last_message_at: null,
        assigned_agent_id: null,
        assigned_agent_name: null,
        priority: 'p1',
        tags: [],
        created_at: '2026-08-15T14:30:00.000Z',
        subintent: { id: 's1', name: 'Refund request' },
        number: 42,
      },
    ],
    nextCursor: null,
  });

  renderTickets('/tickets?view=list');

  expect(await screen.findByText('Refund request')).toBeInTheDocument();
  expect(screen.getByText('42')).toBeInTheDocument();
  expect(screen.getByText(/Aug 15, 2026/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test -- Tickets.test.tsx`
Expected: FAIL — columns don't exist yet. Also run `pnpm --filter @support/web typecheck` and fix any other test file's mock `AgentConversationSummary` objects the same way the `row()` helper above was fixed — grep `grep -rl "confirm_phase:" frontend/src` to find every mock object needing the three new fields (`TicketsFilterBar.test.tsx` doesn't build this type, but other agent-console test files might).

- [ ] **Step 3: Implement**

In `Tickets.tsx`'s `TicketsListView`, add three `<th>` after `Tags` (in the `<thead>` around line 240-247):

```tsx
              <th className="px-4 py-2.5">Created</th>
              <th className="px-4 py-2.5">Subintent</th>
              <th className="px-4 py-2.5">Ticket #</th>
```

Add the import at the top of `Tickets.tsx`: `import { format } from 'date-fns';`

Add three `<td>` after the Tags `<td>` (before the actions `<td>`, around line 283):

```tsx
                  <td className="px-4 py-2.5 text-muted">
                    {format(new Date(conversation.created_at), 'MMM d, yyyy h:mm a')}
                  </td>
                  <td className="max-w-32 truncate px-4 py-2.5 text-muted">
                    {conversation.subintent?.name ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-muted">
                    {conversation.number}
                  </td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test -- Tickets.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full frontend suite and typecheck**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web test`
Expected: all pass — this confirms every mock object across the suite was updated per Step 2's grep.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx
git commit -m "feat: add Created, Subintent, and Ticket # columns to Tickets list view"
```

---

## Task 9: Frontend — sortable column headers in `TicketsListView`

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx` (`TicketsListView`, `toQueryFilters`)
- Test: `frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.test.tsx`, `Tickets.test.tsx`

**Interfaces:**
- Consumes: `TicketsFilters.sortBy`/`.sortDir`/`.sortBy2`/`.sortDir2` (Task 4), `useTicketsFilters`'s `update` function.
- Produces: nothing consumed by later tasks — this is the final piece.

- [ ] **Step 1: Write the failing `SortableHeader` test**

Create `frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SortableHeader } from './SortableHeader.tsx';

describe('SortableHeader', () => {
  it('shows no arrow when this column is not the primary or secondary sort', () => {
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Player" sortKey="player" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={vi.fn()} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.queryByLabelText(/sorted/i)).not.toBeInTheDocument();
  });

  it('shows a primary-styled ascending arrow when this column is the primary sort', () => {
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Priority" sortKey="priority" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={vi.fn()} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByLabelText('sorted ascending, primary')).toBeInTheDocument();
  });

  it('clicking an inactive column promotes it to primary', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Assignee" sortKey="assignee" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Assignee' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'assignee',
      primaryDir: 'asc',
      secondary: 'priority',
      secondaryDir: 'asc',
    });
  });

  it('clicking the active primary column flips its direction only', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Priority" sortKey="priority" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Priority' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'priority',
      primaryDir: 'desc',
      secondary: 'created',
      secondaryDir: 'asc',
    });
  });

  it('clicking the active secondary column flips its direction only', async () => {
    const onSort = vi.fn();
    render(
      <table>
        <thead>
          <tr>
            <SortableHeader label="Created" sortKey="created" sort={{ primary: 'priority', primaryDir: 'asc', secondary: 'created', secondaryDir: 'asc' }} onSort={onSort} />
          </tr>
        </thead>
      </table>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Created' }));
    expect(onSort).toHaveBeenCalledWith({
      primary: 'priority',
      primaryDir: 'asc',
      secondary: 'created',
      secondaryDir: 'desc',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test -- SortableHeader.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `SortableHeader`**

Create `frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.tsx`:

```tsx
import { ArrowDown, ArrowUp } from 'lucide-react';
import { cn } from '../../lib/cn.ts';

export type SortState = {
  primary: string;
  primaryDir: 'asc' | 'desc';
  secondary: string;
  secondaryDir: 'asc' | 'desc';
};

export function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (next: SortState) => void;
  className?: string;
}) {
  const isPrimary = sort.primary === sortKey;
  const isSecondary = sort.secondary === sortKey;
  const dir = isPrimary ? sort.primaryDir : isSecondary ? sort.secondaryDir : null;

  function handleClick() {
    if (isPrimary) {
      onSort({ ...sort, primaryDir: sort.primaryDir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    if (isSecondary) {
      onSort({ ...sort, secondaryDir: sort.secondaryDir === 'asc' ? 'desc' : 'asc' });
      return;
    }
    // Not active: promote to primary, demote the old primary to secondary,
    // drop the old secondary — the 2-key cap.
    onSort({ primary: sortKey, primaryDir: 'asc', secondary: sort.primary, secondaryDir: sort.primaryDir });
  }

  return (
    <th className={cn('px-4 py-2.5', className)}>
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-1 hover:text-text"
      >
        {label}
        {dir && (
          <span
            aria-label={`sorted ${dir === 'asc' ? 'ascending' : 'descending'}, ${isPrimary ? 'primary' : 'secondary'}`}
            className={cn(isPrimary ? 'text-text' : 'text-muted')}
          >
            {dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
          </span>
        )}
      </button>
    </th>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test -- SortableHeader.test.tsx`
Expected: PASS

- [ ] **Step 5: Write failing `Tickets.test.tsx` integration tests**

Add to `Tickets.test.tsx`:

```tsx
it('defaults list view sort to Priority asc, Created asc, shown on both headers', async () => {
  vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
  renderTickets('/tickets?view=list');

  await screen.findByText('Priority');
  expect(screen.getByLabelText('sorted ascending, primary')).toBeInTheDocument();
  expect(screen.getByLabelText('sorted ascending, secondary')).toBeInTheDocument();
});

it('clicking a column header re-fetches with the new sort params', async () => {
  vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
  renderTickets('/tickets?view=list');
  await screen.findByText('Assignee');

  await userEvent.click(screen.getByRole('button', { name: 'Assignee' }));

  await waitFor(() =>
    expect(agentApi.fetchInbox).toHaveBeenCalledWith(
      expect.anything(),
      'all',
      expect.objectContaining({ sortBy: 'assignee', sortDir: 'asc', sortBy2: 'priority', sortDir2: 'asc' }),
      undefined,
    ),
  );
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `pnpm --filter @support/web test -- Tickets.test.tsx`
Expected: FAIL — headers aren't sortable yet, `toQueryFilters` doesn't send sort params.

- [ ] **Step 7: Wire sort state through `Tickets.tsx`**

In `toQueryFilters` (lines 55-66), add the four sort fields:

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
    sortBy: f.sortBy,
    sortDir: f.sortDir,
    sortBy2: f.sortBy2,
    sortDir2: f.sortDir2,
  };
}
```

In `TicketsListView`'s props, accept `sort: SortState` and `onSort: (next: SortState) => void` (passed down from `Tickets()`, which owns `filters`/`updateFilters`):

```tsx
function TicketsListView({
  token,
  queryFilters,
  sort,
  onSort,
  onSelect,
}: {
  token: string;
  queryFilters: TicketsQueryFilters;
  sort: SortState;
  onSort: (next: SortState) => void;
  onSelect: (id: string) => void;
}) {
```

Import `SortableHeader`/`SortState`: `import { SortableHeader, type SortState } from './SortableHeader.tsx';`

Replace every plain `<th>` in the `<thead>` (Player, Status, Priority, Assignee, Last message, Tags, and the three new ones from Task 8) with `<SortableHeader>`:

```tsx
            <tr className="border-b border-slate-200 text-left text-xs font-semibold tracking-wide text-muted uppercase">
              <SortableHeader label="Player" sortKey="player" sort={sort} onSort={onSort} />
              <SortableHeader label="Status" sortKey="status" sort={sort} onSort={onSort} />
              <SortableHeader label="Priority" sortKey="priority" sort={sort} onSort={onSort} />
              <SortableHeader label="Assignee" sortKey="assignee" sort={sort} onSort={onSort} />
              <SortableHeader label="Last message" sortKey="lastMessage" sort={sort} onSort={onSort} />
              <SortableHeader label="Tags" sortKey="tags" sort={sort} onSort={onSort} />
              <SortableHeader label="Created" sortKey="created" sort={sort} onSort={onSort} />
              <SortableHeader label="Subintent" sortKey="subintent" sort={sort} onSort={onSort} />
              <SortableHeader label="Ticket #" sortKey="number" sort={sort} onSort={onSort} />
              <th className="px-4 py-2.5" />
            </tr>
```

In `Tickets()`, where `<TicketsListView .../>` is rendered (list-view branch near the end of the component), pass the sort props through from `filters`/`updateFilters`:

```tsx
        <TicketsListView
          token={session.token}
          queryFilters={queryFilters}
          sort={{
            primary: filters.sortBy,
            primaryDir: filters.sortDir,
            secondary: filters.sortBy2,
            secondaryDir: filters.sortDir2,
          }}
          onSort={(next) =>
            updateFilters({
              sortBy: next.primary,
              sortDir: next.primaryDir,
              sortBy2: next.secondary,
              sortDir2: next.secondaryDir,
            })
          }
          onSelect={(id) => navigate(`/tickets/${id}`)}
        />
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @support/web test -- Tickets.test.tsx SortableHeader.test.tsx`
Expected: PASS

- [ ] **Step 9: Run full frontend suite, typecheck, and lint**

Run: `pnpm --filter @support/web typecheck && pnpm --filter @support/web test && pnpm --filter @support/web lint`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.tsx frontend/src/surfaces/agent-console/pages/Tickets/SortableHeader.test.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx
git commit -m "feat: sortable column headers in Tickets list view"
```

---

## Task 10: Full-repo verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole workspace test suite**

Run: `pnpm test`
Expected: all packages pass (backend needs Postgres up — `docker compose up -d postgres redis` first if not already running, per `README.md`).

- [ ] **Step 2: Run the whole workspace typecheck**

Run: `pnpm typecheck`
Expected: PASS across `@support/api`, `@support/web`, and `@support/types`.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`, open the agent console, navigate to Tickets → List view:
- Confirm the date-range picker opens a calendar popover, selecting a range filters the list and updates the URL.
- Confirm "Reset filters" is disabled at rest, enables once any filter is set, and clears everything except the board/list toggle when clicked.
- Confirm Created/Subintent/Ticket # columns render real data.
- Confirm clicking each column header sorts correctly, the two-arrow default (Priority asc, Created asc) shows on load, and clicking a third column drops the previous secondary.

- [ ] **Step 4: Commit if the smoke test surfaced any fixes**

```bash
git add -A
git commit -m "fix: address issues found in Tickets sort/columns smoke test"
```

(Skip this step entirely if the smoke test found nothing to fix.)
