# Ticket Assignment Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT dispatch reviewer subagents for this plan — review each task's diff yourself, inline, before marking it complete.

**Goal:** Notify an agent — by toast and a persistent bell dropdown — the moment any ticket becomes assigned to them, across every workspace they belong to.

**Architecture:** A new in-process `notification` table + `notifyAgent(tx, ...)` function, called inside the same transaction as every existing assignment write (claim, take-over, reassign, sweep, bot handoff). Realtime delivery rides a new per-agent Socket.io room (`agent:{agentId}`) that isn't workspace-scoped, so it reaches the agent regardless of which workspace's console they're viewing. Cross-workspace reads (the dropdown, mark-all-read) reuse the existing `getGlobalInbox` scatter/gather pattern over `withWorkspace`.

**Tech Stack:** Express 5, Drizzle ORM, PostgreSQL RLS, Socket.io, Vitest + supertest, React + TanStack Query, Tailwind v4, Sonner toasts.

Full design: `docs/specs/2026-09-02-ticket-assignment-notifications-design.md`.

## Global Constraints

- No hard deletes anywhere — notifications are kept forever, no pruning job.
- Every scoped table needs a `workspace_id` column and nothing else for RLS: `002_rls.sql`'s `DO $$ ... $$` block auto-applies the standard `tenant` policy to any table with that column. Do not hand-write a policy for `notification`.
- Payload values are snapshotted literals, never live FK-resolved names (`workspace_name`, `workspace_slug`, `ticket_number`, `priority` are captured at write time).
- All state changes that touch `conversation` go through the transaction that also calls `appendEvent` — `notifyAgent` piggybacks on that same transaction, never a separate one.
- Socket emits happen only after the transaction commits, never inside it — matches `emitInboxChanged`/`emitApplied`/`emitFormTerminated`'s existing contract.
- Tailwind v4 utilities only in `NotificationBell.tsx` — no hand-written CSS.
- Every new route is registered in `backend/src/docs/openapi.ts`.
- `pnpm typecheck` and the relevant `pnpm test` suites must pass before each commit; Postgres must be up for backend tests (`pnpm dev` or `docker compose up -d`).

---

### Task 1: Schema, shared types, and test-helper wiring

**Files:**
- Create: `backend/src/shared/db/schema/notifications.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Modify: `backend/tests/helpers/db.ts` (add `'notification'` to `SCOPED_TABLES`)
- Create: `packages/types/src/notifications.ts`
- Modify: `packages/types/src/index.ts`
- Test: `backend/tests/notifications.schema.test.ts`

**Interfaces:**
- Produces: `notification` Drizzle table (columns: `id`, `workspaceId`, `agentId`, `type`, `conversationId`, `payload`, `readAt`, `createdAt`); `NotificationView` type `{ id: string; workspace_id: string; agent_id: string; type: string; conversation_id: string | null; payload: Record<string, unknown>; read_at: string | null; created_at: string }`; `AssignmentVia = 'claim' | 'take_over' | 'reassign' | 'sweep' | 'bot_handoff'` (both exported from `@support/types`).

- [ ] **Step 1: Write the schema file**

```ts
// backend/src/shared/db/schema/notifications.ts
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agent, workspace } from './identity.ts';
import { conversation } from './conversations.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    conversationId: uuid('conversation_id').references(() => conversation.id, {
      onDelete: 'restrict',
    }),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    readAt: timestamp('read_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [index('notification_agent_workspace_read_idx').on(t.agentId, t.workspaceId, t.readAt)],
);
```

- [ ] **Step 2: Export it from the schema barrel**

Add to `backend/src/shared/db/schema/index.ts` (alphabetically not required — match the existing list's append style):

```ts
export * from './notifications.ts';
```

- [ ] **Step 3: Add the shared wire types**

```ts
// packages/types/src/notifications.ts
export type AssignmentVia = 'claim' | 'take_over' | 'reassign' | 'sweep' | 'bot_handoff';

export type TicketAssignedPayload = {
  ticket_number: number;
  priority: 'p1' | 'p2' | 'p3' | 'p4';
  via: AssignmentVia;
  workspace_name: string;
  workspace_slug: string;
};

export type NotificationView = {
  id: string;
  workspace_id: string;
  agent_id: string;
  type: string;
  conversation_id: string | null;
  payload: TicketAssignedPayload | Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type NotificationsResponse = {
  notifications: NotificationView[];
  unread_count: number;
};
```

Add to `packages/types/src/index.ts`:

```ts
export * from './notifications.ts';
```

- [ ] **Step 4: Register `notification` for test truncation**

In `backend/tests/helpers/db.ts`, add `'notification'` to `SCOPED_TABLES` (it references `conversation`, `agent`, and `workspace`, so it must be truncated in the same `CASCADE` statement — position doesn't matter since `truncateAll` truncates them all together with `CASCADE`, but keep it near `'event'` for readability):

```ts
const SCOPED_TABLES = [
  'article_attachment',
  'attachment',
  'resolution_cycle',
  'form_answer',
  'form_submission',
  'form_version',
  'form',
  'message_template',
  'change_log',
  'bot_config',
  'notification',
  'event',
  'message',
  'conversation',
  'subintent',
  'intent',
  'player_state_snapshot',
  'declared_field',
  'session',
  'player',
  'workspace_secret',
  'workspace_member',
  'agent',
  'workspace',
];
```

- [ ] **Step 5: Generate and apply the migration**

Run: `pnpm db:generate`
Expected: a new file under `backend/drizzle/` creating the `notification` table (review it — it should contain exactly the columns/index from Step 1, no unrelated diffs).

Run: `pnpm db:setup`
Expected: succeeds; `002_rls.sql`'s structural loop picks up `notification` automatically (it has a `workspace_id` column) and enables RLS + the `tenant` policy on it — no manual SQL needed.

- [ ] **Step 6: Write a failing schema/RLS smoke test**

```ts
// backend/tests/notifications.schema.test.ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notification } from '../src/shared/db/schema/index.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

describe('notification table', () => {
  it('inserts and reads back a row scoped to its workspace, invisible from another', async () => {
    const workspaceId = await seedWorkspace();
    const otherWorkspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const agentId = await seedAgent();

    const inserted = await withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .insert(notification)
        .values({
          workspaceId,
          agentId,
          type: 'ticket_assigned',
          conversationId,
          payload: { ticket_number: 1, priority: 'p3', via: 'claim' },
        })
        .returning();
      return row!;
    });

    const visibleInOwnWorkspace = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(notification).where(eq(notification.id, inserted.id)),
    );
    expect(visibleInOwnWorkspace).toHaveLength(1);

    const visibleInOtherWorkspace = await withWorkspace(otherWorkspaceId, (tx) =>
      tx.select().from(notification).where(eq(notification.id, inserted.id)),
    );
    expect(visibleInOtherWorkspace).toHaveLength(0);
  });
});
```

Add the missing `eq` import: `import { eq } from 'drizzle-orm';` at the top.

Run: `pnpm --filter backend test notifications.schema.test.ts`
Expected: FAIL if Step 5 wasn't run yet (table doesn't exist), otherwise PASS immediately since the table/RLS already exist — if it fails for any other reason, fix before continuing.

- [ ] **Step 7: Run typecheck and the full new test file**

Run: `pnpm typecheck && pnpm --filter backend test notifications.schema.test.ts`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/shared/db/schema/notifications.ts backend/src/shared/db/schema/index.ts \
  backend/drizzle backend/tests/helpers/db.ts backend/tests/notifications.schema.test.ts \
  packages/types/src/notifications.ts packages/types/src/index.ts
git commit -m "Add notification table, RLS via structural policy, and shared types"
```

