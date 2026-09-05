# Team Page Workload Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "Set on leave" toggle from the Team page and add four new per-agent columns (Role, Open/Capacity, Escalated, Overdue) so a team lead gets a more useful read of the roster.

**Architecture:** Backend: extend `getWorkspaceWorkload` in `conversationsService.ts` with three new grouped-count queries (escalated, overdue) plus one scalar (workspace capacity), and a `role` field already available from an existing join. Frontend: `Workload.tsx` drops the leave column/dialog/handler and renders the four new columns, extending the existing client-side sort.

**Tech Stack:** Express + Drizzle ORM + PostgreSQL (backend), React + TanStack Query + Tailwind (frontend), Vitest for both.

## Global Constraints

- Full spec: `docs/specs/2026-09-03-team-page-workload-metrics-design.md`.
- Leave removal is UI-only — do not touch the `agent_status` enum, `on_leave_since`/`on_leave_until` columns, the `PATCH /agents/:id/leave` route, `agentsService.ts`, or `leaveExpiry.ts`.
- "Overdue" = an open conversation assigned to the agent where the **player's** latest message is more than **4 hours** old. Not based on `resolutionCycle.inactivityDueAt`.
- No DB schema or migration changes — everything is derived from existing columns.
- When adding any new API response field, keep `backend/src/docs/openapi.ts` in sync (per this repo's CLAUDE.md).

---

### Task 1: Backend — role, capacity, escalated, and overdue metrics on `getWorkspaceWorkload`

**Files:**

- Modify: `backend/src/agent/services/conversationsService.ts:977-1077` (types + `getWorkspaceWorkload`)
- Modify: `backend/src/docs/openapi.ts:722-740` (`AgentWorkspaceWorkloadSchema`)
- Modify: `backend/tests/helpers/db.ts:55-82` (`seedWorkspace` — add `maxAssignedTickets` override)
- Test: `backend/tests/agent.workload.test.ts`

**Interfaces:**

- Produces: `WorkspaceWorkloadAgent` gains `role: 'agent' | 'team_lead'`, `capacityMax: number`, `escalatedCount: number`, `overdueCount: number`. The `GET /agent/workload` JSON response carries the same four fields per agent (Task 2 consumes exactly this shape on the frontend).

- [ ] **Step 1: Add `maxAssignedTickets` override to the `seedWorkspace` test helper**

In `backend/tests/helpers/db.ts`, update `seedWorkspace`:

```ts
export async function seedWorkspace(
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    disabledAt?: Date | null;
    autoCloseDays?: number;
    formTimeoutMinutes?: number;
    inactivityWindowHours?: number;
    maxAssignedTickets?: number;
  } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const slug = overrides.slug ?? `ws-${id.slice(0, 8)}`;
  await ownerPool.query(
    `insert into workspace (id, name, slug, disabled_at, auto_close_days, form_timeout_minutes, inactivity_window_hours, max_assigned_tickets)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      overrides.name ?? slug,
      slug,
      overrides.disabledAt ?? null,
      overrides.autoCloseDays ?? 7,
      overrides.formTimeoutMinutes ?? 30,
      overrides.inactivityWindowHours ?? 24,
      overrides.maxAssignedTickets ?? 5,
    ],
  );
  return id;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `backend/tests/agent.workload.test.ts`, inside a new `describe` block after the existing ones:

