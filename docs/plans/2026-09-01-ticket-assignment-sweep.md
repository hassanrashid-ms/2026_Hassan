# Ticket Assignment Sweep + Manual Unassign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drain the unassigned-conversation queue (priority, then age) into whoever is online and under cap, triggered automatically when an agent comes online and manually via a Team Lead/Admin button on the Tickets tab, plus let an agent release one of their own tickets back to the queue.

**Architecture:** Two new backend service modules — a single-ticket picker (`assignNextTicket`) that reuses the existing least-loaded-online-agent logic from `assignOnHandoff`, and a loop around it (`sweepUnassignedQueue`) that drains the queue one ticket at a time so load interleaves across whoever is online. Two new routes (`unassign`, `sweep-assign`) plumb into the existing conversations service/controller/router layers. A presence-online socket hook and a console button both call the sweep; a new console button calls unassign.

**Tech Stack:** Express 5 + TypeScript + Zod, Drizzle ORM (Postgres, RLS via `withWorkspace`), Socket.io + Redis presence, Vite + React + TanStack Query (frontend), Vitest (backend + frontend tests).

## Global Constraints

- No hard deletes; all state changes go through one function that writes both `conversation` and `event` in the same transaction (`docs/specs/2026-09-01-ticket-assignment-sweep-design.md`, `CLAUDE.md` Data integrity).
- Every new API endpoint must be registered in `backend/src/docs/openapi.ts` (`CLAUDE.md` General).
- `PATCH /conversations/:id/assign` and `GET /workload`'s `requireTeamLeadOrAdmin` guard is the pattern the new `sweep-assign` route must reuse verbatim.
- Tailwind v4 utilities only on the frontend — no hand-written CSS classes.
- No `console.*` — use `logger` from `backend/src/shared/logging/logger.ts`.
- Spec: `docs/specs/2026-09-01-ticket-assignment-sweep-design.md`.

---

### Task 1: Extract the shared least-loaded-online-agent picker

**Files:**
- Create: `backend/src/domain/routing/pickEligibleAgent.ts`
- Modify: `backend/src/domain/bot/assignOnHandoff.ts`
- Test: `backend/tests/bot.assignment.test.ts` (existing — must still pass unmodified, proving the refactor is behavior-preserving)

**Interfaces:**
- Produces: `pickEligibleAgent(tx: Tx, workspaceId: string): Promise<string | null>` — the exact candidate-selection logic currently inline in `assignOnHandoff`. Task 2 depends on this signature.

- [ ] **Step 1: Run the existing test suite to capture the baseline**

Run: `pnpm --filter backend test bot.assignment.test.ts`
Expected: PASS (11 tests) — this is the behavior Task 1 must not change.

- [ ] **Step 2: Create `pickEligibleAgent.ts` with the extracted logic**

```typescript
// backend/src/domain/routing/pickEligibleAgent.ts
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { agent, conversation, workspace, workspaceMember } from '../../shared/db/schema/index.ts';
import { getPresenceStatusBatch } from '../../shared/realtime/presence.ts';
import { logger } from '../../shared/logging/logger.ts';

const LIVE_STATUSES = ['open', 'awaiting_player', 'escalated'] as const;

/**
 * Deterministic least-loaded, not round-robin — see the deviation recorded in
 * docs/decisions/spec-contradictions.md. Ties break by agent.id ascending, which
 * is what makes this testable without controlling a rotation cursor's starting
 * position. Returns null when no eligible agent is currently `online`; that is
 * not an error — the caller leaves the conversation unassigned.
 *
 * Shared by assignOnHandoff (bot handoff, one conversation) and
 * assignNextTicket (queue sweep, called once per ticket in a loop) — both need
 * the same "who gets the next one" answer, and re-reading live counts on every
 * call is what makes the sweep interleave across online agents instead of
 * filling one agent to their cap before considering anyone else.
 *
 * `online` only, not `away`: an agent who set themselves away has signalled
 * they don't want new work right now, same intent as `on_leave` — both are
 * excluded here, just via different signals (one a live Redis status, the
 * other a persisted account flag already filtered by `agent.status`).
 *
 * A Redis failure degrades to "nobody online" (fail-closed) rather than
 * silently ignoring presence and assigning anyway — same fallback direction
 * `conversationsService.ts`'s workload roster uses for a Redis-down read.
 */
export async function pickEligibleAgent(tx: Tx, workspaceId: string): Promise<string | null> {
  const liveCount = sql<number>`count(${conversation.id}) filter (where ${inArray(conversation.status, [...LIVE_STATUSES])})`;

  const rows = await tx
    .select({
      agentId: agent.id,
      liveCount,
    })
    .from(workspaceMember)
    .innerJoin(agent, eq(agent.id, workspaceMember.agentId))
    .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
    .leftJoin(
      conversation,
      and(eq(conversation.assignedAgentId, agent.id), eq(conversation.workspaceId, workspaceId)),
    )
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        isNull(workspaceMember.deactivatedAt),
        eq(agent.status, 'active'),
      ),
    )
    .groupBy(agent.id, workspace.maxAssignedTickets)
    // Excludes agents already at capacity — not just deprioritizes them.
    .having(lt(liveCount, workspace.maxAssignedTickets))
    .orderBy(liveCount, asc(agent.id));

  if (rows.length === 0) return null;

  let presenceByAgent: Map<string, 'online' | 'away' | 'offline'>;
  try {
    presenceByAgent = await getPresenceStatusBatch(rows.map((r) => r.agentId));
  } catch (error) {
    logger.error(
      'pick_eligible_agent',
      `presence batch read failed, treating every candidate as offline: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    presenceByAgent = new Map();
  }

  const online = rows.find((r) => presenceByAgent.get(r.agentId) === 'online');
  return online?.agentId ?? null;
}
```

- [ ] **Step 3: Replace `assignOnHandoff`'s body with a delegating call**

```typescript
// backend/src/domain/bot/assignOnHandoff.ts
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { pickEligibleAgent } from '../routing/pickEligibleAgent.ts';