---

### Task 2: Realtime infrastructure — per-agent room and emit function

**Files:**
- Modify: `backend/src/shared/realtime/rooms.ts`
- Modify: `backend/src/shared/realtime/emit.ts`
- Modify: `backend/src/shared/realtime/socketServer.ts`
- Test: `backend/tests/realtime.notificationRoom.test.ts`

**Interfaces:**
- Consumes: `NotificationView` (Task 1).
- Produces: `agentNotificationRoom(agentId: string): string`; `emitNotificationNew(io: Server, agentId: string, notification: NotificationView): void`.

- [ ] **Step 1: Add the room helper**

In `backend/src/shared/realtime/rooms.ts`:

```ts
export const playerRoom = (conversationId: string): string => `conv:${conversationId}:player`;
export const agentRoom = (conversationId: string): string => `conv:${conversationId}:agents`;
export const inboxRoom = (workspaceId: string): string => `workspace:${workspaceId}:inbox`;
export const agentNotificationRoom = (agentId: string): string => `agent:${agentId}`;
```

- [ ] **Step 2: Add the emit function**

In `backend/src/shared/realtime/emit.ts`, add the import and function:

```ts
import type { ConversationPhaseChangedEvent, MessageReadEvent, NotificationView } from '@support/types';
import { agentNotificationRoom, agentRoom, inboxRoom, playerRoom } from './rooms.ts';

// ... existing functions unchanged ...

export function emitNotificationNew(
  io: Server,
  agentId: string,
  notificationView: NotificationView,
): void {
  io.to(agentNotificationRoom(agentId)).emit('notification:new', notificationView);
}
```

- [ ] **Step 3: Join the room on connect**

In `backend/src/shared/realtime/socketServer.ts`, find the `io.on('connection', ...)` block (around line 143) where an agent socket joins `inboxRoom(workspaceId)` for each of `data.workspaceIds`. Add the notification room join right after that loop, once per connection (not per workspace):

```ts
import { agentNotificationRoom, inboxRoom } from './rooms.ts';
// ...
  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    if (data.role === 'agent') {
      for (const workspaceId of data.workspaceIds) {
        socket.join(inboxRoom(workspaceId));
      }
      socket.join(agentNotificationRoom(data.agentId));
      // ... existing incrementPresence(...) block unchanged below ...
```

- [ ] **Step 4: Write a failing realtime test**

```ts
// backend/tests/realtime.notificationRoom.test.ts
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { emitNotificationNew } from '../src/shared/realtime/emit.ts';
import { getIo } from '../src/shared/realtime/socketServer.ts';
import type { NotificationView } from '@support/types';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(async () => {
  await truncateAll();
  server = await startRealtimeServer();
});

afterEach(async () => {
  await server.close();
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()));
}

describe('notification:new', () => {
  it('reaches the assigned agent without any explicit room join', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const agentToken = await signAgentSession({ agent_id: agentId });

    const agentClient = connectClient(server.url, { token: agentToken, role: 'agent' });
    await waitFor(agentClient, 'connect');

    const received: NotificationView[] = [];
    agentClient.on('notification:new', (n: NotificationView) => received.push(n));

    const fakeNotification: NotificationView = {
      id: 'test-id',
      workspace_id: workspaceId,
      agent_id: agentId,
      type: 'ticket_assigned',
      conversation_id: null,
      payload: {},
      read_at: null,
      created_at: new Date().toISOString(),
    };
    emitNotificationNew(getIo(), agentId, fakeNotification);

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toEqual([fakeNotification]);

    agentClient.close();
  });
});
```

- [ ] **Step 5: Run the test to verify it fails, then passes**

Run: `pnpm --filter backend test realtime.notificationRoom.test.ts`
Expected: FAILs before Step 3's join line is added (no `notification:new` received), PASSes after.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/realtime/rooms.ts backend/src/shared/realtime/emit.ts \
  backend/src/shared/realtime/socketServer.ts backend/tests/realtime.notificationRoom.test.ts
git commit -m "Add per-agent notification room and emitNotificationNew"
```

---

### Task 3: `notifyAgent` — the send function

**Files:**
- Create: `backend/src/domain/notifications/notifyAgent.ts`
- Test: `backend/tests/notifications.notifyAgent.test.ts`

**Interfaces:**
- Consumes: `Tx` (`shared/db/withWorkspace.ts`), `appendEvent`-style transaction context, `notification`/`conversation`/`workspace` schema tables, `AssignmentVia`/`NotificationView` (`@support/types`).
- Produces: `notifyAgent(tx: Tx, params: { workspaceId: string; agentId: string; conversationId: string; via: AssignmentVia }): Promise<NotificationView>` and `toNotificationView(row): NotificationView` — every later task (4, 5, 6) calls `notifyAgent` exactly this way and threads its return value out as `result.notification` for the handler layer to pass to `emitNotificationNew`.

This is the single integration point named in the design doc: it looks up the conversation's `number`/`priority` and the workspace's `name`/`slug` itself, so every call site is one line.

- [ ] **Step 1: Write the failing unit test**

```ts
// backend/tests/notifications.notifyAgent.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