```ts
describe('GET /agent/workload — new metrics', () => {
  it('returns each roster member’s workspace role', async () => {
    const workspaceId = await seedWorkspace();
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);

    expect(res.status).toBe(200);
    const roles = new Set(res.body.agents.map((a: { role: string }) => a.role));
    expect(roles).toEqual(new Set(['agent', 'team_lead']));
  });

  it('returns the workspace’s maxAssignedTickets as capacityMax for every agent', async () => {
    const workspaceId = await seedWorkspace({ maxAssignedTickets: 3 });
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);

    expect(res.status).toBe(200);
    for (const a of res.body.agents) {
      expect(a.capacityMax).toBe(3);
    }
  });

  it('counts escalated conversations separately from other open statuses', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedConversation({
      workspaceId,
      playerId,
      status: 'escalated',
      assignedAgentId: workerAgentId,
    });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);

    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.openCount).toBe(2);
    expect(worker.escalatedCount).toBe(1);
  });

  it('counts a conversation as overdue when the player’s latest message is more than 4 hours old', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const staleConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId: staleConversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(1);
  });

  it('does not count a conversation as overdue when the player’s message is recent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const freshConversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId: freshConversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(0);
  });

  it('does not count a conversation as overdue when the agent replied last, even if that reply is old', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const { token: teamLeadToken } = await seedAgentWithRole(workspaceId, 'team_lead');
    const workerAgentId = await seedAgent('worker@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: workerAgentId, role: 'agent' });

    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: workerAgentId,
    });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 1,
      authorType: 'player',
      createdAt: new Date(Date.now() - 10 * 60 * 60 * 1000),
    });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      createdAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get('/agent/workload')
      .set('Authorization', `Bearer ${teamLeadToken}`);
    const worker = res.body.agents.find((a: { agentId: string }) => a.agentId === workerAgentId);
    expect(worker.overdueCount).toBe(0);
  });
});
```

Make sure `seedMessage` is imported at the top of the test file alongside the other `seedXxx` helpers already imported from `./helpers/db.ts`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter backend test -- agent.workload.test.ts`
Expected: FAIL — `role`, `capacityMax`, `escalatedCount`, `overdueCount` are all `undefined` on the response rows.

- [ ] **Step 4: Implement the new fields in `getWorkspaceWorkload`**

In `backend/src/agent/services/conversationsService.ts`, add `workspace` to the existing schema import (it currently imports `agent, attachment, conversation, conversationTag, message, player, resolutionCycle, subintent, workspaceMember` from `'../../shared/db/schema/index.ts'` — add `workspace` to that list).

Replace the `WorkspaceWorkloadAgent` type and `getWorkspaceWorkload` function (lines 977-1077) with:

```ts
export type WorkspaceWorkloadAgent = {
  agentId: string;
  agentName: string;
  role: 'agent' | 'team_lead';
  openCount: number;
  capacityMax: number;
  escalatedCount: number;
  overdueCount: number;
  resolved7d: number;
  status: 'online' | 'away' | 'offline' | 'on_leave';
  onLeaveSince: Date | null;
  onLeaveUntil: Date | null;
};

export type WorkspaceWorkload = { agents: WorkspaceWorkloadAgent[] };