/**
 * Thin wrapper over pickEligibleAgent, kept as its own named export because
 * every bot-handoff call site (applyBotTurn.ts, completeFormAndHandoff.ts,
 * messagesService.ts) reads clearly as "assign on handoff" at the call site.
 * See pickEligibleAgent.ts for the actual selection logic and its rationale.
 */
export async function assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null> {
  return pickEligibleAgent(tx, workspaceId);
}
```

- [ ] **Step 4: Run the existing test suite again to confirm the refactor is behavior-preserving**

Run: `pnpm --filter backend test bot.assignment.test.ts`
Expected: PASS (11 tests), identical to Step 1.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/domain/routing/pickEligibleAgent.ts backend/src/domain/bot/assignOnHandoff.ts
git commit -m "refactor: extract pickEligibleAgent from assignOnHandoff for reuse by the queue sweep"
```

---

### Task 2: `assignNextTicket` — single-ticket assignment

**Files:**
- Create: `backend/src/domain/routing/assignNextTicket.ts`
- Test: `backend/tests/routing.assignNextTicket.test.ts`

**Interfaces:**
- Consumes: `pickEligibleAgent(tx, workspaceId)` from Task 1.
- Produces: `assignNextTicket(workspaceId: string): Promise<{ conversationId: string; agentId: string; status: 'open' | 'escalated' } | null>`. Task 3 depends on this signature.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/tests/routing.assignNextTicket.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assignNextTicket } from '../src/domain/routing/assignNextTicket.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(
    `select status, assigned_agent_id from conversation where id = $1`,
    [id],
  );
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}

