# Resolved-Ticket Composer Lock and Auto-Close Countdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT dispatch reviewer subagents for this plan — review each task's diff yourself, inline, before marking it complete.

**Goal:** An agent can never send a message into a `resolved`/`closed` conversation (enforced server-side, not just UI), the console's composer lock updates immediately when a viewed conversation resolves, and a resolved ticket's banner shows a live countdown to when it auto-closes.

**Architecture:** A server-side status guard in the existing `sendAgentMessage` service (matching the `wrong_status`/409 pattern `askResolved`/`forceResolve` already use), a query-invalidation fix in `ThreadPanel`'s existing `conversation:phase_changed` socket handler, a new `resolved_at`/`auto_close_days` pair on the conversation-detail response, and a small client-side ticking countdown hook consuming it.

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL, Zod, Vitest + supertest (backend), React + TanStack Query + Vitest + Testing Library (frontend).

Full design: `docs/specs/2026-09-02-resolved-ticket-composer-lock-and-autoclose-countdown-design.md`.

## Global Constraints

- No hard deletes anywhere — not touched by this plan, noted for completeness.
- Permission/status checks run at the API, not only in the UI — this is the entire point of Task 1.
- Every new API response field is registered in `backend/src/docs/openapi.ts` per this repo's rule for keeping Swagger in sync.
- Tailwind v4 utilities only — no hand-written CSS in any touched frontend file.
- `pnpm typecheck` and the relevant `pnpm test` suites must pass before each commit; Postgres must be up for backend tests (`pnpm dev` or `docker compose up -d`).
- Player-side message posting is explicitly out of scope — only the agent-authored send path (`sendAgentMessage`) gets the new status guard. A player message still reopens a resolved/closed conversation with no time limit, unchanged.

---

### Task 1: Server-side guard — reject agent sends on resolved/closed conversations

**Files:**
- Modify: `backend/src/agent/services/messagesService.ts`
- Modify: `backend/src/agent/controllers/messagesController.ts`
- Modify: `backend/src/docs/openapi.ts:1298-1332` (the `POST .../messages` `registerPath` block — its `summary: 'Agent Send Reply or Internal Note'`)
- Test: `backend/tests/agent.messages.test.ts`

**Interfaces:**
- Consumes: nothing new — `conversation.status` is already selected in `sendAgentMessage`'s existing `found` query (`messagesService.ts:82-90`).
- Produces: `SendAgentMessageResult` gains a `{ outcome: 'wrong_status' }` variant; `postAgentMessageHandler` maps it to HTTP `409`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/agent.messages.test.ts`, inside the existing `describe('POST /agent/messages', ...)` block (it already imports `seedConversation`, `seedWorkspace`, `seedPlayer`, `ownerPool`, `signAgentSession`, and has a `setupAssignedAgent` helper — reuse both):

```ts
  it.each(['resolved', 'closed'] as const)(
    '409s when the conversation is %s',
    async (status) => {
      const workspaceId = await seedWorkspace();
      const playerId = await seedPlayer(workspaceId);
      const conversationId = await seedConversation({ workspaceId, playerId, status });
      const { token } = await setupAssignedAgent(workspaceId, conversationId);

      await request(app)
        .post('/messages')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Workspace-Id', workspaceId)
        .send({ conversation_id: conversationId, body: 'still here?' })
        .expect(409);

      const { rows } = await ownerPool.query(
        `select count(*)::int as count from message where conversation_id = $1`,
        [conversationId],
      );
      expect(rows[0].count).toBe(0);
    },
  );
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test agent.messages.test.ts`
Expected: FAIL — currently returns `200`, not `409` (the message is sent).

- [ ] **Step 3: Add the status guard to the service**

In `backend/src/agent/services/messagesService.ts`, update the result union (line 26-31):

```ts
export type SendAgentMessageResult =
  | { outcome: 'ok'; message: AgentMessageView }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'wrong_status' }
  | { outcome: 'attachment_not_found' }
  | { outcome: 'attachment_mismatch' };