export async function getWorkspaceWorkload(ctx: AgentContext): Promise<WorkspaceWorkload> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [workspaceRow] = await tx
      .select({ maxAssignedTickets: workspace.maxAssignedTickets })
      .from(workspace)
      .where(eq(workspace.id, ctx.workspaceId));
    const capacityMax = workspaceRow?.maxAssignedTickets ?? 0;

    const openRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .where(
        and(
          isNotNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const escalatedRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .where(and(isNotNull(conversation.assignedAgentId), eq(conversation.status, 'escalated')))
      .groupBy(conversation.assignedAgentId);

    // One row per conversation: the message whose seq is the max seq for that
    // conversation. A correlated subquery on the same table, not a self-join,
    // because it must return exactly one row per conversation.
    const latestMessage = tx
      .select({
        conversationId: message.conversationId,
        authorType: message.authorType,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(
        sql`${message.seq} = (select max(m2.seq) from message m2 where m2.conversation_id = ${message.conversationId})`,
      )
      .as('latest_message');

    // "Overdue" is deliberately not resolutionCycle.inactivityDueAt — that
    // clock resets on a message from either side, so it can't attribute
    // silence to the agent. This counts only conversations where the PLAYER's
    // latest message is the one still waiting on a reply, past 4 hours.
    const overdueRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(conversation)
      .innerJoin(latestMessage, eq(latestMessage.conversationId, conversation.id))
      .where(
        and(
          isNotNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
          eq(latestMessage.authorType, 'player'),
          sql`${latestMessage.createdAt} < now() - interval '4 hours'`,
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const resolvedRows = await tx
      .select({
        agentId: conversation.assignedAgentId,
        count: sql<number>`count(*)`,
      })
      .from(resolutionCycle)
      .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
      .where(
        and(
          sql`${resolutionCycle.resolvedAt} >= now() - interval '7 days'`,
          isNotNull(conversation.assignedAgentId),
        ),
      )
      .groupBy(conversation.assignedAgentId);

    const roster = await tx
      .select({
        agentId: workspaceMember.agentId,
        role: workspaceMember.role,
        agentName: agent.displayName,
        agentStatus: agent.status,
        onLeaveSince: agent.onLeaveSince,
        onLeaveUntil: agent.onLeaveUntil,
      })
      .from(workspaceMember)
      .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
      .where(
        and(
          eq(workspaceMember.workspaceId, ctx.workspaceId),
          inArray(workspaceMember.role, ['agent', 'team_lead']),
          isNull(workspaceMember.deactivatedAt),
        ),
      );

    const openByAgent = new Map(openRows.map((r) => [r.agentId as string, Number(r.count)]));
    const escalatedByAgent = new Map(
      escalatedRows.map((r) => [r.agentId as string, Number(r.count)]),
    );
    const overdueByAgent = new Map(overdueRows.map((r) => [r.agentId as string, Number(r.count)]));
    const resolvedByAgent = new Map(
      resolvedRows.map((r) => [r.agentId as string, Number(r.count)]),
    );

    let presenceByAgent: Map<string, 'online' | 'away' | 'offline'>;
    try {
      presenceByAgent = await getPresenceStatusBatch(roster.map((member) => member.agentId));
    } catch (error) {
      logger.error(
        'workload',
        `presence batch read failed, falling back to offline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      presenceByAgent = new Map();
    }

    const agents: WorkspaceWorkloadAgent[] = roster.map((member) => ({
      agentId: member.agentId,
      agentName: member.agentName,
      role: member.role,
      openCount: openByAgent.get(member.agentId) ?? 0,
      capacityMax,
      escalatedCount: escalatedByAgent.get(member.agentId) ?? 0,
      overdueCount: overdueByAgent.get(member.agentId) ?? 0,
      resolved7d: resolvedByAgent.get(member.agentId) ?? 0,
      status:
        member.agentStatus === 'on_leave'
          ? 'on_leave'
          : (presenceByAgent.get(member.agentId) ?? 'offline'),
      onLeaveSince: member.agentStatus === 'on_leave' ? member.onLeaveSince : null,
      onLeaveUntil: member.agentStatus === 'on_leave' ? member.onLeaveUntil : null,
    }));

    return { agents };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter backend test -- agent.workload.test.ts`
Expected: PASS — all tests in the file, including the pre-existing ones and the five new ones.

- [ ] **Step 6: Update the OpenAPI schema**

In `backend/src/docs/openapi.ts`, extend `AgentWorkspaceWorkloadSchema` (lines 722-740):

```ts
const AgentWorkspaceWorkloadSchema = z.object({
  agents: z.array(
    z.object({
      agentId: z.uuid(),
      agentName: z.string(),
      role: z.enum(['agent', 'team_lead']),
      openCount: z.number().int(),
      capacityMax: z.number().int().openapi({
        description: 'The workspace’s max-assigned-tickets cap. Same value for every agent.',
      }),
      escalatedCount: z.number().int().openapi({
        description: 'Of this agent’s open tickets, how many are currently escalated.',
      }),
      overdueCount: z.number().int().openapi({
        description:
          'Open tickets assigned to this agent where the player’s latest message has gone unanswered for more than 4 hours.',
      }),
      resolved7d: z.number().int(),
      status: z.enum(['online', 'away', 'offline', 'on_leave']).openapi({
        description:
          'on_leave overrides live presence unconditionally; otherwise online/away from Redis while connected, offline otherwise (including when Redis is unreachable).',
      }),
      onLeaveSince: z.iso.datetime().nullable(),
      onLeaveUntil: z.iso.datetime().nullable().openapi({
        description:
          'Planned return date, if a duration was set. Null = indefinite. Not auto-enforced.',
      }),
    }),
  ),
});
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter backend typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/docs/openapi.ts backend/tests/helpers/db.ts backend/tests/agent.workload.test.ts
git commit -m "Add role, capacity, escalated, and overdue metrics to workload endpoint"
```

---

### Task 2: Frontend — Team page: remove leave toggle, add new columns

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts:348-356` (`AgentWorkloadEntry`)
- Modify: `frontend/src/surfaces/agent-console/pages/Workload/Workload.tsx` (whole file)
- Test: `frontend/src/surfaces/agent-console/pages/Workload/Workload.test.tsx`

**Interfaces:**

- Consumes: `WorkspaceWorkloadAgent` shape from Task 1 — `role`, `capacityMax`, `escalatedCount`, `overdueCount` alongside the existing `agentId`, `agentName`, `openCount`, `resolved7d`, `status`, `onLeaveSince`, `onLeaveUntil`.

- [ ] **Step 1: Extend the `AgentWorkloadEntry` type**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, update the type (around line 348):

```ts
export type AgentWorkloadEntry = {
  agentId: string;
  agentName: string;
  role: 'agent' | 'team_lead';
  openCount: number;
  capacityMax: number;
  escalatedCount: number;
  overdueCount: number;
  resolved7d: number;
  status: DisplayStatus;
  onLeaveSince: string | null;
  onLeaveUntil: string | null;
};
```

Leave `setAgentLeave` and its return type in this file untouched — the route still exists server-side, this page just stops calling it.

- [ ] **Step 2: Rewrite `Workload.test.tsx` for the new columns and dropped leave toggle**

Replace the whole file at `frontend/src/surfaces/agent-console/pages/Workload/Workload.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Workload } from './Workload.tsx';
import { loadAgentSession } from '../../lib/agentSession.ts';
import * as agentApi from '../../api/agentApi.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';

vi.mock('../../lib/agentSession.ts', async () => {
  const actual = await vi.importActual<typeof import('../../lib/agentSession.ts')>(
    '../../lib/agentSession.ts',
  );
  return { ...actual, loadAgentSession: vi.fn() };
});

vi.mock('../../../../features/chat/api/socket.ts');

/** Captures the handlers Workload registers so a test can fire a server event. */
function fakeSocket() {
  const handlers: Record<string, (payload?: unknown) => void> = {};
  const socket = {
    on: (event: string, handler: (payload?: unknown) => void) => {
      handlers[event] = handler;
    },
    emit: vi.fn(),
    close: vi.fn(),
  };
  vi.mocked(createSocket).mockReturnValue(socket as never);
  return handlers;
}

function renderWithClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Workload />
    </QueryClientProvider>,
  );
}

function rowNames() {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((row) => within(row).getByTestId('agent-name').textContent);
}

let socketHandlers: Record<string, (payload?: unknown) => void> = {};

beforeEach(() => {
  socketHandlers = fakeSocket();
  vi.mocked(loadAgentSession).mockReturnValue({
    token: 't',
    agentId: 'a1',
    displayName: 'A',
    workspaceSlug: 'ws',
  });
  vi.spyOn(agentApi, 'fetchWorkload').mockResolvedValue({
    agents: [
      {
        agentId: '1',
        agentName: 'Alice',
        role: 'agent',
        openCount: 3,
        capacityMax: 5,
        escalatedCount: 0,
        overdueCount: 0,
        resolved7d: 10,
        status: 'online',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
      {
        agentId: '2',
        agentName: 'Bob',
        role: 'team_lead',
        openCount: 8,
        capacityMax: 5,
        escalatedCount: 2,
        overdueCount: 1,
        resolved7d: 2,
        status: 'away',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
      {
        agentId: '3',
        agentName: 'Carol',
        role: 'agent',
        openCount: 5,
        capacityMax: 5,
        escalatedCount: 1,
        overdueCount: 0,
        resolved7d: 20,
        status: 'offline',
        onLeaveSince: null,
        onLeaveUntil: null,
      },
    ],
  });
});

describe('Workload sorting', () => {
  it('defaults to Open descending', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    expect(rowNames()).toEqual(['Bob', 'Carol', 'Alice']);
  });

  it('re-sorts by Agent ascending then descending on repeated clicks, without refetching', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');
    const fetchCountAfterLoad = vi.mocked(agentApi.fetchWorkload).mock.calls.length;

    // First click on a new column sorts descending by that column...
    await user.click(screen.getByRole('button', { name: /^agent$/i }));
    expect(rowNames()).toEqual(['Carol', 'Bob', 'Alice']);

    // ...second click on the same column flips to ascending.
    await user.click(screen.getByRole('button', { name: /^agent$/i }));
    expect(rowNames()).toEqual(['Alice', 'Bob', 'Carol']);

    // Sorting is client-only re-ordering of already-loaded data — no refetch.
    expect(agentApi.fetchWorkload).toHaveBeenCalledTimes(fetchCountAfterLoad);
  });

  it('re-sorts by Resolved (7d) descending on first click', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /resolved/i }));
    expect(rowNames()).toEqual(['Carol', 'Alice', 'Bob']);
  });

  it('re-sorts by Open ascending on click since it starts sorted descending', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /^open$/i }));
    expect(rowNames()).toEqual(['Alice', 'Carol', 'Bob']);
  });

  it('sorts by Escalated descending on first click', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /^escalated$/i }));
    expect(rowNames()).toEqual(['Bob', 'Carol', 'Alice']);
  });

  it('sorts by Overdue descending on first click', async () => {
    const user = userEvent.setup();
    renderWithClient();

    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: /^overdue$/i }));
    expect(rowNames()).toEqual(['Bob', 'Alice', 'Carol']);
  });
});