describe('assignNextTicket', () => {
  it('assigns the highest-priority unassigned conversation to the eligible agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const low = await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p3' });
    const high = await seedConversation({ workspaceId, playerId, status: 'open', priority: 'p1' });

    const result = await assignNextTicket(workspaceId);
    expect(result).toEqual({ conversationId: high, agentId, status: 'open' });

    const row = await conversationRow(high);
    expect(row.assigned_agent_id).toBe(agentId);
    const stillUnassigned = await conversationRow(low);
    expect(stillUnassigned.assigned_agent_id).toBeNull();
  });

  it('breaks a priority tie by age — oldest first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const older = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      priority: 'p2',
      createdAt: new Date('2026-01-02T00:00:00Z'),
    });

    const result = await assignNextTicket(workspaceId);
    expect(result?.conversationId).toBe(older);
  });

  it('writes a conversation_assigned event', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    await assignNextTicket(workspaceId);

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('conversation_assigned');
    expect(events[0].payload).toMatchObject({ agent_id: agentId, via: 'sweep' });
  });

  it('returns null and assigns nothing when the queue is empty', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
  });

  it('returns null and leaves the conversation unassigned when no agent is eligible', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBeNull();
  });

  it('never selects an awaiting_player conversation — it is not in the unassigned queue', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    // awaiting_player always has an owner in practice, but the query must not
    // pick one up even if assigned_agent_id were somehow null.
    await ownerPool.query(
      `insert into conversation (id, workspace_id, player_id, number, status, assigned_agent_id)
       select gen_random_uuid(), $1, $2, (select ticket_seq + 1 from workspace where id = $1), 'awaiting_player', null`,
      [workspaceId, playerId],
    );

    const result = await assignNextTicket(workspaceId);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test routing.assignNextTicket.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/routing/assignNextTicket.ts'`.

- [ ] **Step 3: Implement `assignNextTicket`**

```typescript
// backend/src/domain/routing/assignNextTicket.ts
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { appendEvent } from '../../shared/events/appendEvent.ts';
import { pickEligibleAgent } from './pickEligibleAgent.ts';

// Same as conversationsService.ts's UNASSIGNED_STATUSES — 'awaiting_player'
// always carries an assignee already, so it never appears in this queue.
const UNASSIGNED_STATUSES = ['open', 'escalated'] as const;

export type AssignNextTicketResult = {
  conversationId: string;
  agentId: string;
  status: (typeof UNASSIGNED_STATUSES)[number];
};

/**
 * Assigns at most one conversation: the highest-priority, oldest unassigned
 * ticket in the workspace, to the least-loaded eligible online agent. Returns
 * null (no-op) when either side of that pair doesn't exist — an empty queue
 * or no eligible agent are both normal stop conditions for the caller's loop,
 * never errors. See docs/specs/2026-09-01-ticket-assignment-sweep-design.md.
 */
export async function assignNextTicket(
  workspaceId: string,
): Promise<AssignNextTicketResult | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const [next] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
      })
      .from(conversation)
      .where(
        and(isNull(conversation.assignedAgentId), inArray(conversation.status, UNASSIGNED_STATUSES)),
      )
      .orderBy(asc(conversation.priority), asc(conversation.createdAt), asc(conversation.id))
      .limit(1);

    if (!next) return null;

    const agentId = await pickEligibleAgent(tx, workspaceId);
    if (!agentId) return null;

    await tx
      .update(conversation)
      .set({ assignedAgentId: agentId })
      .where(eq(conversation.id, next.id));

    await appendEvent(tx, {
      workspaceId,
      type: 'conversation_assigned',
      conversationId: next.id,
      actorId: null,
      actorType: 'system',
      payload: { agent_id: agentId, via: 'sweep' },
    });

    return {
      conversationId: next.id,
      agentId,
      status: next.status as AssignNextTicketResult['status'],
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test routing.assignNextTicket.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/routing/assignNextTicket.ts backend/tests/routing.assignNextTicket.test.ts
git commit -m "feat: add assignNextTicket, single-ticket priority>time>free-agent assignment"
```

---

### Task 3: `sweepUnassignedQueue` — bounded drain loop

**Files:**
- Create: `backend/src/domain/routing/sweepUnassignedQueue.ts`
- Test: `backend/tests/routing.sweepUnassignedQueue.test.ts`

**Interfaces:**
- Consumes: `assignNextTicket(workspaceId)` from Task 2.
- Produces: `sweepUnassignedQueue(workspaceId: string): Promise<{ assignedCount: number; assignments: AssignNextTicketResult[] }>`. Tasks 5 and 6 depend on this signature.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/tests/routing.sweepUnassignedQueue.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepUnassignedQueue } from '../src/domain/routing/sweepUnassignedQueue.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

async function assignedAgentIds(conversationIds: string[]) {
  const { rows } = await ownerPool.query<{ id: string; assigned_agent_id: string }>(
    `select id, assigned_agent_id from conversation where id = any($1) order by created_at`,
    [conversationIds],
  );
  return rows.map((r) => r.assigned_agent_id);
}

describe('sweepUnassignedQueue', () => {
  it('drains the whole queue, interleaving across two online agents rather than filling one first', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await seedAgent('a-agent@example.test');
    const agentB = await seedAgent('b-agent@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: agentA });
    await seedWorkspaceMember({ workspaceId, agentId: agentB });
    await incrementPresence(agentA);
    await incrementPresence(agentB);
    await ownerPool.query(`update workspace set max_assigned_tickets = 10 where id = $1`, [
      workspaceId,
    ]);

    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await seedConversation({
          workspaceId,
          playerId,
          status: 'open',
          createdAt: new Date(2026, 0, i + 1),
        }),
      );
    }

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result.assignedCount).toBe(4);

    const owners = await assignedAgentIds(ids);
    expect(owners.every((id) => id !== null)).toBe(true);
    // Interleaved, not dumped on one agent: each agent got at least one, and
    // consecutive assignments alternate because liveCount is re-read every
    // iteration — agentA (lower id, wins the first tie) gets ticket 1,
    // agentB then has fewer live tickets and wins ticket 2, and so on.
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).not.toBe(owners[1]);
  });

  it('stops once no eligible agent remains, leaving the rest of the queue untouched', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);
    await ownerPool.query(`update workspace set max_assigned_tickets = 1 where id = $1`, [
      workspaceId,
    ]);

    const first = await seedConversation({ workspaceId, playerId, status: 'open' });
    const second = await seedConversation({ workspaceId, playerId, status: 'open' });

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result.assignedCount).toBe(1);
    expect(result.assignments[0].conversationId).toBe(first);

    const owners = await assignedAgentIds([second]);
    expect(owners[0]).toBeNull();
  });

  it('returns zero assigned when the queue starts empty', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    await incrementPresence(agentId);

    const result = await sweepUnassignedQueue(workspaceId);
    expect(result).toEqual({ assignedCount: 0, assignments: [] });
  });

  it('never sweeps another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const playerB = await seedPlayer(workspaceB);
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId: agentB });
    await incrementPresence(agentB);
    const conversationId = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
    });

    const result = await sweepUnassignedQueue(workspaceA);
    expect(result).toEqual({ assignedCount: 0, assignments: [] });
    const owners = await assignedAgentIds([conversationId]);
    expect(owners[0]).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test routing.sweepUnassignedQueue.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/routing/sweepUnassignedQueue.ts'`.