describe('notifyAgent', () => {
  it('inserts a ticket_assigned notification with a snapshotted payload', async () => {
    const workspaceId = await seedWorkspace({ name: 'Wanderlust Kingdoms', slug: 'wanderlust' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p2' });
    const agentId = await seedAgent();

    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );

    expect(view.workspace_id).toBe(workspaceId);
    expect(view.agent_id).toBe(agentId);
    expect(view.conversation_id).toBe(conversationId);
    expect(view.type).toBe('ticket_assigned');
    expect(view.read_at).toBeNull();
    expect(view.payload).toMatchObject({
      priority: 'p2',
      via: 'claim',
      workspace_name: 'Wanderlust Kingdoms',
      workspace_slug: 'wanderlust',
    });
    expect(typeof (view.payload as { ticket_number: number }).ticket_number).toBe('number');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.notifyAgent.test.ts`
Expected: FAIL with a module-not-found error for `notifyAgent.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/notifications/notifyAgent.ts
import { eq } from 'drizzle-orm';
import type { AssignmentVia, NotificationView } from '@support/types';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { conversation, notification, workspace } from '../../shared/db/schema/index.ts';

export type NotifyAgentParams = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  via: AssignmentVia;
};

export function toNotificationView(row: typeof notification.$inferSelect): NotificationView {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    agent_id: row.agentId,
    type: row.type,
    conversation_id: row.conversationId,
    payload: row.payload,
    read_at: row.readAt ? row.readAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The single write path for a ticket-assignment notification, called inside
 * the same transaction as the assignment write itself (right after
 * appendEvent), from every current assignment site — claim, take-over,
 * reassign, sweep, bot handoff. A future assignment path wires in with one
 * call here, nothing else in the notification system needs to change.
 *
 * Looks up the conversation's number/priority and the workspace's
 * name/slug itself so call sites stay one-liners; snapshotted into payload
 * because a later rename must not rewrite what this notification said at
 * the time.
 */
export async function notifyAgent(
  tx: Tx,
  params: NotifyAgentParams,
): Promise<NotificationView> {
  const [conv] = await tx
    .select({ number: conversation.number, priority: conversation.priority })
    .from(conversation)
    .where(eq(conversation.id, params.conversationId))
    .limit(1);

  const [ws] = await tx
    .select({ name: workspace.name, slug: workspace.slug })
    .from(workspace)
    .where(eq(workspace.id, params.workspaceId))
    .limit(1);

  const [row] = await tx
    .insert(notification)
    .values({
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      type: 'ticket_assigned',
      conversationId: params.conversationId,
      payload: {
        ticket_number: conv?.number ?? null,
        priority: conv?.priority ?? null,
        via: params.via,
        workspace_name: ws?.name ?? null,
        workspace_slug: ws?.slug ?? null,
      },
    })
    .returning();

  return toNotificationView(row!);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.notifyAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/notifications/notifyAgent.ts backend/tests/notifications.notifyAgent.test.ts
git commit -m "Add notifyAgent: single write path for assignment notifications"
```

---

### Task 4: Wire into claim, take-over, reassign

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts:642-797` (`claimConversation`, `takeOverConversation`, `reassignConversation`)
- Modify: `backend/src/agent/controllers/conversationsController.ts:92-175` (their handlers)
- Test: `backend/tests/notifications.claimTakeOverReassign.test.ts`

**Interfaces:**
- Consumes: `notifyAgent`, `toNotificationView` (Task 3); `emitNotificationNew` (Task 2).
- Produces: `ClaimResult`, `TakeOverResult`, `ReassignResult` each gain a `notification: NotificationView | null` field (`null` only on the already-existing not-claimed/not-found/invalid branches) — later tasks don't touch these three, but any other future reader of these result types must account for the new field.

- [ ] **Step 1: Write the failing integration test**

```ts
// backend/tests/notifications.claimTakeOverReassign.test.ts
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
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedAgent,
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

describe('assignment notifications', () => {
  it('claim creates a notification for the claiming agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, type, conversation_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_id: agentId,
      type: 'ticket_assigned',
      conversation_id: conversationId,
      payload: { via: 'claim' },
    });
  });

  it('take-over creates a notification for the taking-over agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({
      workspaceId,
      playerId,
      status: 'bot_active',
    });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .post(`/conversations/${conversationId}/take-over`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'take_over' } });
  });

  it('reassign creates a notification for the target agent, not the reassigner', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const teamLead = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: teamLead, role: 'team_lead' });
    const teamLeadToken = await signAgentSession({ agent_id: teamLead });
    const targetAgentId = await seedAgent('target@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: targetAgentId, role: 'agent' });

    await request(app)
      .patch(`/conversations/${conversationId}/assign`)
      .set('Authorization', `Bearer ${teamLeadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ agentId: targetAgentId })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: targetAgentId, payload: { via: 'reassign' } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.claimTakeOverReassign.test.ts`
Expected: FAIL — `notification` table stays empty (0 rows) for all three.

- [ ] **Step 3: Wire `notifyAgent` into the three service functions**

In `backend/src/agent/services/conversationsService.ts`, add the import:

```ts
import { notifyAgent } from '../../domain/notifications/notifyAgent.ts';
import type { NotificationView } from '@support/types';
```

Update `claimConversation` (add the call right after `appendEvent`, and thread the result through the return):

```ts
export async function claimConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<ClaimResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const claimed = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId })
      .where(
        and(
          eq(conversation.id, conversationId),
          isNull(conversation.assignedAgentId),
          inArray(conversation.status, ACTIVE_AGENT_STATUSES),
        ),
      )
      .returning({ id: conversation.id, status: conversation.status });
    const [row] = claimed;
    if (!row) return { claimed: false, status: null, posted: null, notification: null };

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_assigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, via: 'claim' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId,
      via: 'claim',
    });
    const posted = await postTakenOverNotice(tx, ctx, conversationId);
    return { claimed: true, status: row.status, posted, notification };
  });
}
```

Update its result type (find `export type ClaimResult = ...` above the function) to add `notification: NotificationView | null;`.

Apply the identical pattern to `takeOverConversation` (`via: 'take_over'`, target agent `ctx.agentId`, add `notification: NotificationView | null` to `TakeOverResult`, return `{ claimed: false, status: null, posted: null, notification: null }` on its not-eligible branch):

```ts
export async function takeOverConversation(
  ctx: AgentContext,
  conversationId: string,
): Promise<TakeOverResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: ctx.agentId, status: 'open', confirmPhase: 'none' })
      .where(
        and(
          eq(conversation.id, conversationId),
          isNull(conversation.assignedAgentId),
          eq(conversation.status, 'bot_active'),
        ),
      )
      .returning({ id: conversation.id, status: conversation.status });
    if (!row) return { claimed: false, status: null, posted: null, notification: null };

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_taken_over',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: ctx.agentId, from_status: 'bot_active', to_status: 'open' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: ctx.agentId,
      conversationId,
      via: 'take_over',
    });

    const posted = await postTakenOverNotice(tx, ctx, conversationId);
    return { claimed: true, status: row.status, posted, notification };
  });
}
```

And `reassignConversation` (`via: 'reassign'`, target agent `targetAgentId`; add `notification: NotificationView | null` to `ReassignResult`; every `{ ok: false, ... }` early-return branch is unaffected since `ReassignResult`'s `ok: false` variant has no `notification` field — only the `ok: true` variant needs it):

```ts
    const [row] = await tx
      .update(conversation)
      .set({ assignedAgentId: targetAgentId })
      .where(eq(conversation.id, conversationId))
      .returning({ id: conversation.id, status: conversation.status });

    await appendEvent(tx, {
      workspaceId: ctx.workspaceId,
      type: 'conversation_reassigned',
      conversationId,
      actorId: ctx.agentId,
      actorType: 'agent',
      payload: { agent_id: targetAgentId, reassigned_by: ctx.agentId, via: 'reassign' },
    });
    const notification = await notifyAgent(tx, {
      workspaceId: ctx.workspaceId,
      agentId: targetAgentId,
      conversationId,
      via: 'reassign',
    });
    const posted = await postReassignedNotice(tx, ctx, conversationId, targetAgentId);
    return { ok: true, status: row!.status, posted, notification };
```

If `ReassignResult`'s `ok: true` variant is declared inline (e.g. `{ ok: true; status: ...; posted: ...; }`), add `notification: NotificationView;` to it; if `ClaimResult`/`TakeOverResult` are single flat types (not a union), add `notification: NotificationView | null;` to each.

- [ ] **Step 4: Emit `notification:new` from the three handlers**

In `backend/src/agent/controllers/conversationsController.ts`, add the import:

```ts
import { emitInboxChanged, emitMessageToRooms, emitNotificationNew, emitPhaseChanged } from '../../shared/realtime/emit.ts';
```

In `claimConversationHandler`, inside the existing `if (result.claimed && result.status) { ... }` block, add:

```ts
  if (result.claimed && result.status) {
    emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status);
    if (result.posted)
      emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted));
    if (result.notification) emitNotificationNew(getIo(), ctx.agentId, result.notification);
  }