function rowStatuses() {
  const rows = screen.getAllByRole('row').slice(1); // drop header row
  return rows.map((row) => {
    const cell = within(row).getAllByRole('cell')[0]!;
    return within(cell).getByTestId('presence-dot').getAttribute('data-status');
  });
}

describe('Workload presence', () => {
  it('renders a status dot for each agent', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    // Default sort is Open descending: Bob, Carol, Alice.
    expect(rowStatuses()).toEqual(['away', 'offline', 'online']);
  });

  it('patches a row in place on a presence_changed event, without refetching', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    const fetchCountAfterLoad = vi.mocked(agentApi.fetchWorkload).mock.calls.length;

    socketHandlers['presence_changed']?.({ agentId: '3', status: 'online' });

    await screen.findByText('Carol');
    expect(rowStatuses()).toEqual(['away', 'online', 'online']);
    expect(agentApi.fetchWorkload).toHaveBeenCalledTimes(fetchCountAfterLoad);
  });
});

describe('Workload roster metrics', () => {
  it('shows a role badge for each agent', async () => {
    renderWithClient();

    const aliceRow = await screen.findByText('Alice').then((el) => el.closest('tr')!);
    const bobRow = screen.getByText('Bob').closest('tr')!;
    expect(within(aliceRow).getByText('Agent')).toBeInTheDocument();
    expect(within(bobRow).getByText('Team lead')).toBeInTheDocument();
  });

  it('shows open count against capacity', async () => {
    renderWithClient();

    const bobRow = await screen.findByText('Bob').then((el) => el.closest('tr')!);
    expect(within(bobRow).getByText('8/5')).toBeInTheDocument();
  });

  it('flags a row as at-capacity when open count meets or exceeds capacityMax', async () => {
    renderWithClient();

    const bobRow = await screen.findByText('Bob').then((el) => el.closest('tr')!);
    const carolRow = screen.getByText('Carol').closest('tr')!;
    const aliceRow = screen.getByText('Alice').closest('tr')!;
    expect(within(bobRow).getByTestId('capacity-cell')).toHaveAttribute('data-at-capacity', 'true');
    expect(within(carolRow).getByTestId('capacity-cell')).toHaveAttribute(
      'data-at-capacity',
      'true',
    );
    expect(within(aliceRow).getByTestId('capacity-cell')).toHaveAttribute(
      'data-at-capacity',
      'false',
    );
  });

  it('shows escalated and overdue counts', async () => {
    renderWithClient();

    const bobRow = await screen.findByText('Bob').then((el) => el.closest('tr')!);
    expect(within(bobRow).getByTestId('escalated-count').textContent).toBe('2');
    expect(within(bobRow).getByTestId('overdue-count').textContent).toBe('1');
  });

  it('no longer shows a leave toggle or leave column', async () => {
    renderWithClient();

    await screen.findByText('Alice');
    expect(screen.queryByRole('button', { name: /set on leave/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear leave/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^leave$/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @support/web test -- Workload.test.tsx`
Expected: FAIL — new columns/testids don't exist yet, and the old leave-toggle tests are gone so no failures from those, but the new roster-metrics tests fail (role/capacity/escalated/overdue not rendered), and the `fetchWorkload` mock's new required fields mean TypeScript may also flag the old `Workload.tsx` importing `setAgentLeave` unused once Step 4 runs — for now just confirm the new assertions fail.

- [ ] **Step 4: Rewrite `Workload.tsx`**

Replace the whole file at `frontend/src/surfaces/agent-console/pages/Workload/Workload.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  fetchWorkload,
  type AgentWorkloadEntry,
  type AgentWorkloadResponse,
  type DisplayStatus,
} from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { createSocket } from '../../../../features/chat/api/socket.ts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.tsx';
import { Avatar, AvatarFallback } from '../../components/ui/avatar.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { PresenceDot } from '../../components/PresenceDot.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { cn } from '../../lib/cn.ts';

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

type SortColumn = 'agent' | 'open' | 'escalated' | 'overdue' | 'resolved7d';
type SortDirection = 'asc' | 'desc';

const COLUMNS: { key: SortColumn; label: string }[] = [
  { key: 'agent', label: 'Agent' },
  { key: 'open', label: 'Open' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'resolved7d', label: 'Resolved (7d)' },
];

const ROLE_LABEL: Record<AgentWorkloadEntry['role'], string> = {
  agent: 'Agent',
  team_lead: 'Team lead',
};

function initialsFor(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function sortAgents(
  agents: AgentWorkloadEntry[],
  column: SortColumn,
  direction: SortDirection,
): AgentWorkloadEntry[] {
  const sorted = [...agents].sort((a, b) => {
    let cmp: number;
    if (column === 'agent') cmp = a.agentName.localeCompare(b.agentName);
    else if (column === 'open') cmp = a.openCount - b.openCount;
    else if (column === 'escalated') cmp = a.escalatedCount - b.escalatedCount;
    else if (column === 'overdue') cmp = a.overdueCount - b.overdueCount;
    else cmp = a.resolved7d - b.resolved7d;
    return direction === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

export function Workload() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  // Default sort is Open descending.
  const [sortColumn, setSortColumn] = useState<SortColumn>('open');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const workload = useQuery({
    queryKey: ['workload'],
    queryFn: () => fetchWorkload(session!.token),
    enabled: session !== null,
  });

  const sessionToken = session?.token;
  const sessionWorkspaceId = session?.workspaceId;

  useEffect(() => {
    if (!sessionToken) return;
    const socket = createSocket(sessionToken, 'agent', sessionWorkspaceId);
    socket.on(
      'presence_changed',
      (payload: {
        agentId: string;
        status: DisplayStatus;
        onLeaveSince?: string | null;
        onLeaveUntil?: string | null;
      }) => {
        queryClient.setQueryData<AgentWorkloadResponse>(['workload'], (current) => {
          if (!current) return current;
          return {
            agents: current.agents.map((agent) =>
              agent.agentId === payload.agentId
                ? {
                    ...agent,
                    status: payload.status,
                    onLeaveSince:
                      payload.status === 'on_leave'
                        ? (payload.onLeaveSince ?? agent.onLeaveSince)
                        : null,
                    onLeaveUntil:
                      payload.status === 'on_leave'
                        ? (payload.onLeaveUntil ?? agent.onLeaveUntil)
                        : null,
                  }
                : agent,
            ),
          };
        });
      },
    );
    return () => {
      socket.close();
    };
  }, [sessionToken, sessionWorkspaceId, queryClient]);

  if (!session) return null;

  function handleSort(column: SortColumn) {
    if (column === sortColumn) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('desc');
    }
  }

  const agents = workload.data?.agents ?? [];
  const sortedAgents = sortAgents(agents, sortColumn, sortDirection);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-slate-200 p-3">
        <h1 className="text-sm font-semibold">Team</h1>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {workload.data && sortedAgents.length === 0 ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {COLUMNS.map((col) => (
                  <TableHead key={col.key}>
                    <button
                      type="button"
                      onClick={() => handleSort(col.key)}
                      className={cn(
                        'flex items-center gap-1 text-xs font-medium text-muted hover:text-text',
                      )}
                    >
                      {col.label}
                      {sortColumn === col.key &&
                        (sortDirection === 'asc' ? (
                          <ArrowUp className="size-3" />
                        ) : (
                          <ArrowDown className="size-3" />
                        ))}
                    </button>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedAgents.map((agent) => {
                const atCapacity = agent.openCount >= agent.capacityMax;
                return (
                  <TableRow key={agent.agentId}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div className="relative">
                          <Avatar className="size-6">
                            <AvatarFallback className="text-xs">
                              {initialsFor(agent.agentName)}
                            </AvatarFallback>
                          </Avatar>
                          <PresenceDot
                            status={agent.status}
                            className="absolute -right-0.5 -bottom-0.5 size-2"
                          />
                        </div>
                        <span data-testid="agent-name">{agent.agentName}</span>
                        <Badge variant="secondary">{ROLE_LABEL[agent.role]}</Badge>
                        {agent.status === 'on_leave' && agent.onLeaveSince && (
                          <span data-testid="leave-duration" className="text-xs text-muted">
                            on leave {daysSince(agent.onLeaveSince)}d
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        data-testid="capacity-cell"
                        data-at-capacity={atCapacity}
                        className={cn(atCapacity && 'font-medium text-amber-700')}
                      >
                        {agent.openCount}/{agent.capacityMax}
                      </span>
                    </TableCell>
                    <TableCell data-testid="escalated-count">{agent.escalatedCount}</TableCell>
                    <TableCell data-testid="overdue-count">{agent.overdueCount}</TableCell>
                    <TableCell>{agent.resolved7d}</TableCell>
                  </TableRow>
                );
              })}
              {workload.isError && (
                <TableRow>
                  <TableCell colSpan={5} className="text-xs text-muted">
                    Could not load workload.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @support/web test -- Workload.test.tsx`
Expected: PASS — all tests in the file.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @support/web typecheck`
Expected: no errors. (Confirms nothing else in the frontend still imports `setAgentLeave`/`LeaveDialog` from this page, and that `AgentWorkloadEntry` consumers are all updated.)

- [ ] **Step 7: Manually verify in the browser**

Run: `pnpm dev`, log in as a team lead, open the Team page. Confirm: no leave button/column, role badges render, Open shows as "N/M", an over-capacity row is visually flagged, Escalated/Overdue columns show and sort correctly.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/Workload/Workload.tsx frontend/src/surfaces/agent-console/pages/Workload/Workload.test.tsx
git commit -m "Remove leave toggle from Team page, add role/capacity/escalated/overdue columns"
```

---

## Out of scope (per spec)

- Any change to `inactivityClock.ts` / `resolutionCycle.ts` — separate design pass.
- Full teardown of the leave feature (DB columns, enum value, route, job, `LeaveDialog.tsx`, `agentsService.setAgentLeaveStatus`) — left in place, unused by this page.