- [ ] **Step 3: Implement `sweepUnassignedQueue`**

```typescript
// backend/src/domain/routing/sweepUnassignedQueue.ts
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { conversation } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { assignNextTicket, type AssignNextTicketResult } from './assignNextTicket.ts';

const UNASSIGNED_STATUSES = ['open', 'escalated'] as const;

export type SweepResult = {
  assignedCount: number;
  assignments: AssignNextTicketResult[];
};

async function countUnassigned(workspaceId: string): Promise<number> {
  return withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(conversation)
      .where(
        and(isNull(conversation.assignedAgentId), inArray(conversation.status, UNASSIGNED_STATUSES)),
      );
    return Number(row?.count ?? 0);
  });
}

/**
 * Drains the unassigned queue one ticket at a time via assignNextTicket,
 * stopping as soon as a call returns null (queue empty or no eligible agent
 * left — the same "normal stop condition" assignNextTicket documents). Each
 * iteration is its own transaction, so a failure partway through only loses
 * the one in-flight assignment, not the whole sweep.
 *
 * The iteration cap (queue size at sweep start, +1) exists only to guarantee
 * termination if conversations are being inserted into the queue faster than
 * the sweep drains it — it is not expected to bind in normal operation, since
 * assignNextTicket's own null return is what actually stops the loop.
 */
export async function sweepUnassignedQueue(workspaceId: string): Promise<SweepResult> {
  const maxIterations = (await countUnassigned(workspaceId)) + 1;
  const assignments: AssignNextTicketResult[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const result = await assignNextTicket(workspaceId);
    if (!result) break;
    assignments.push(result);
  }

  return { assignedCount: assignments.length, assignments };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter backend test routing.sweepUnassignedQueue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/domain/routing/sweepUnassignedQueue.ts backend/tests/routing.sweepUnassignedQueue.test.ts
git commit -m "feat: add sweepUnassignedQueue, bounded drain loop over assignNextTicket"
```

---

### Task 4: Manual unassign — service, controller, route, OpenAPI

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/agent/routers/conversationsRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.unassign.test.ts`

**Interfaces:**
- Produces: `unassignConversation(ctx: AgentContext, conversationId: string): Promise<UnassignResult>` where `UnassignResult = { ok: true; status: string } | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_status' }`.
- Route: `POST /agent/conversations/:id/unassign` → `{ unassigned: boolean }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/tests/agent.unassign.test.ts
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});
afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});
beforeEach(truncateAll);

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(`select assigned_agent_id from conversation where id = $1`, [
    id,
  ]);
  return rows[0];
}
async function eventsFor(id: string) {
  const { rows } = await ownerPool.query(
    `select type, payload from event where conversation_id = $1 order by id`,
    [id],
  );
  return rows;
}

describe('POST /agent/conversations/:id/unassign', () => {
  it('releases the caller\'s own ticket back to the unassigned queue', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: agentId,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unassigned: true });
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBeNull();

    const events = await eventsFor(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('conversation_unassigned');
    expect(events[0].payload).toMatchObject({ previous_agent_id: agentId });
  });

  it('403s when the caller does not own the ticket', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const owner = await seedAgent();
    const caller = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: owner });
    await seedWorkspaceMember({ workspaceId, agentId: caller });
    const token = await signAgentSession({ agent_id: caller });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'open',
      assignedAgentId: owner,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(owner);
  });

  it('403s on an already-unassigned ticket — the caller cannot own null', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('409s on a resolved ticket even if still assigned to the caller', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'resolved',
      assignedAgentId: agentId,
    });

    const res = await request(app)
      .post(`/conversations/${conversationId}/unassign`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(409);
    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(agentId);
  });

  it('404s on a nonexistent conversation', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .post(`/conversations/00000000-0000-0000-0000-000000000000/unassign`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test agent.unassign.test.ts`
Expected: FAIL — 404 for every case (no route registered) or similar.

- [ ] **Step 3: Add `unassignConversation` to `conversationsService.ts`**

Add near `reassignConversation` (after its closing brace, before `reclassifyConversation`):