```

Same addition in `takeOverConversationHandler`'s equivalent block (target agent is `ctx.agentId` there too).

In `reassignConversationHandler`, after the existing unconditional `emitMessageToRooms(...)` call:

```ts
  emitInboxChanged(getIo(), ctx.workspaceId, params.data.id, result.status);
  emitMessageToRooms(getIo(), params.data.id, toPlayerView(result.posted), toAgentView(result.posted));
  emitNotificationNew(getIo(), body.data.agentId, result.notification);
  res.status(200).json({ reassigned: true });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.claimTakeOverReassign.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 6: Run the pre-existing conversation tests to check for regressions**

Run: `pnpm --filter backend test agent.reassign.test.ts conversationsService`
Expected: PASS — the new `notification` field is additive, existing assertions use `toMatchObject`/`toEqual` on unrelated shapes (event/message rows), not the full result object, so they should be unaffected. If any test does `expect(result).toEqual({...})` on the full claim/take-over/reassign result without `notification`, update it to include the new field.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/agent/controllers/conversationsController.ts \
  backend/tests/notifications.claimTakeOverReassign.test.ts
git commit -m "Notify agent on claim, take-over, and reassign"
```

---

### Task 5: Wire into the unassigned-queue sweep

**Files:**
- Modify: `backend/src/domain/routing/assignNextTicket.ts`
- Modify: `backend/src/agent/controllers/conversationsController.ts:426-440` (`sweepAssignHandler`)
- Test: `backend/tests/notifications.sweep.test.ts`

Note: `assignNextTicket`/`sweepUnassignedQueue` currently exist in this codebase per the (draft) sweep design spec — this task assumes they are already implemented as shown in the design research. If they are not yet merged, implement them first per `docs/specs/2026-09-01-ticket-assignment-sweep-design.md` before continuing.

**Interfaces:**
- Consumes: `notifyAgent` (Task 3), `emitNotificationNew` (Task 2).
- Produces: `AssignNextTicketResult` gains `notification: NotificationView`; `sweepAssignHandler` emits one `notification:new` per assignment, same loop shape it already uses for `emitInboxChanged`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/notifications.sweep.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { assignNextTicket } from '../src/domain/routing/assignNextTicket.ts';
import { closePresenceRedis, incrementPresence } from '../src/shared/realtime/presence.ts';
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
  await closeAdminDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

describe('assignNextTicket notifications', () => {
  it('notifies the picked agent with via: sweep', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    // Same Redis presence fixture routing.pickEligibleAgent.test.ts uses —
    // assignNextTicket's agent selection only considers Redis-online agents.
    await incrementPresence(agentId);

    const outcome = await assignNextTicket(workspaceId);
    expect(outcome.assigned).toBe(true);
    if (!outcome.assigned) return;
    expect(outcome.result.notification).toMatchObject({
      agent_id: agentId,
      conversation_id: conversationId,
      payload: { via: 'sweep' },
    });

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'sweep' } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.sweep.test.ts`
Expected: FAIL — `outcome.result.notification` is `undefined`.

- [ ] **Step 3: Wire `notifyAgent` into `assignNextTicket`**

In `backend/src/domain/routing/assignNextTicket.ts`, add the import and the call:

```ts
import { notifyAgent } from '../notifications/notifyAgent.ts';
import type { NotificationView } from '@support/types';

export type AssignNextTicketResult = {
  conversationId: string;
  agentId: string;
  status: (typeof UNASSIGNED_STATUSES)[number];
  notification: NotificationView;
};

// ... inside assignNextTicket, after appendEvent:

    await appendEvent(tx, {
      workspaceId,
      type: 'conversation_assigned',
      conversationId: next.id,
      actorId: null,
      actorType: 'system',
      payload: { agent_id: agentId, via: 'sweep' },
    });
    const notificationView = await notifyAgent(tx, {
      workspaceId,
      agentId,
      conversationId: next.id,
      via: 'sweep',
    });

    return {
      assigned: true,
      result: {
        conversationId: next.id,
        agentId,
        status: next.status as AssignNextTicketResult['status'],
        notification: notificationView,
      },
    };
```

- [ ] **Step 4: Emit from `sweepAssignHandler`**

In `backend/src/agent/controllers/conversationsController.ts`, update the import to include `emitNotificationNew`, then:

```ts
export const sweepAssignHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const { assignedCount, assignments, remainingCount, stopReason } = await sweepUnassignedQueue(
    ctx.workspaceId,
  );
  for (const a of assignments) {
    emitInboxChanged(getIo(), ctx.workspaceId, a.conversationId, a.status);
    emitNotificationNew(getIo(), a.agentId, a.notification);
  }
  res.status(200).json({
    assignedCount,
    conversationIds: assignments.map((a) => a.conversationId),
    remainingCount,
    stopReason,
  });
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.sweep.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing sweep test suite to check for regressions**

Run: `pnpm --filter backend test assignNextTicket sweepUnassignedQueue`
Expected: PASS — if any existing test asserts the full shape of `AssignNextTicketResult` with `toEqual`, update it to include `notification`.

- [ ] **Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/domain/routing/assignNextTicket.ts backend/src/agent/controllers/conversationsController.ts \
  backend/tests/notifications.sweep.test.ts
git commit -m "Notify agent on sweep auto-assignment"
```

---

### Task 6: Wire into bot handoff (applyBotTurn + completeFormAndHandoff)

**Files:**
- Modify: `backend/src/domain/bot/applyBotTurn.ts:211-249,275-300` (`handoff` and `unavailable` branches)
- Modify: `backend/src/domain/bot/orchestrator.ts:82-117` (`emitApplied`)
- Modify: `backend/src/domain/forms/completeFormAndHandoff.ts:117-133,252-260`
- Modify: `backend/src/domain/forms/emitFormTerminated.ts`
- Test: `backend/tests/notifications.botHandoff.test.ts`

**Interfaces:**
- Consumes: `notifyAgent` (Task 3), `emitNotificationNew` (Task 2).
- Produces: `ApplyBotTurnResult` gains `notification: NotificationView | null`; `CompleteFormResult` gains the same. Both default to `null` on every branch that doesn't assign an agent (including `assignedAgentId === null`, i.e. "no agents online" — nothing to notify).

- [ ] **Step 1: Write the failing test**

This exercises `applyBotTurn`'s `handoff` branch directly (the same style its own unit tests likely already use — check `backend/tests/` for an existing `applyBotTurn`/`bot.orchestrator` test file and copy its exact setup for constructing a `handoff` decision and seeding an eligible online agent before finalizing this test; the sketch below shows the assertions this task must satisfy):