```

Add the blocked-status set near the top of the file, alongside the other imports (module scope, above `sendAgentMessage`):

```ts
const BLOCKED_SEND_STATUSES = new Set(['resolved', 'closed']);
```

In the transaction body (`messagesService.ts:81-93`), add the check right after the existing `forbidden` check and before `postMessage` is called:

```ts
    if (!found) return { outcome: 'not_found' } as const;
    if (found.assignedAgentId !== ctx.agentId) return { outcome: 'forbidden' } as const;
    if (BLOCKED_SEND_STATUSES.has(found.status)) return { outcome: 'wrong_status' } as const;

    const posted = await postMessage(tx, {
```

- [ ] **Step 4: Map the new outcome to 409 in the controller**

In `backend/src/agent/controllers/messagesController.ts`, add this branch to `postAgentMessageHandler`, right after the existing `if (result.outcome === 'forbidden')` block and before `res.status(200).json(...)`:

```ts
  if (result.outcome === 'wrong_status') {
    sendError(res, 409, 'wrong_status', 'Cannot send a message to a resolved or closed conversation.');
    return;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend test agent.messages.test.ts`
Expected: PASS, including all pre-existing tests in the file (unaffected — `sendAgentMessage`'s `ok`/`forbidden`/`not_found` paths are untouched).

- [ ] **Step 6: Register the new response code in the OpenAPI doc**

In `backend/src/docs/openapi.ts`, in the `registerPath` block at line 1298 (`summary: 'Agent Send Reply or Internal Note'`), add a `409` entry to its `responses` object (line 1325-1331):

```ts
  responses: {
    200: { description: 'Agent message or internal note sent' },
    409: { description: 'Conversation is resolved or closed' },
    422: {
      description:
        'attachment_not_found (key missing, or not owned by this agent/workspace) or attachment_mismatch (declared mime_type/byte_size disagrees with the real object, or fails the allowlist/size cap)',
    },
  },
```

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/messagesService.ts backend/src/agent/controllers/messagesController.ts \
  backend/src/docs/openapi.ts backend/tests/agent.messages.test.ts
git commit -m "Reject agent message sends on resolved/closed conversations (409)"
```

---

### Task 2: Expose `resolved_at` and `auto_close_days` on conversation detail

**Files:**
- Modify: `packages/types/src/agent-context.ts`
- Modify: `backend/src/agent/services/conversationContextService.ts`
- Modify: `backend/src/docs/openapi.ts:870-890` (`AgentConversationDetailSchema`)
- Modify: `backend/tests/helpers/db.ts` (new `seedResolutionCycle` helper)
- Test: a new backend test file, `backend/tests/agent.conversationDetail.test.ts`

**Interfaces:**
- Consumes: `resolution_cycle` table (`backend/src/shared/db/schema/conversations.ts:192-235`, columns `conversationId`, `resolvedAt`, `closedAt`), `workspace.autoCloseDays` (`backend/src/shared/db/schema/identity.ts:38`).
- Produces: `AgentConversationDetail` gains `resolved_at: string | null` and `auto_close_days: number`. `seedResolutionCycle(args: { workspaceId: string; conversationId: string; resolvedAt?: Date | null; closedAt?: Date | null; cycleNo?: number }): Promise<string>` — a new test helper, exported for reuse by any later test that needs a resolution-cycle row.

- [ ] **Step 1: Add the `seedResolutionCycle` test helper**

In `backend/tests/helpers/db.ts`, add this function (place it near `seedConversation`, matching that function's style):

```ts
export async function seedResolutionCycle(args: {
  workspaceId: string;
  conversationId: string;
  cycleNo?: number;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into resolution_cycle (id, workspace_id, conversation_id, cycle_no, resolved_at, closed_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      args.workspaceId,
      args.conversationId,
      args.cycleNo ?? 1,
      args.resolvedAt ?? null,
      args.closedAt ?? null,
    ],
  );
  return id;
}
```

Also add `'resolution_cycle'` to `SCOPED_TABLES` in the same file (it's already truncated indirectly today only if some other seed inserts it — check the list at the top of `db.ts`; if `'resolution_cycle'` is already present, skip this — grep first with `grep -n "resolution_cycle" backend/tests/helpers/db.ts` before editing, since a duplicate entry would break `truncateAll`'s single `TRUNCATE` statement).

- [ ] **Step 2: Write the failing test**

Create `backend/tests/agent.conversationDetail.test.ts`:

```ts
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  seedResolutionCycle,
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

describe('GET /agent/conversations/:id — resolved_at and auto_close_days', () => {
  it('returns resolved_at from the closed resolution cycle and the workspace auto_close_days', async () => {
    const workspaceId = await seedWorkspace({ autoCloseDays: 10 });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: new Date('2026-08-30T00:00:00.000Z'),
    });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.resolved_at).toBe('2026-08-30T00:00:00.000Z');
    expect(res.body.auto_close_days).toBe(10);
  });

  it('returns resolved_at: null for a conversation with no closed resolution cycle', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get(`/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.resolved_at).toBeNull();
    expect(res.body.auto_close_days).toBe(7);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter backend test agent.conversationDetail.test.ts`
Expected: FAIL — `resolved_at`/`auto_close_days` are `undefined` on the response body (not present on the type or the query yet).

- [ ] **Step 4: Add the fields to the shared type**

In `packages/types/src/agent-context.ts`, add to `AgentConversationDetail` (after `resolved_by_agent_name`, before `created_at`):

```ts
  /**
   * From the most recent resolution_cycle row's resolved_at. Null whenever
   * there is no closed cycle yet (i.e. status isn't resolved/closed).
   */
  resolved_at: string | null;
  /** The workspace's auto-close window in days — always present, not gated. */
  auto_close_days: number;
  created_at: string;
```

(Remove the old trailing `created_at: string;` line so it isn't duplicated — the block above replaces it.)

- [ ] **Step 5: Join `resolution_cycle` and `workspace` in `getConversationDetail`**

In `backend/src/agent/services/conversationContextService.ts`, add `resolutionCycle` and `workspace` to the schema import (line 12-26):

```ts
import {
  agent,
  attachment,
  conversation,
  declaredField,
  event,
  form,
  formAnswer,
  formSubmission,
  formVersion,
  intent,
  player,
  playerStateSnapshot,
  resolutionCycle,
  subintent,
  workspace,
} from '../../shared/db/schema/index.ts';
```

Update the query (`conversationContextService.ts:44-67`) to select and join both:

```ts
    const [row] = await tx
      .select({
        id: conversation.id,
        number: conversation.number,
        status: conversation.status,
        priority: conversation.priority,
        resolutionSource: conversation.resolutionSource,
        createdAt: conversation.createdAt,
        playerId: player.id,
        externalPlayerId: player.externalId,
        intentName: intent.name,
        subintentName: subintent.name,
        subintentId: subintent.id,
        assignedAgentId: agent.id,
        assignedAgentName: agent.displayName,
        resolvedAt: resolutionCycle.resolvedAt,
        autoCloseDays: workspace.autoCloseDays,
      })
      .from(conversation)
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(subintent, eq(subintent.id, conversation.subintentId))
      .leftJoin(intent, eq(intent.id, subintent.intentId))
      .leftJoin(agent, eq(agent.id, conversation.assignedAgentId))
      .innerJoin(workspace, eq(workspace.id, conversation.workspaceId))
      // At most one open cycle exists (resolution_cycle_open_uk), and once
      // resolved it stays resolved — ordering by resolvedAt desc + limit 1
      // on the outer query picks the most recent closed cycle regardless of
      // how many past cycles a reopened conversation has.
      .leftJoin(
        resolutionCycle,
        and(eq(resolutionCycle.conversationId, conversation.id), isNotNull(resolutionCycle.resolvedAt)),
      )
      .where(eq(conversation.id, conversationId))
      .orderBy(desc(resolutionCycle.resolvedAt))
      .limit(1);
```

Add `and`, `desc`, `isNotNull` to the existing `drizzle-orm` import at the top of the file (line 1 currently reads `import { and, asc, count, desc, eq, sql } from 'drizzle-orm';` — `and`/`desc` are already imported; add `isNotNull`):

```ts
import { and, asc, count, desc, eq, isNotNull, sql } from 'drizzle-orm';
```

Update the return object (`conversationContextService.ts:71-95`) to add the two new fields, replacing the final `created_at` line:

```ts
      resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      auto_close_days: row.autoCloseDays,
      created_at: row.createdAt.toISOString(),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter backend test agent.conversationDetail.test.ts`
Expected: PASS, both cases.

- [ ] **Step 7: Run the broader conversation-context test suite to check for regressions**

Run: `pnpm --filter backend test conversationContextService agent.conversations`
Expected: PASS — the join is a `leftJoin` gated on `isNotNull(resolvedAt)`, so a conversation with no resolution cycle still returns exactly one row (the `leftJoin` produces a null-filled row, not zero rows), and a conversation with exactly one resolved cycle is unaffected. If any existing test asserts the full detail-response shape with `toEqual` (rather than `toMatchObject`), update it to include `resolved_at`/`auto_close_days`.

- [ ] **Step 8: Update the OpenAPI schema**

In `backend/src/docs/openapi.ts`, update `AgentConversationDetailSchema` (line 870-890):

```ts
const AgentConversationDetailSchema = z.object({
  id: z.uuid(),
  number: z.number().int(),
  player: z.object({ id: z.uuid(), external_player_id: z.string() }),
  status: z.enum([
    'new',
    'bot_active',
    'open',
    'awaiting_player',
    'escalated',
    'resolved',
    'closed',
  ]),
  subintent: AgentSubintentSchema,
  assigned_agent: z.object({ id: z.uuid(), display_name: z.string() }).nullable(),
  resolution_source: z
    .enum(['bot', 'agent', 'player_confirmed', 'timed_out', 'player_stated', 'admin_forced'])
    .nullable(),
  resolved_by_agent_name: z.string().nullable(),
  resolved_at: z.string().nullable(),
  auto_close_days: z.number().int(),
  created_at: z.string(),
});
```

- [ ] **Step 9: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/types/src/agent-context.ts backend/src/agent/services/conversationContextService.ts \
  backend/src/docs/openapi.ts backend/tests/helpers/db.ts backend/tests/agent.conversationDetail.test.ts
git commit -m "Expose resolved_at and auto_close_days on agent conversation detail"
```

---

### Task 3: Fix stale `readOnly` on live resolution — query invalidation + 409 toast

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`

**Interfaces:**
- Consumes: `ApiError` (`frontend/src/lib/httpClient.ts`, already has a `status: number` field); nothing else new.
- Produces: no new exports — behavioral fix only.

- [ ] **Step 1: Write the failing test for the invalidation fix**

Add to `ThreadPanel.test.tsx`, inside a new `describe` block (place it near the existing `describe('ThreadPanel read-only tickets', ...)`):

```ts
describe('ThreadPanel live resolution', () => {
  it('invalidates the conversation detail query when phase_changed fires, not just the inbox lists', async () => {
    const handlers = fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <ThreadPanel
          token="t"
          conversationId="c1"
          playerExternalId="p-1"
          status="open"
          confirmPhase="none"
        />
      </QueryClientProvider>,
    );
    await screen.findByLabelText('Message');
    invalidateSpy.mockClear();

    handlers['conversation:phase_changed']?.({ conversation_id: 'c1', confirm_phase: 'none' });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['conversation', 'c1', 'detail'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets-summary'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inbox', 'mine'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['inbox', 'unassigned'] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx -t "invalidates the conversation detail query"`
Expected: FAIL — only the two `inbox` invalidations happen today.

- [ ] **Step 3: Extend the socket handler**

In `ThreadPanel.tsx`, update the `conversation:phase_changed` handler (currently lines 385-388):

```ts
    socket.on('conversation:phase_changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox', 'unassigned'] });
    });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx -t "invalidates the conversation detail query"`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the 409 toast**

Add `import { ApiError } from '../../../../../lib/httpClient.ts';` and `import { Toaster } from 'sonner';` to the top of `ThreadPanel.test.tsx`. Update `renderPanel` to also render a `Toaster` so toasts are queryable (this is additive and doesn't change any existing assertion):

```ts
function renderPanel(overrides: PanelProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThreadPanel
        token="t"
        conversationId="c1"
        playerExternalId="p-1"
        status="open"
        confirmPhase="none"
        {...overrides}
      />
      <Toaster />
    </QueryClientProvider>,
  );
}
```

Add this test to the `describe('ThreadPanel optimistic sends', ...)` block, alongside the existing "offers a retry when the send fails" test:

```ts
  it('toasts and refetches detail when a send loses the race to a resolve (409)', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [] } as never);
    vi.mocked(sendAgentMessage).mockRejectedValue(
      new ApiError('Cannot send a message to a resolved or closed conversation.', 409),
    );

    renderPanel();
    await screen.findByLabelText('Message');

    await userEvent.type(screen.getByLabelText('Message'), 'sneaking in');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(
      await screen.findByText('This ticket was just resolved — your message was not sent.'),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx -t "loses the race to a resolve"`
Expected: FAIL — no toast is shown today; the message just gets marked failed with a Retry button, same as any other error.

- [ ] **Step 7: Add the 409 branch to the send mutation's onError**

In `ThreadPanel.tsx`, add the import at the top (matches the existing relative-depth pattern used for `features/chat/*` imports in this file):

```ts
import { ApiError } from '../../../../../lib/httpClient.ts';
```

Update the `send` mutation's `onError` (currently lines 243-247):

```ts
    onError: (error, _variables, context) => {
      setPending((current) =>
        current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
      );
      if (error instanceof ApiError && error.status === 409) {
        toast.error('This ticket was just resolved — your message was not sent.');
        void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      }
    },
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx`
Expected: PASS, entire file (including all pre-existing tests — the `Toaster` addition to `renderPanel` renders an empty toast region when no toast fires, which doesn't affect any other test's queries).

- [ ] **Step 9: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx \
  frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx
git commit -m "Fix stale composer lock: invalidate conversation detail on phase_changed, toast on 409"
```

---

### Task 4: `formatCountdown` and `useAutoCloseCountdown`

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.ts`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.test.ts`

**Interfaces:**
- Produces: `formatCountdown(ms: number): string`; `useAutoCloseCountdown(resolvedAt: string | null | undefined, autoCloseDays: number | undefined): string | null` — Task 5 imports both (the hook directly, `formatCountdown` only for tests import it too if needed, but Task 5 only needs the hook).

- [ ] **Step 1: Write the failing tests for `formatCountdown`**

Create `frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { formatCountdown, useAutoCloseCountdown } from './autoCloseCountdown.ts';

describe('formatCountdown', () => {
  it('shows days and hours when a day or more remains', () => {
    const ms = 6 * 86_400_000 + 4 * 3_600_000 + 12 * 60_000;
    expect(formatCountdown(ms)).toBe('closes in 6d 4h');
  });

  it('shows hours and minutes under a day', () => {
    const ms = 3 * 3_600_000 + 12 * 60_000;
    expect(formatCountdown(ms)).toBe('closes in 3h 12m');
  });

  it('shows minutes only under an hour', () => {
    expect(formatCountdown(5 * 60_000)).toBe('closes in 5m');
  });

  it('reads "closing soon" at or past the deadline', () => {
    expect(formatCountdown(0)).toBe('closing soon');
    expect(formatCountdown(-1000)).toBe('closing soon');
  });
});

describe('useAutoCloseCountdown', () => {
  it('returns null when resolvedAt or autoCloseDays is missing', () => {
    expect(renderHook(() => useAutoCloseCountdown(null, 7)).result.current).toBeNull();
    expect(renderHook(() => useAutoCloseCountdown('2026-08-30T00:00:00.000Z', undefined)).result.current).toBeNull();
  });

  it('computes the deadline from resolvedAt + autoCloseDays and ticks on a 60s interval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));

    // resolvedAt is 3 days ago, autoCloseDays is 7 -> 4 days remain.
    const { result } = renderHook(() => useAutoCloseCountdown('2026-08-30T00:00:00.000Z', 7));
    expect(result.current).toBe('closes in 4d 0h');

    act(() => {
      vi.setSystemTime(new Date('2026-09-02T00:01:00.000Z'));
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe('closes in 3d 23h');

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter frontend test autoCloseCountdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.ts`:

```ts
import { useEffect, useState } from 'react';

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'closing soon';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `closes in ${days}d ${hours}h`;
  if (hours > 0) return `closes in ${hours}h ${minutes}m`;
  return `closes in ${minutes}m`;
}

/**
 * Client-side-only countdown: the deadline is computed once from data
 * already on the conversation-detail response, then re-formatted on a 60s
 * tick — no extra network calls, no server-pushed updates.
 */
export function useAutoCloseCountdown(
  resolvedAt: string | null | undefined,
  autoCloseDays: number | undefined,
): string | null {
  const deadline =
    resolvedAt && autoCloseDays ? new Date(resolvedAt).getTime() + autoCloseDays * 86_400_000 : null;

  const [label, setLabel] = useState<string | null>(() =>
    deadline === null ? null : formatCountdown(deadline - Date.now()),
  );

  useEffect(() => {
    if (deadline === null) {
      setLabel(null);
      return;
    }
    const tick = () => setLabel(formatCountdown(deadline - Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [deadline]);

  return label;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter frontend test autoCloseCountdown.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.ts \
  frontend/src/surfaces/agent-console/pages/Inbox/components/autoCloseCountdown.test.ts
git commit -m "Add formatCountdown and useAutoCloseCountdown for the resolved-ticket banner"
```

---

### Task 5: Resolved/closed-specific banner text and wired-in countdown

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`

**Interfaces:**
- Consumes: `useAutoCloseCountdown` (Task 4); `resolved_at`/`auto_close_days` (Task 2, via `AgentConversationDetail`).
- Produces: `ThreadPanel` gains two new optional props: `resolvedAt?: string | null` and `autoCloseDays?: number`.

- [ ] **Step 1: Update the existing banner test's expectations**

The current banner test in `ThreadPanel.test.tsx` (`describe('ThreadPanel read-only tickets', ...)`, `'banners which ticket is on screen...'`) asserts the old generic copy. Replace it:

```ts
  it('banners "Viewing resolved ticket" with who resolved it and when it auto-closes', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({
      ...RESOLVED,
      resolvedAt: '2026-08-30T00:00:00.000Z',
      autoCloseDays: 7,
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Viewing resolved ticket');
    expect(banner).toHaveTextContent('#1039');
    expect(banner).toHaveTextContent('Resolved by Sam');
    expect(banner).toHaveTextContent('closes in');
  });

  it('banners "Viewing closed ticket" with no countdown for a closed conversation', async () => {
    fakeSocket();
    vi.mocked(fetchConversationMessages).mockResolvedValue({ messages: [agentMessage()] } as never);

    renderPanel({ ...RESOLVED, status: 'closed' });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Viewing closed ticket');
    expect(banner).not.toHaveTextContent('closes in');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx -t "Viewing resolved ticket"`
Expected: FAIL — banner still says "Viewing an earlier ticket" and never mentions "closes in".

- [ ] **Step 3: Add the new props and wire the hook into the banner**

In `ThreadPanel.tsx`, add the import:

```ts
import { useAutoCloseCountdown } from './autoCloseCountdown.ts';
```

Add `resolvedAt` and `autoCloseDays` to the props destructuring and type (alongside the existing `resolutionSource`/`resolvedByAgentName`/`openedAt` props, lines 104-142):

```ts
export function ThreadPanel({
  token,
  conversationId,
  playerExternalId,
  status,
  priority,
  confirmPhase,
  readOnly = false,
  ticketNumber,
  resolutionSource,
  resolvedByAgentName,
  resolvedAt,
  autoCloseDays,
  openedAt,
  railOpen = false,
  onToggleRail,
  onBack,
  takeOverAvailable = false,
  claimAvailable = false,
  assignedAgentId,
  assignedAgentName,
}: {
  token: string;
  conversationId: string | null;
  playerExternalId?: string;
  status?: ConversationStatusValue;
  priority?: ConversationPriorityValue;
  confirmPhase?: ConfirmPhaseValue;
  readOnly?: boolean;
  ticketNumber?: number;
  resolutionSource?: ResolutionSourceValue | null;
  resolvedByAgentName?: string | null;
  resolvedAt?: string | null;
  autoCloseDays?: number;
  openedAt?: string;
  railOpen?: boolean;
  onToggleRail?: () => void;
  onBack?: () => void;
  takeOverAvailable?: boolean;
  claimAvailable?: boolean;
  assignedAgentId?: string | null;
  assignedAgentName?: string | null;
}) {
```

Inside the component body, call the hook (any spot alongside the other `useQuery`/`useState` calls, e.g. right after the `queryClient`/`pending`/`expandedImage` declarations):

```ts
  const countdownLabel = useAutoCloseCountdown(resolvedAt, autoCloseDays);
```

Replace the banner block (currently lines 566-579):

```tsx
        {readOnly && (
          <div
            role="status"
            className="flex shrink-0 items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"
          >
            <Archive className="size-3.5 shrink-0" />
            {status === 'resolved' ? 'Viewing resolved ticket' : 'Viewing closed ticket'}
            {ticketNumber != null && ` · #${ticketNumber}`}
            {` · ${resolverLabel(resolutionSource, resolvedByAgentName)}`}
            {status === 'resolved' && countdownLabel && ` · ${countdownLabel}`}
          </div>
        )}
```

(This drops the old `openedAt`/`formatTicketDate` fragment in favor of `resolverLabel`, which is strictly more informative and was already computed for the composer placeholder just below — no behavior is lost, since `resolverLabel` already covers the "Closed" fallback case the old bare-status word covered. `formatTicketDate` and the `openedAt` prop stay — nothing else in this file uses `formatTicketDate` today, but it's a small pure function with no cost to leave in place, and removing an exported-looking helper is out of scope for this task; leave it as dead code review may flag separately, or delete it if `pnpm lint`'s unused-export check fails the build — check `pnpm lint` output in Step 6 below and delete `formatTicketDate` only if it does.)

- [ ] **Step 4: Thread the two new props through `ConversationDetailPane`**

In `frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx`, add two props to the `<ThreadPanel>` call (alongside the existing `resolutionSource`/`resolvedByAgentName`/`openedAt`, currently lines 78-81):

```tsx
        resolutionSource={detail.data?.resolution_source}
        resolvedByAgentName={detail.data?.resolved_by_agent_name}
        resolvedAt={detail.data?.resolved_at}
        autoCloseDays={detail.data?.auto_close_days}
        // There is no resolved_at column; created_at is what the detail carries.
        openedAt={detail.data?.created_at}
```

(Delete the now-stale comment `// There is no resolved_at column; created_at is what the detail carries.` immediately above `openedAt` — it described exactly the gap this plan closes, and is no longer true.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter frontend test ThreadPanel.test.tsx`
Expected: PASS, entire file — both new banner tests and every pre-existing test (the `RESOLVED` fixture's other consumers don't reference banner text, so they're unaffected).

- [ ] **Step 6: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS. If `pnpm lint` flags `formatTicketDate` as an unused export, delete its definition from `ThreadPanel.tsx` (it was only ever used in the banner fragment removed in Step 3) and re-run `pnpm lint`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx \
  frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx \
  frontend/src/surfaces/agent-console/components/ConversationDetailPane.tsx
git commit -m "Split resolved/closed banner copy and show a live auto-close countdown"
```

---

### Task 6: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full backend suite**

Run: `pnpm --filter backend test` (Postgres must be up: `docker compose up -d` or `pnpm dev` beforehand)
Expected: PASS.

- [ ] **Step 2: Run the full frontend suite**

Run: `pnpm --filter frontend test`
Expected: PASS.

- [ ] **Step 3: Run the workspace-wide typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

With `pnpm dev` running: open the same conversation in two agent-console browser sessions (or one console session + one direct API call), force-resolve it from one, and confirm the other's composer disables and the "Viewing resolved ticket · closes in Xd Yh" banner appears within a second, with no manual reload. Then confirm a `POST /agent/messages` against that same conversation returns `409` (e.g. via `curl` or the Swagger UI at `http://localhost:4000/docs`).

No commit for this task — it's a checkpoint, not a change.