```typescript
export type UnassignResult =
  | { ok: true; status: string }
  | { ok: false; reason: 'not_found' | 'not_owner' | 'invalid_status' };

export async function unassignConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<UnassignResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [conv] = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!conv) return { ok: false, reason: 'not_found' };
    if (conv.status === 'resolved' || conv.status === 'closed')
      return { ok: false, reason: 'invalid_status' };
    // Also covers "already unassigned": assignedAgentId is null there, and
    // null !== ctx.agentId, so it falls into the same not-owned bucket.
    if (conv.assignedAgentId !== ctx.agentId) return { ok: false, reason: 'not_owner' };

    await tx
      .update(conversation)
      .set({ assignedAgentId: null })
      .where(eq(conversation.id, conversationId));

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_unassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { previous_agent_id: ctx.agentId },
    });

    return { ok: true, status: conv.status };
  });
}
```

- [ ] **Step 4: Add `unassignConversationHandler` to `conversationsController.ts`**

Add the import and handler near `reassignConversationHandler`:

```typescript
// add to the existing import from '../services/conversationsService.ts'
  unassignConversation,
```

```typescript
const UNASSIGN_ERRORS = {
  not_found: [404, 'Conversation not found.'],
  not_owner: [403, 'You do not own this conversation.'],
  invalid_status: [409, 'A resolved or closed conversation cannot be unassigned.'],
} as const;

export const unassignConversationHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const params = ConversationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await unassignConversation(ctx, params.data.id);
  if (!result.ok) {
    const [status, message] = UNASSIGN_ERRORS[result.reason];
    sendError(res, status, result.reason, message);
    return;
  }
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status);
  res.status(200).json({ unassigned: true });
};
```

Add `'not_owner'` is already a valid `ErrorCode` (used by `ASK_RESOLVED_ERRORS`/`ESCALATION_ERRORS`); `'invalid_status'` is already valid (used by `REASSIGN_ERRORS`). No change to `backend/src/errors.ts` needed.

- [ ] **Step 5: Register the route**

```typescript
// backend/src/agent/routers/conversationsRouter.ts
// add unassignConversationHandler to the import block, then:
conversationsRouter.post('/conversations/:id/unassign', unassignConversationHandler);
```

- [ ] **Step 6: Register in OpenAPI**

Add near the existing `/agent/conversations/{id}/claim` registration in `backend/src/docs/openapi.ts`:

```typescript
registry.registerPath({
  method: 'post',
  path: '/agent/conversations/{id}/unassign',
  summary: 'Agent Unassign Own Conversation',
  description:
    'Releases a conversation the caller is assigned to back to the unassigned queue. Owning agent only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
  },
  responses: {
    200: {
      description: 'Unassign result',
      content: { 'application/json': { schema: z.object({ unassigned: z.boolean() }) } },
    },
    403: { description: 'Forbidden — caller does not own this conversation' },
    404: { description: 'Conversation not found' },
    409: { description: 'Conversation is resolved or closed' },
  },
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter backend test agent.unassign.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts backend/src/agent/routers/conversationsRouter.ts backend/src/docs/openapi.ts backend/tests/agent.unassign.test.ts
git commit -m "feat: add POST /conversations/:id/unassign, owning-agent-only release"
```

---

### Task 5: Manual sweep-assign route — Team Lead/Admin only

**Files:**
- Modify: `backend/src/agent/controllers/conversationsController.ts`
- Modify: `backend/src/agent/routers/conversationsRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.sweepAssign.test.ts`