```ts
// backend/tests/notifications.botHandoff.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { applyBotTurn } from '../src/domain/bot/applyBotTurn.ts';
import { closePresenceRedis, incrementPresence } from '../src/shared/realtime/presence.ts';
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
  await closeAdminDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

describe('bot handoff notifications', () => {
  it('notifies the picked agent with via: bot_handoff when handoff assigns someone', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    // Marks the agent online in Redis presence, the same fixture
    // routing.pickEligibleAgent.test.ts uses — pickEligibleAgent (called
    // transitively by assignOnHandoff) only selects agents Redis reports online.
    await incrementPresence(agentId);

    const result = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'asked_for_person', subintentId: null, searches: [] },
      ),
    );

    if (result.notification) {
      expect(result.notification).toMatchObject({
        agent_id: agentId,
        conversation_id: conversationId,
        payload: { via: 'bot_handoff' },
      });
    }

    const { rows } = await ownerPool.query(
      `select agent_id, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    // If no agent was online, assignedAgentId is null and no notification is
    // expected — that branch is covered by the "no agents online" case below.
    // With an online agent seeded above, exactly one row is expected:
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: agentId, payload: { via: 'bot_handoff' } });
  });

  it('does not notify anyone when no agent is online', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' });

    const result = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(
        tx,
        { workspaceId, conversationId },
        { kind: 'handoff', reason: 'asked_for_person', subintentId: null, searches: [] },
      ),
    );

    expect(result.notification).toBeNull();
    const { rows } = await ownerPool.query(
      `select 1 from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(0);
  });
});
```

Before finalizing this file, read the actual `BotTurnDecision` type in `backend/src/domain/bot/botTurn.ts` to confirm the `handoff` decision's exact field names (`reason`, `subintentId`, `searches` are inferred from `applyBotTurn.ts`'s own destructuring above — verify against the type, not against this guess) and adjust the literal passed to `applyBotTurn` accordingly.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.botHandoff.test.ts`
Expected: FAIL — `result.notification` is `undefined`, not `null`/a view.

- [ ] **Step 3: Wire `notifyAgent` into `applyBotTurn`'s `handoff` and `unavailable` branches**

In `backend/src/domain/bot/applyBotTurn.ts`, add the import:

```ts
import { notifyAgent } from '../notifications/notifyAgent.ts';
import type { NotificationView } from '@support/types';
```

Add `notification: NotificationView | null` to `ApplyBotTurnResult`. Every existing `return { posted: ..., statusChanged: ..., phaseChanged: ... }` in the `noop`, `answer`, `confirm_player_resolution`, `resolve`, and the form-offer sub-branch of `handoff` must now also return `notification: null`.

In the `handoff` branch, right after its `bot_handoff` `appendEvent` call:

```ts
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'bot_handoff',
        conversationId: ctx.conversationId,
        actorId: null,
        actorType: 'bot',
        payload: { reason: decision.reason, assigned_agent_id: assignedAgentId },
      });
      const notification = assignedAgentId
        ? await notifyAgent(tx, {
            workspaceId: ctx.workspaceId,
            agentId: assignedAgentId,
            conversationId: ctx.conversationId,
            via: 'bot_handoff',
          })
        : null;
      const finalPosted = [posted];
      if (assignedAgentId === null) {
        finalPosted.push(
          await postMessage(tx, { /* ... unchanged ... */ }),
        );
      }
      return { posted: finalPosted, statusChanged: true, phaseChanged: null, notification };
```

Apply the same pattern in the `unavailable` branch, right after its `bot_unavailable` `appendEvent` call, returning `notification` in its final `return { posted, statusChanged: true, phaseChanged: null, notification };`.

- [ ] **Step 4: Thread `notification` through `orchestrator.ts`'s `emitApplied`**

In `backend/src/domain/bot/orchestrator.ts`, add the import:

```ts
import { emitInboxChanged, emitMessageToRooms, emitNotificationNew, emitPhaseChanged } from '../../shared/realtime/emit.ts';
```

Update `emitApplied`'s parameter type and body:

```ts
function emitApplied(
  workspaceId: string,
  conversationId: string,
  result: {
    posted: PostedMessageRow[];
    statusChanged: boolean;
    phaseChanged: ConfirmPhaseValue | null;
    notification: NotificationView | null;
  },
): void {
  let io: Server;
  try {
    io = getIo();
  } catch (err) {
    logger.warn('bot.orchestrator', 'skipping realtime emit: socket server not initialised', {
      workspaceId,
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const row of result.posted) {
    emitMessageToRooms(io, conversationId, toPlayerView(row), toAgentView(row));
  }
  if (result.phaseChanged) {
    emitPhaseChanged(io, conversationId, {
      conversation_id: conversationId,
      confirm_phase: result.phaseChanged,
    });
  }
  if (result.statusChanged) {
    emitInboxChanged(io, workspaceId, conversationId, 'open');
  }
  if (result.notification) {
    emitNotificationNew(io, result.notification.agent_id, result.notification);
  }
}
```

Add `import type { NotificationView } from '@support/types';` next to the existing type-only imports at the top of the file.

- [ ] **Step 5: Wire `notifyAgent` into `completeFormAndHandoff`**

In `backend/src/domain/forms/completeFormAndHandoff.ts`, add the import and `notification` field to `CompleteFormResult`:

```ts
import { notifyAgent, type NotificationView } from '../notifications/notifyAgent.ts';
// (or: import type { NotificationView } from '@support/types'; import { notifyAgent } from '../notifications/notifyAgent.ts';)

export type CompleteFormResult = {
  conversationId: string;
  formStatus: TerminalFormStatus;
  answeredCount: number;
  fieldCount: number;
  assignedAgentId: string | null;
  notification: NotificationView | null;
  posted: PostedMessageRow;
  noAgentsOnlinePosted: PostedMessageRow | null;
};
```

Right after its `bot_handoff` `appendEvent` call:

```ts
  await appendEvent(tx, {
    workspaceId: ctx.workspaceId,
    type: 'bot_handoff',
    conversationId: ctx.conversationId,
    actorId: null,
    actorType: 'bot',
    payload: { reason, assigned_agent_id: assignedAgentId },
  });
  const notification = assignedAgentId
    ? await notifyAgent(tx, {
        workspaceId: ctx.workspaceId,
        agentId: assignedAgentId,
        conversationId: ctx.conversationId,
        via: 'bot_handoff',
      })
    : null;
```

And in the final `return { ... }`, add `notification,`.

- [ ] **Step 6: Emit from `emitFormTerminated`**

In `backend/src/domain/forms/emitFormTerminated.ts`, add the import and the emit call:

```ts
import { emitInboxChanged, emitMessageToRooms, emitNotificationNew, emitPhaseChanged } from '../../shared/realtime/emit.ts';

// ... at the end of emitFormTerminated, before the closing brace:

  emitInboxChanged(io, workspaceId, result.conversationId, 'open');
  if (result.notification) {
    emitNotificationNew(io, result.notification.agent_id, result.notification);
  }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.botHandoff.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the existing bot/forms test suites to check for regressions**

Run: `pnpm --filter backend test applyBotTurn orchestrator completeFormAndHandoff formTimeout`
Expected: PASS — update any test asserting the full result shape with `toEqual` to include the new `notification` field.

- [ ] **Step 9: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/domain/bot/applyBotTurn.ts backend/src/domain/bot/orchestrator.ts \
  backend/src/domain/forms/completeFormAndHandoff.ts backend/src/domain/forms/emitFormTerminated.ts \
  backend/tests/notifications.botHandoff.test.ts
git commit -m "Notify agent on bot handoff (direct and via form completion)"
```

---

### Task 7: Cross-workspace read/write service

**Files:**
- Create: `backend/src/domain/notifications/notificationsQueryService.ts`
- Test: `backend/tests/notifications.queryService.test.ts`

**Interfaces:**
- Consumes: `listActiveMembershipsForAgent`, `AgentContext`, `toNotificationView` (Task 3), `pLimit` (already a dependency, used by `globalInboxService.ts`).
- Produces: `listNotificationsForAgent(ctx: AgentContext): Promise<{ notifications: NotificationView[]; unread_count: number }>`; `markNotificationRead(ctx: AgentContext, notificationId: string): Promise<boolean>` (returns `false` if not found in any of the agent's workspaces); `markAllNotificationsRead(ctx: AgentContext): Promise<number>` (returns total rows updated).

- [ ] **Step 1: Write the failing test**

```ts
// backend/tests/notifications.queryService.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  listNotificationsForAgent,
  markAllNotificationsRead,
  markNotificationRead,
} from '../src/domain/notifications/notificationsQueryService.ts';
import {
  closeOwnerPool,
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
  await closeAdminDb();
  await closeOwnerPool();
});

describe('notificationsQueryService', () => {
  it('lists notifications across every workspace the agent belongs to, newest first', async () => {
    const wsA = await seedWorkspace({ name: 'Game A' });
    const wsB = await seedWorkspace({ name: 'Game B' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: wsB, agentId, role: 'agent' });

    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });
    const playerB = await seedPlayer(wsB);
    const convB = await seedConversation({ workspaceId: wsB, playerId: playerB });

    await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(wsB, (tx) =>
      notifyAgent(tx, { workspaceId: wsB, agentId, conversationId: convB, via: 'sweep' }),
    );

    const { notifications, unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });

    expect(notifications).toHaveLength(2);
    expect(unread_count).toBe(2);
    expect(new Set(notifications.map((n) => n.workspace_id))).toEqual(new Set([wsA, wsB]));
  });

  it('marks one notification read without affecting others, across workspaces', async () => {
    const wsA = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });

    const view = await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );

    const ok = await markNotificationRead({ agentId, workspaceId: '', isAdmin: false }, view.id);
    expect(ok).toBe(true);

    const { notifications, unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });
    expect(unread_count).toBe(0);
    expect(notifications[0]!.read_at).not.toBeNull();
  });

  it('marks all unread notifications read across every workspace', async () => {
    const wsA = await seedWorkspace();
    const wsB = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: wsA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: wsB, agentId, role: 'agent' });
    const playerA = await seedPlayer(wsA);
    const convA = await seedConversation({ workspaceId: wsA, playerId: playerA });
    const playerB = await seedPlayer(wsB);
    const convB = await seedConversation({ workspaceId: wsB, playerId: playerB });
    await withWorkspace(wsA, (tx) =>
      notifyAgent(tx, { workspaceId: wsA, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(wsB, (tx) =>
      notifyAgent(tx, { workspaceId: wsB, agentId, conversationId: convB, via: 'sweep' }),
    );

    const updated = await markAllNotificationsRead({ agentId, workspaceId: '', isAdmin: false });
    expect(updated).toBe(2);

    const { unread_count } = await listNotificationsForAgent({
      agentId,
      workspaceId: '',
      isAdmin: false,
    });
    expect(unread_count).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.queryService.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// backend/src/domain/notifications/notificationsQueryService.ts
import { and, desc, eq, isNull } from 'drizzle-orm';
import pLimit from 'p-limit';
import type { NotificationView } from '@support/types';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';
import { notification } from '../../shared/db/schema/index.ts';
import { withWorkspace } from '../../shared/db/withWorkspace.ts';
import { listActiveMembershipsForAgent, listAllWorkspaces } from '../../shared/db/workspaceMembership.ts';
import { toNotificationView } from './notifyAgent.ts';

const PER_WORKSPACE_CAP = 20;
const TOTAL_CAP = 20;
const SCATTER_CONCURRENCY = 10;

async function targetWorkspaceIds(ctx: AgentContext): Promise<string[]> {
  return ctx.isAdmin
    ? (await listAllWorkspaces()).map((w) => w.workspaceId)
    : (await listActiveMembershipsForAgent(ctx.agentId)).map((m) => m.workspaceId);
}

export async function listNotificationsForAgent(
  ctx: AgentContext,
): Promise<{ notifications: NotificationView[]; unread_count: number }> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const slices = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const rows = await tx
            .select()
            .from(notification)
            .where(eq(notification.agentId, ctx.agentId))
            .orderBy(desc(notification.createdAt))
            .limit(PER_WORKSPACE_CAP);
          const unread = rows.filter((r) => r.readAt === null).length;
          return { views: rows.map(toNotificationView), unread };
        }),
      ),
    ),
  );

  const merged = slices
    .flatMap((s) => s.views)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, TOTAL_CAP);
  const unread_count = slices.reduce((sum, s) => sum + s.unread, 0);

  return { notifications: merged, unread_count };
}

export async function markNotificationRead(
  ctx: AgentContext,
  notificationId: string,
): Promise<boolean> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const results = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const updated = await tx
            .update(notification)
            .set({ readAt: new Date() })
            .where(and(eq(notification.id, notificationId), eq(notification.agentId, ctx.agentId)))
            .returning({ id: notification.id });
          return updated.length > 0;
        }),
      ),
    ),
  );

  return results.some(Boolean);
}