**Interfaces:**
- Consumes: `sweepUnassignedQueue(workspaceId)` from Task 3.
- Route: `POST /agent/conversations/sweep-assign` (Team Lead/Admin) → `{ assignedCount: number; conversationIds: string[] }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// backend/tests/agent.sweepAssign.test.ts
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});
afterAll(async () => {
  await closeSocketServer();
  await closePresenceRedis();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});
beforeEach(truncateAll);

describe('POST /agent/conversations/sweep-assign', () => {
  it('403s for a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('200s for a team lead and reports how many tickets it assigned', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const lead = await seedAgent();
    const worker = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });
    await seedWorkspaceMember({ workspaceId, agentId: worker, role: 'agent' });
    await incrementPresence(worker);
    const token = await signAgentSession({ agent_id: lead });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignedCount: 1, conversationIds: [conversationId] });
  });

  it('200s with zero assigned when nobody is eligible', async () => {
    const workspaceId = await seedWorkspace();
    const lead = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });
    const token = await signAgentSession({ agent_id: lead });

    const res = await request(app)
      .post('/conversations/sweep-assign')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ assignedCount: 0, conversationIds: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter backend test agent.sweepAssign.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Add `sweepAssignHandler` to `conversationsController.ts`**

Add the import:

```typescript
import { sweepUnassignedQueue } from '../../domain/routing/sweepUnassignedQueue.ts';
```

Add the handler near `getWorkspaceWorkloadHandler`:

```typescript
export const sweepAssignHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const { assignedCount, assignments } = await sweepUnassignedQueue(ctx.workspaceId);
  for (const a of assignments) {
    emitInboxChanged(getIo(), ctx.workspaceId, a.conversationId, a.status);
  }
  res.status(200).json({
    assignedCount,
    conversationIds: assignments.map((a) => a.conversationId),
  });
};
```

- [ ] **Step 4: Register the route with `requireTeamLeadOrAdmin`**

```typescript
// backend/src/agent/routers/conversationsRouter.ts
// add sweepAssignHandler to the import block, then, placed before the
// '/conversations/:id' routes so it never risks being shadowed by a param route:
conversationsRouter.post(
  '/conversations/sweep-assign',
  requireTeamLeadOrAdmin,
  sweepAssignHandler,
);
```

Note: Express matches routes in registration order and `/conversations/sweep-assign` has no `:id` segment overlap with `/conversations/:id/...` routes, so exact placement doesn't affect correctness here — this ordering just keeps it visually grouped with `/workload`.

- [ ] **Step 5: Register in OpenAPI**

```typescript
registry.registerPath({
  method: 'post',
  path: '/agent/conversations/sweep-assign',
  summary: 'Agent Sweep-Assign Unassigned Queue',
  description:
    'Drains the unassigned queue (priority, then age) into whichever eligible online agents are under their ticket cap, one ticket at a time so load interleaves across agents. Team lead or admin role required.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Sweep result',
      content: {
        'application/json': {
          schema: z.object({
            assignedCount: z.number().int(),
            conversationIds: z.array(z.uuid()),
          }),
        },
      },
    },
    403: { description: 'Forbidden — team lead or admin role required' },
  },
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter backend test agent.sweepAssign.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/agent/controllers/conversationsController.ts backend/src/agent/routers/conversationsRouter.ts backend/src/docs/openapi.ts backend/tests/agent.sweepAssign.test.ts
git commit -m "feat: add POST /conversations/sweep-assign, team-lead/admin manual queue drain"
```

---

### Task 6: Trigger a sweep when an agent's presence flips online

**Files:**
- Modify: `backend/src/shared/realtime/socketServer.ts`
- Test: `backend/tests/realtime.presenceSweep.test.ts`

**Interfaces:**
- Consumes: `sweepUnassignedQueue(workspaceId)` from Task 3.

- [ ] **Step 1: Write the failing test**

```typescript
// backend/tests/realtime.presenceSweep.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