export async function markAllNotificationsRead(ctx: AgentContext): Promise<number> {
  const workspaceIds = await targetWorkspaceIds(ctx);
  const limit = pLimit(SCATTER_CONCURRENCY);

  const counts = await Promise.all(
    workspaceIds.map((wsId) =>
      limit(() =>
        withWorkspace(wsId, async (tx) => {
          const updated = await tx
            .update(notification)
            .set({ readAt: new Date() })
            .where(and(eq(notification.agentId, ctx.agentId), isNull(notification.readAt)))
            .returning({ id: notification.id });
          return updated.length;
        }),
      ),
    ),
  );

  return counts.reduce((sum, c) => sum + c, 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.queryService.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domain/notifications/notificationsQueryService.ts backend/tests/notifications.queryService.test.ts
git commit -m "Add cross-workspace notification read/mark-read service"
```

---

### Task 8: API routes, controller, and OpenAPI registration

**Files:**
- Create: `backend/src/agent/controllers/notificationsController.ts`
- Create: `backend/src/agent/routers/notificationsRouter.ts`
- Modify: `backend/src/agent/router.ts` (mount, alongside `membershipsRouter`/`globalInboxRouter`, before `resolveConsoleWorkspace`)
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/notifications.routes.test.ts`

**Interfaces:**
- Consumes: `listNotificationsForAgent`, `markNotificationRead`, `markAllNotificationsRead` (Task 7).
- Produces: `GET /agent/notifications`, `PATCH /agent/notifications/:id/read`, `PATCH /agent/notifications/read-all`.

- [ ] **Step 1: Write the failing route test**

```ts
// backend/tests/notifications.routes.test.ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { notificationsRouter } from '../src/agent/routers/notificationsRouter.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgent } from '../src/domain/notifications/notifyAgent.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, notificationsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('notifications routes', () => {
  it('GET /notifications returns notifications and unread_count', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.unread_count).toBe(1);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].conversation_id).toBe(conversationId);
  });

  it('PATCH /notifications/:id/read marks it read', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .patch(`/notifications/${view.id}/read`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.unread_count).toBe(0);
  });

  it('PATCH /notifications/:id/read returns 404 for another agent's notification', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const otherAgentId = await seedAgent('other@example.test');
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId, agentId: otherAgentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId, via: 'claim' }),
    );
    const otherToken = await signAgentSession({ agent_id: otherAgentId });

    await request(app)
      .patch(`/notifications/${view.id}/read`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it('PATCH /notifications/read-all clears unread_count', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });
    const playerId = await seedPlayer(workspaceId);
    const convA = await seedConversation({ workspaceId, playerId });
    const convB = await seedConversation({ workspaceId, playerId });
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId: convA, via: 'claim' }),
    );
    await withWorkspace(workspaceId, (tx) =>
      notifyAgent(tx, { workspaceId, agentId, conversationId: convB, via: 'sweep' }),
    );
    const token = await signAgentSession({ agent_id: agentId });

    await request(app)
      .patch('/notifications/read-all')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get('/notifications')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.unread_count).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter backend test notifications.routes.test.ts`
Expected: FAIL — router module doesn't exist.

- [ ] **Step 3: Write the controller**

```ts
// backend/src/agent/controllers/notificationsController.ts
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { sendError } from '../../errors.ts';
import {
  listNotificationsForAgent,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../domain/notifications/notificationsQueryService.ts';

export const listNotificationsHandler: RequestHandler = async (req, res) => {
  const result = await listNotificationsForAgent(req.agent!);
  res.status(200).json(result);
};

const NotificationIdParams = z.object({ id: z.uuid() });

export const markNotificationReadHandler: RequestHandler = async (req, res) => {
  const params = NotificationIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const ok = await markNotificationRead(req.agent!, params.data.id);
  if (!ok) {
    sendError(res, 404, 'not_found', 'Notification not found.');
    return;
  }
  res.status(200).json({ read: true });
};

export const markAllNotificationsReadHandler: RequestHandler = async (req, res) => {
  const updated = await markAllNotificationsRead(req.agent!);
  res.status(200).json({ updated });
};
```

`invalid_request` and `not_found` already exist in `ErrorCode` (`backend/src/errors.ts`) — no changes needed there.

- [ ] **Step 4: Write the router and mount it**

```ts
// backend/src/agent/routers/notificationsRouter.ts
import { Router } from 'express';
import {
  listNotificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
} from '../controllers/notificationsController.ts';

export const notificationsRouter = Router();
notificationsRouter.get('/notifications', listNotificationsHandler);
notificationsRouter.patch('/notifications/read-all', markAllNotificationsReadHandler);
notificationsRouter.patch('/notifications/:id/read', markNotificationReadHandler);
```

The `read-all` route is registered before `/:id/read` deliberately — Express matches routes in registration order, and `read-all` would otherwise never be reached if `:id` matched it first... actually `:id` is a path segment matcher (`/notifications/:id/read` vs `/notifications/read-all`), these don't collide since `read-all` has no trailing `/read` segment matching `:id/read`'s shape — but keep this order anyway, it costs nothing and matches the defensive convention of listing more specific routes first.

In `backend/src/agent/router.ts`, add the import and mount it in the pre-`resolveConsoleWorkspace` group (same reasoning as `membershipsRouter`/`globalInboxRouter`: notifications are inherently cross-workspace, so they must not depend on a single resolved `ctx.workspaceId`):

```ts
import { notificationsRouter } from './routers/notificationsRouter.ts';

// ...
agentRouter.use(requireAgentSession);
agentRouter.use(membershipsRouter);
agentRouter.use(globalInboxRouter);
agentRouter.use(notificationsRouter);
agentRouter.use(resolveConsoleWorkspace);
```

- [ ] **Step 5: Register the routes in OpenAPI**

In `backend/src/docs/openapi.ts`, following the exact pattern used for `/agent/conversations/{id}/assign`, add:

```ts
registry.registerPath({
  method: 'get',
  path: '/agent/notifications',
  summary: 'List My Notifications',
  description:
    'Returns the latest 20 notifications for the calling agent, scattered across every workspace they belong to, newest first, plus a total unread count.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Notifications and unread count',
      content: {
        'application/json': {
          schema: z.object({
            notifications: z.array(
              z.object({
                id: z.uuid(),
                workspace_id: z.uuid(),
                agent_id: z.uuid(),
                type: z.string(),
                conversation_id: z.uuid().nullable(),
                payload: z.record(z.string(), z.unknown()),
                read_at: z.string().nullable(),
                created_at: z.string(),
              }),
            ),
            unread_count: z.number(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/notifications/{id}/read',
  summary: 'Mark Notification Read',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Marked read', content: { 'application/json': { schema: z.object({ read: z.boolean() }) } } },
    404: { description: 'Notification not found' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/agent/notifications/read-all',
  summary: 'Mark All Notifications Read',
  description: 'Marks every unread notification for the calling agent read, across all their workspaces.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: {
    200: {
      description: 'Count of notifications marked read',
      content: { 'application/json': { schema: z.object({ updated: z.number() }) } },
    },
  },
});
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter backend test notifications.routes.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 7: Run the full backend suite and typecheck**

Run: `pnpm typecheck && pnpm --filter backend test`
Expected: PASS. This is the first full-suite run since Task 1 — fix any regression surfaced by the additive `notification` fields on result types before moving on.

- [ ] **Step 8: Manually verify Swagger UI**

Run: `pnpm dev`, open `http://localhost:4000/docs`, confirm the three new `/agent/notifications*` routes appear and expand correctly.

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/controllers/notificationsController.ts backend/src/agent/routers/notificationsRouter.ts \
  backend/src/agent/router.ts backend/src/docs/openapi.ts backend/tests/notifications.routes.test.ts
git commit -m "Add GET/PATCH notifications routes, mounted cross-workspace"
```

---

### Task 9: Frontend API client

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**
- Consumes: `NotificationView`, `NotificationsResponse` (`@support/types`, Task 1), the existing `call()` helper in this file.
- Produces: `fetchNotifications(token): Promise<NotificationsResponse>`; `markNotificationRead(token, id): Promise<{ read: boolean }>`; `markAllNotificationsRead(token): Promise<{ updated: number }>` — consumed by Task 10's `NotificationBell.tsx`.

There is no meaningful unit test for thin fetch wrappers in this codebase's existing pattern (`fetchMemberships`, `fetchGlobalInbox` etc. have none) — this task is verified by Task 10's component working end-to-end and the backend integration tests from Task 8 already covering the wire contract.

- [ ] **Step 1: Add the import and three functions**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add to the `@support/types` import list:

```ts
  NotificationsResponse,
```

Then add, near `fetchGlobalInbox`:

```ts
export function fetchNotifications(token: string): Promise<NotificationsResponse> {
  return call('/agent/notifications', token);
}

export function markNotificationRead(token: string, id: string): Promise<{ read: boolean }> {
  return call(`/agent/notifications/${id}/read`, token, { method: 'PATCH' });
}

export function markAllNotificationsRead(token: string): Promise<{ updated: number }> {
  return call('/agent/notifications/read-all', token, { method: 'PATCH' });
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add notifications API client functions"
```

---

### Task 10: `NotificationBell` component

**Files:**
- Create: `frontend/src/surfaces/agent-console/components/NotificationBell.tsx`

**Interfaces:**
- Consumes: `fetchNotifications`, `markNotificationRead`, `markAllNotificationsRead` (Task 9); `NotificationView`, `TicketAssignedPayload` (`@support/types`); `loadAgentSession`, `saveAgentSession`, `saveLastActiveWorkspaceId` (`../lib/agentSession.ts`); shadcn/ui `DropdownMenu*`, `Badge` (already used in `AgentConsoleShell.tsx`); `Bell` from `lucide-react`.
- Produces: `<NotificationBell session={StoredAgentSession} />` — a self-contained bell + unread badge + dropdown that reads/writes the `['notifications']` TanStack Query cache. Consumed by Task 11.

- [ ] **Step 1: Write the component**

```tsx
// frontend/src/surfaces/agent-console/components/NotificationBell.tsx
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationView, TicketAssignedPayload } from '@support/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../api/agentApi.ts';
import {
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
  type StoredAgentSession,
} from '../lib/agentSession.ts';

export function NotificationBell({ session }: { session: StoredAgentSession }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => fetchNotifications(session.token),
  });

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unread_count ?? 0;

  async function handleSelect(n: NotificationView) {
    await markNotificationRead(session.token, n.id);
    queryClient.setQueryData<typeof data>(['notifications'], (old) =>
      old
        ? {
            unread_count: Math.max(0, old.unread_count - (n.read_at ? 0 : 1)),
            notifications: old.notifications.map((existing) =>
              existing.id === n.id ? { ...existing, read_at: new Date().toISOString() } : existing,
            ),
          }
        : old,
    );

    const payload = n.payload as TicketAssignedPayload;
    const current = loadAgentSession();
    if (current && payload.workspace_slug && current.workspaceSlug !== payload.workspace_slug) {
      saveAgentSession({ ...current, workspaceSlug: payload.workspace_slug, workspaceId: undefined });
      saveLastActiveWorkspaceId(''); // cleared; AgentConsoleShell's membership-fallback effect re-resolves workspaceId from the slug on next load
      window.location.assign(`/tickets/${n.conversation_id}`);
      return;
    }
    if (n.conversation_id) navigate(`/tickets/${n.conversation_id}`);
  }

  async function handleMarkAllRead() {
    await markAllNotificationsRead(session.token);
    queryClient.setQueryData<typeof data>(['notifications'], (old) =>
      old
        ? {
            unread_count: 0,
            notifications: old.notifications.map((n) => ({
              ...n,
              read_at: n.read_at ?? new Date().toISOString(),
            })),
          }
        : old,
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="relative flex size-8 items-center justify-center rounded-md text-muted hover:bg-accent-soft/60 hover:text-text">
          <Bell className="size-4.5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </Badge>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0">Notifications</DropdownMenuLabel>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              className="text-xs font-medium text-accent hover:underline"
            >
              Mark all as read
            </button>
          )}
        </div>
        <DropdownMenuSeparator />
        {notifications.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-muted">No notifications yet.</div>
        )}
        {notifications.map((n) => {
          const payload = n.payload as TicketAssignedPayload;
          return (
            <DropdownMenuItem
              key={n.id}
              onSelect={() => void handleSelect(n)}
              className={n.read_at ? undefined : 'bg-accent-soft/60'}
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-text">
                  Ticket #{payload.ticket_number} assigned to you
                </span>
                <span className="text-xs text-muted">
                  {payload.workspace_name} · {payload.priority?.toUpperCase()}
                </span>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Before wiring this into the shell (Task 11), verify `@/components/ui/badge` exports a `destructive` variant by checking `frontend/src/components/ui/badge.tsx` — `AgentConsoleShell.tsx` only used `variant="secondary"`, so confirm `destructive` exists in that file's `badgeVariants` before relying on it; if it doesn't, add it there (shadcn/ui's default badge component ships this variant, so it's likely already present) or fall back to a plain `bg-red-500 text-white` span for the bubble instead of a `Badge`.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. Fix any import path or type mismatch surfaced here (e.g. actual dropdown-menu/badge component import paths — confirm against `AgentConsoleShell.tsx`'s own imports, which weren't fully shown above; grep for `from '@/components/ui/dropdown-menu'` and `from '@/components/ui/badge'` in that file and match exactly).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/NotificationBell.tsx
git commit -m "Add NotificationBell component"
```

---

### Task 11: Wire the bell into the shell, listen for realtime notifications

**Files:**
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`

**Interfaces:**
- Consumes: `NotificationBell` (Task 10); existing `socket` instance and `useEffect` (lines ~203-230); `NotificationView`, `NotificationsResponse`, `TicketAssignedPayload` (`@support/types`).

- [ ] **Step 1: Import the bell and toast**

Add to the top of `AgentConsoleShell.tsx`:

```tsx
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationsResponse, NotificationView, TicketAssignedPayload } from '@support/types';
import { NotificationBell } from './NotificationBell.tsx';
```

`Bell` is not needed here directly (it lives inside `NotificationBell.tsx`) — no change to the existing `lucide-react` import line.

- [ ] **Step 2: Get the query client**

Near the top of the component body (wherever `useNavigate()` is already called), add:

```tsx
const queryClient = useQueryClient();
```

- [ ] **Step 3: Listen for `notification:new` on the existing socket**

In the existing `useEffect` (around line 203) that creates `socket`, add a listener alongside `presence_changed`:

```tsx
    socket.on('notification:new', (payload: NotificationView) => {
      queryClient.setQueryData<NotificationsResponse>(['notifications'], (old) =>
        old
          ? { unread_count: old.unread_count + 1, notifications: [payload, ...old.notifications].slice(0, 20) }
          : { unread_count: 1, notifications: [payload] },
      );
      const p = payload.payload as TicketAssignedPayload;
      toast(`Ticket #${p.ticket_number} assigned to you`, {
        description: p.workspace_name ? `in ${p.workspace_name}` : undefined,
      });
    });