let realtime: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(truncateAll);
afterAll(async () => {
  await realtime?.close();
  await closePresenceRedis();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

async function conversationRow(id: string) {
  const { rows } = await ownerPool.query(`select assigned_agent_id from conversation where id = $1`, [
    id,
  ]);
  return rows[0];
}

describe('presence-online triggers a sweep', () => {
  it('assigns a waiting unassigned ticket to the agent who just connected', async () => {
    realtime = await startRealtimeServer();

    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const token = await signAgentSession({ agent_id: agentId });

    const socket = connectClient(realtime.url, { token, role: 'agent' });
    await new Promise((resolve) => socket.on('connect', resolve));
    // The sweep is fire-and-forget off the connect handler; give it a beat.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const row = await conversationRow(conversationId);
    expect(row.assigned_agent_id).toBe(agentId);

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter backend test realtime.presenceSweep.test.ts`
Expected: FAIL — `assigned_agent_id` is `null`, no sweep runs yet.

- [ ] **Step 3: Wire the sweep into the connect handler**

```typescript
// backend/src/shared/realtime/socketServer.ts
// add these two imports alongside the existing ones:
import { emitInboxChanged } from './emit.ts';
import { sweepUnassignedQueue } from '../../domain/routing/sweepUnassignedQueue.ts';
```

Modify the `wasFirstConnection` block (currently lines 149-172) to also kick off a sweep per workspace, after the presence broadcast:

```typescript
      void incrementPresence(data.agentId)
        .then(({ wasFirstConnection }) => {
          if (wasFirstConnection && !closing) {
            for (const workspaceId of data.workspaceIds) {
              io.to(inboxRoom(workspaceId)).emit('presence_changed', {
                agentId: data.agentId,
                status: 'online',
              });
            }
            // Fire-and-forget: draining the queue must never block or fail
            // the socket connect itself. Runs once per workspace this agent
            // belongs to, so a multi-workspace admin's connect drains every
            // workspace's queue against everyone currently online there.
            for (const workspaceId of data.workspaceIds) {
              void sweepUnassignedQueue(workspaceId)
                .then(({ assignments }) => {
                  if (closing) return;
                  for (const a of assignments) {
                    emitInboxChanged(io, workspaceId, a.conversationId, a.status);
                  }
                })
                .catch((error) => {
                  logger.error(
                    'presence',
                    `sweepUnassignedQueue failed for workspace ${workspaceId}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                });
            }
          }
        })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend test realtime.presenceSweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full presence and socket suites to check for regressions**

Run: `pnpm --filter backend test agent.presence.test.ts socketServer`
Expected: PASS — the existing "emits presence_changed online on first connect" test in `agent.presence.test.ts` must still pass unchanged (that test seeds no unassigned conversations, so the added sweep is a no-op there).

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add backend/src/shared/realtime/socketServer.ts backend/tests/realtime.presenceSweep.test.ts
git commit -m "feat: sweep the unassigned queue when an agent's presence flips online"
```

---

### Task 7: Frontend API client — unassign and sweep-assign

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**
- Produces: `unassignConversation(token, conversationId): Promise<{ unassigned: boolean }>`, `sweepAssign(token): Promise<{ assignedCount: number; conversationIds: string[] }>`. Tasks 8 and 9 depend on these.

- [ ] **Step 1: Add the two functions**

Add near `reassignConversation` (`frontend/src/surfaces/agent-console/api/agentApi.ts`, after line 163):

```typescript
export function unassignConversation(
  token: string,
  conversationId: string,
): Promise<{ unassigned: boolean }> {
  return call(`/agent/conversations/${conversationId}/unassign`, token, { method: 'POST' });
}

export function sweepAssign(
  token: string,
): Promise<{ assignedCount: number; conversationIds: string[] }> {
  return call('/agent/conversations/sweep-assign', token, { method: 'POST' });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "feat: add unassignConversation and sweepAssign to the agent API client"
```

---

### Task 8: Frontend — "Release ticket" button

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`

**Interfaces:**
- Consumes: `unassignConversation(token, conversationId)` from Task 7.

- [ ] **Step 1: Read the existing `ThreadPanel.test.tsx` to match its mocking conventions**

Run: `cat frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx | head -60`

(No code shown here — this step is discovery. Match whatever `vi.mock` calls and render-helper pattern that file already uses; do not invent a new convention for this component's tests.)

- [ ] **Step 2: Write the failing test**

Append to `ThreadPanel.test.tsx`, following the file's existing render-helper and `vi.mock('../../../api/agentApi.ts')` pattern established by its other tests (e.g. its take-over/claim tests):

```typescript
describe('release ticket', () => {
  it('shows Release ticket only when the caller owns the conversation, and calls unassign', async () => {
    const unassignSpy = vi.mocked(agentApi.unassignConversation).mockResolvedValue({
      unassigned: true,
    });
    const user = userEvent.setup();

    renderThreadPanel({
      conversationId: 'c1',
      status: 'open',
      assignedAgentId: 'agent-1', // must match the mocked session's agentId
      releaseAvailable: true,
    });

    const button = await screen.findByRole('button', { name: 'Release ticket' });
    await user.click(button);

    await waitFor(() => expect(unassignSpy).toHaveBeenCalledWith('tok', 'c1'));
  });

  it('hides Release ticket when releaseAvailable is false', () => {
    renderThreadPanel({
      conversationId: 'c1',
      status: 'open',
      assignedAgentId: 'someone-else',
      releaseAvailable: false,
    });

    expect(screen.queryByRole('button', { name: 'Release ticket' })).not.toBeInTheDocument();
  });
});
```

Adjust `renderThreadPanel(...)` to whatever the file's existing render helper is actually named and shaped (its `takeOverAvailable`/`claimAvailable` tests already exercise this same prop-driven pattern — mirror them exactly rather than introducing a new helper).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx`
Expected: FAIL — no `releaseAvailable` prop, no "Release ticket" button, `agentApi.unassignConversation` doesn't exist as a mockable export reference yet in the component.

- [ ] **Step 4: Add the `releaseAvailable` prop and mutation to `ThreadPanel.tsx`**

Add to the import from `'../../../api/agentApi.ts'` (alongside `takeOverConversation`, `claimConversation`):

```typescript
  unassignConversation,
```

Add to the props destructure and type (alongside `takeOverAvailable`, `claimAvailable`):

```typescript
  releaseAvailable = false,
```
```typescript
  releaseAvailable?: boolean;
```

Add the mutation near the existing `claim`/`takeOver` mutations (after line 331):

```typescript
  const release = useMutation({
    mutationFn: () => unassignConversation(token, conversationId!),
    onSuccess: invalidateAfterTakeOver,
    onError: () => toast.error("Couldn't release this ticket."),
  });
```

Add the button in the `div.ml-auto` row (near `takeOverAvailable`/`claimAvailable`, after line 512):

```tsx
            {releaseAvailable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={release.isPending}
                onClick={() => release.mutate()}
              >
                Release ticket
              </Button>
            )}
```

- [ ] **Step 5: Compute `releaseAvailable` in `ConversationDetailPane.tsx` and pass it down**

```typescript
// after the existing isOwnedByMe computation (line 63)
  const releaseAvailable = isOwnedByMe && status !== 'resolved' && status !== 'closed';
```

```tsx
        // add alongside the existing takeOverAvailable/claimAvailable props
        releaseAvailable={releaseAvailable}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx
git commit -m "feat: add Release ticket button, owning-agent-only manual unassign"
```

---

### Task 9: Frontend — "Assign next" sweep button on the Tickets tab

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx`

**Interfaces:**
- Consumes: `sweepAssign(token)` from Task 7, `canBuildForms(session)` from `frontend/src/surfaces/agent-console/lib/agentSession.ts` (team-lead-or-admin predicate, already used to gate `AssignPicker` in `ThreadPanel.tsx`).

- [ ] **Step 1: Write the failing tests**

Add to `Tickets.test.tsx` (matching the file's existing `vi.mock('../../lib/agentSession.ts', ...)` and `vi.mock('../../api/agentApi.ts')` setup already shown at the top of the file):

```typescript
describe('Assign next (sweep)', () => {
  it('shows the button for a team lead and reports the assigned count on click', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    const sweepSpy = vi
      .mocked(agentApi.sweepAssign)
      .mockResolvedValue({ assignedCount: 3, conversationIds: ['c1', 'c2', 'c3'] });
    vi.mocked(loadAgentSession).mockReturnValue({
      token: 'tok',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      role: 'team_lead',
    } as never);
    const user = userEvent.setup();

    renderTickets('/tickets');

    const button = await screen.findByRole('button', { name: 'Assign next' });
    await user.click(button);

    await waitFor(() => expect(sweepSpy).toHaveBeenCalledWith('tok'));
    await screen.findByText('Assigned 3 tickets.');
  });

  it('hides the button for a plain agent', async () => {
    vi.mocked(agentApi.fetchInbox).mockResolvedValue({ conversations: [], nextCursor: null });
    vi.mocked(loadAgentSession).mockReturnValue({
      token: 'tok',
      agentId: 'agent-1',
      workspaceId: 'ws-1',
      role: 'agent',
    } as never);

    renderTickets('/tickets');

    await waitFor(() => expect(agentApi.fetchInbox).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Assign next' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter frontend test Tickets.test.tsx`
Expected: FAIL — no "Assign next" button exists yet, `agentApi.sweepAssign` is unused.

- [ ] **Step 3: Add the button to `Tickets.tsx`**

Add to the import from `'../../api/agentApi.ts'` (alongside `claimConversation`, `fetchInbox`):

```typescript
  sweepAssign,
```

Add to the import from `'../../lib/agentSession.ts'` (currently just `loadAgentSession`):

```typescript
import { loadAgentSession, canBuildForms } from '../../lib/agentSession.ts';
```

Add `toast` import (already used elsewhere in this surface for mutation feedback — mirror `ThreadPanel.tsx`'s `import { toast } from 'sonner';`):

```typescript
import { toast } from 'sonner';
```

Inside the `Tickets()` component, add the mutation (near the other hooks, after `queryClient` is defined):

```typescript
  const sweep = useMutation({
    mutationFn: () => sweepAssign(session!.token),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      toast.success(`Assigned ${result.assignedCount} tickets.`);
    },
    onError: () => toast.error("Couldn't run the assignment sweep."),
  });
```

Add the `useMutation` import if not already present (it already is — used by `QueueColumn`'s `claim` mutation — no new import needed for the hook itself, only for `sweepAssign`, `canBuildForms`, and `toast` above).

Add the button in the toolbar row, next to the Board/List toggle (inside the `mb-4 flex items-start justify-between` div, after the toggle group):

```tsx
        {session && canBuildForms(session) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={sweep.isPending}
            onClick={() => sweep.mutate()}
          >
            Assign next
          </Button>
        )}
```

`Button` is already imported in this file (line 25).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter frontend test Tickets.test.tsx`
Expected: PASS — full suite, including the pre-existing filtering tests (confirms nothing else broke).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: no errors.

```bash
git add frontend/src/surfaces/agent-console/pages/Tickets/Tickets.tsx frontend/src/surfaces/agent-console/pages/Tickets/Tickets.test.tsx
git commit -m "feat: add Assign next sweep button to the Tickets tab, team-lead/admin only"
```

---

### Task 10: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend suite**

Run: `pnpm --filter backend test`
Expected: PASS, including every test file touched or added in Tasks 1-6.

- [ ] **Step 2: Run the full frontend suite**

Run: `pnpm --filter frontend test`
Expected: PASS, including `ThreadPanel.test.tsx` and `Tickets.test.tsx`.

- [ ] **Step 3: Run the full typecheck**

Run: `pnpm typecheck`
Expected: no errors across the workspace.

- [ ] **Step 4: Manually verify OpenAPI docs render**

Run: `pnpm dev` (or just the backend), then open `http://localhost:4000/docs`.
Expected: `POST /agent/conversations/{id}/unassign` and `POST /agent/conversations/sweep-assign` both appear with correct request/response schemas and security requirements.

- [ ] **Step 5: Commit any final fixups**

If Steps 1-4 required fixes, stage and commit them with a message describing what verification caught.