```

Add this inside the same `if (!session) return;` guarded effect, before the `return () => { ... }` cleanup — no new cleanup needed since `socket.close()` already tears down every listener on this socket.

- [ ] **Step 4: Render the bell in the header**

In the header JSX (around line 316), add it between `WorkspaceSwitcher` and the avatar `DropdownMenu`:

```tsx
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <WorkspaceSwitcher session={session} />
          <div className="flex items-center gap-2">
            <NotificationBell session={session} />
            <DropdownMenu>
              {/* ... existing avatar dropdown, unchanged ... */}
            </DropdownMenu>
          </div>
        </header>
```

(Wrapping the avatar `DropdownMenu` and the new bell in a `flex items-center gap-2` div, since the header is `justify-between` with exactly two children today — `WorkspaceSwitcher` and the dropdown — and now needs three items grouped as two flex children.)

- [ ] **Step 5: Manual verification (no automated frontend test harness exists for this surface per the existing codebase — verify by running the app)**

Run: `pnpm dev`

In the browser:
1. Log in as an agent who is a member of two workspaces (or seed one via `pnpm db:seed` / manually).
2. Confirm the bell renders in the header with no bubble when there are zero notifications.
3. From another session/tab (or via `curl`/Swagger UI at `/docs`), claim or reassign a ticket to this agent.
4. Confirm a toast appears and the bell's red bubble increments without a page reload.
5. Open the dropdown, confirm the new notification is listed and visually distinct (unread background).
6. Click it — confirm it marks read (bubble decrements, row style changes) and navigates to `/tickets/:id`.
7. Trigger a second assignment in the agent's *other* workspace; confirm the toast/dropdown row names that workspace, and clicking it switches the active workspace and lands on the right ticket.
8. Click "Mark all as read" with several unread notifications present; confirm the bubble clears immediately.

Expected: all 8 checks pass. Note any that don't for a follow-up fix before considering this task done.

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx
git commit -m "Mount NotificationBell in agent console header, wire realtime toast"
```

---

## Post-plan follow-ups (not blocking, out of this plan's scope per the design doc's non-goals)

- Notifying the *previous* agent on reassignment.
- Push/email notifications outside the browser tab.
- Pruning old read notifications (explicitly rejected in the design doc — "no hard deletes anywhere").
