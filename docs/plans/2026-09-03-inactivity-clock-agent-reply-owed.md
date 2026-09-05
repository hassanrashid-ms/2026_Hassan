# Inactivity Clock: Agent-Reply-Owed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stage 1 of the inactivity clock from asking a player "Did this solve your issue?" when the agent never replied to the player's last message — instead notify the assigned agent (or all team leads, if unassigned) and re-arm the clock silently.

**Architecture:** `runAskStage` in `backend/src/shared/jobs/inactivityClock.ts` gains a branch: before posting the resolution-check message, it looks up the latest public, non-system message the same way stage 2 already does. If that message is from the player, it takes a new "reply owed" path — write a `reply_owed` notification (new file `notifyAgentReplyOwed.ts`, modeled on `notifyAgent.ts`), emit it over the existing per-agent notification socket room, append a new `reply_owed_reminder_sent` event, and call `touchInactivityClock` directly to push the deadline out without touching `confirmPhase` or posting a player-facing message.

**Tech Stack:** Express 5 + TypeScript, Drizzle ORM, PostgreSQL (RLS via `withWorkspace`), Socket.io, Vitest.

## Global Constraints

- No schema/migration changes — `notification.type` and `event.type` are both free `text` columns, no enum to extend.
- `supportOwedFlag` / stage 2's timeout logic is unchanged — it still exists for the case where an ask _was_ sent and the player then went silent.
- `touchInactivityClock`'s trigger (any public message resets the clock) is unchanged — this fix only changes what stage 1 does when the window expires.
- Reply-owed path must never call `postMessage` or flip `confirmPhase` — it must leave `confirmPhase` at `'none'` so stage 2 can never act on this path (stage 2's candidate query requires `confirmPhase = 'inactivity_ask'`).
- Internal notes (`visibility = 'internal'`) must not count as a reply, mirroring stage 2's existing query filter.

---

## File Structure

- **Create** `backend/src/domain/notifications/notifyAgentReplyOwed.ts` — new notification-write function, mirrors `notifyAgent.ts`'s shape (conversation/workspace lookup, `notification` insert, returns `NotificationView` via the existing exported `toNotificationView`).
- **Modify** `backend/src/shared/jobs/inactivityClock.ts` — `candidates()` selects `conversation.assignedAgentId`; `lockAndCheck()` re-reads it; `runAskStage()` branches on the last-public-message author before posting.
- **Create** `backend/tests/notifications.notifyAgentReplyOwed.test.ts` — new test file for the notification write, mirrors `backend/tests/notifications.notifyAgent.test.ts`.
- **Modify** `backend/tests/jobs.inactivityClock.test.ts` — add the four new stage-1 cases from the spec's Testing section.

No frontend changes: `NotificationView.payload` is already typed as `TicketAssignedPayload | Record<string, unknown>`, which already covers an arbitrary `reply_owed` payload shape without a type change.

---

### Task 1: `notifyAgentReplyOwed`

**Files:**

- Create: `backend/src/domain/notifications/notifyAgentReplyOwed.ts`
- Test: `backend/tests/notifications.notifyAgentReplyOwed.test.ts`

**Interfaces:**

- Consumes: `Tx` (`backend/src/shared/db/withWorkspace.ts`), `notification`/`conversation`/`workspace` tables (`backend/src/shared/db/schema/index.ts`), `toNotificationView` (exported from `backend/src/domain/notifications/notifyAgent.ts`), `NotificationView` (`@support/types`).
- Produces: `notifyAgentReplyOwed(tx: Tx, params: NotifyAgentReplyOwedParams): Promise<NotificationView>` and `export type NotifyAgentReplyOwedParams = { workspaceId: string; agentId: string; conversationId: string }`. Task 2 calls this once per notified agent/team-lead.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/notifications.notifyAgentReplyOwed.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { notifyAgentReplyOwed } from '../src/domain/notifications/notifyAgentReplyOwed.ts';
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

describe('notifyAgentReplyOwed', () => {
  it('inserts a reply_owed notification with a snapshotted payload', async () => {
    const workspaceId = await seedWorkspace({ name: 'Wanderlust Kingdoms', slug: 'wanderlust' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, priority: 'p1' });
    const agentId = await seedAgent();

    const view = await withWorkspace(workspaceId, (tx) =>
      notifyAgentReplyOwed(tx, { workspaceId, agentId, conversationId }),
    );

    expect(view.workspace_id).toBe(workspaceId);
    expect(view.agent_id).toBe(agentId);
    expect(view.conversation_id).toBe(conversationId);
    expect(view.type).toBe('reply_owed');
    expect(view.read_at).toBeNull();
    expect(view.payload).toMatchObject({
      priority: 'p1',
      workspace_name: 'Wanderlust Kingdoms',
      workspace_slug: 'wanderlust',
    });
    expect(typeof (view.payload as { ticket_number: number }).ticket_number).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test notifications.notifyAgentReplyOwed.test.ts`
Expected: FAIL — `Cannot find module '../src/domain/notifications/notifyAgentReplyOwed.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/domain/notifications/notifyAgentReplyOwed.ts`:

```typescript
import { eq } from 'drizzle-orm';
import type { NotificationView } from '@support/types';
import type { Tx } from '../../shared/db/withWorkspace.ts';
import { conversation, notification, workspace } from '../../shared/db/schema/index.ts';
import { toNotificationView } from './notifyAgent.ts';

export type NotifyAgentReplyOwedParams = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
};

/**
 * Write path for the inactivity clock's reply-owed nudge — parallels
 * notifyAgent but carries no `via`, since this is not an assignment. Called
 * once per notified agent (the assignee, or every team lead when the
 * conversation is unassigned) from runAskStage's reply-owed branch.
 */
export async function notifyAgentReplyOwed(
  tx: Tx,
  params: NotifyAgentReplyOwedParams,
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
      type: 'reply_owed',
      conversationId: params.conversationId,
      payload: {
        ticket_number: conv?.number ?? null,
        priority: conv?.priority ?? null,
        workspace_name: ws?.name ?? null,
        workspace_slug: ws?.slug ?? null,
      },
    })
    .returning();

  return toNotificationView(row!);
}
```

Then export `toNotificationView` from `notifyAgent.ts` if not already exported at module scope — it already is (`export function toNotificationView` at `backend/src/domain/notifications/notifyAgent.ts:13`), so no change needed there.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter backend test notifications.notifyAgentReplyOwed.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/domain/notifications/notifyAgentReplyOwed.ts backend/tests/notifications.notifyAgentReplyOwed.test.ts
git commit -m "feat: add notifyAgentReplyOwed for inactivity clock reply-owed nudge"
```

---

### Task 2: Export `notifyAgentReplyOwed` and `emitNotificationNew` where `runAskStage` can reach them

**Files:**

- Modify: `backend/src/shared/jobs/inactivityClock.ts:1-14` (imports)

**Interfaces:**

- Consumes: `notifyAgentReplyOwed` (Task 1), `emitNotificationNew(io: Server, agentId: string, notificationView: NotificationView): void` (`backend/src/shared/realtime/emit.ts:71-77`), `touchInactivityClock(tx: Tx, args: { conversationId: string; now: Date }): Promise<void>` (`backend/src/domain/conversations/resolutionCycle.ts:62-87`, re-exported from `backend/src/domain/conversations/index.ts`), `workspaceMember` table (`backend/src/shared/db/schema/index.ts`).
- Produces: nothing new — this task only wires imports that Task 3 uses.

- [ ] **Step 1: Add the imports**

In `backend/src/shared/jobs/inactivityClock.ts`, replace the top of the file:

```typescript
import { and, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import { conversation, message, resolutionCycle, workspace } from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace, type Tx } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import {
  closeResolutionCycle,
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  toAgentView,
  toPlayerView,
} from '../../domain/conversations/index.ts';
import { emitInboxChanged, emitMessageToRooms, emitPhaseChanged } from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';
```

with:

```typescript
import { and, desc, eq, inArray, isNull, lte, ne } from 'drizzle-orm';
import {
  conversation,
  message,
  resolutionCycle,
  workspace,
  workspaceMember,
} from '../db/schema/index.ts';
import { withWorkspace, withoutWorkspace, type Tx } from '../db/withWorkspace.ts';
import { appendEvent } from '../events/appendEvent.ts';
import {
  closeResolutionCycle,
  postMessage,
  RESOLUTION_CHECK_MESSAGE,
  toAgentView,
  toPlayerView,
  touchInactivityClock,
} from '../../domain/conversations/index.ts';
import {
  emitInboxChanged,
  emitMessageToRooms,
  emitNotificationNew,
  emitPhaseChanged,
} from '../realtime/emit.ts';
import { tryIo } from '../realtime/tryIo.ts';
import { logger } from '../logging/logger.ts';
import { notifyAgentReplyOwed } from '../../domain/notifications/notifyAgentReplyOwed.ts';
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS — the new imports resolve; `workspaceMember`/`touchInactivityClock`/`emitNotificationNew`/`notifyAgentReplyOwed` are all unused until Task 3, which will fail lint (`no-unused-vars`) but typecheck passes. If typecheck also fails on unused imports, skip lint and proceed directly to Task 3 in the same commit — do not commit Task 2 alone if it fails typecheck/lint. In that case, fold this task's diff into Task 3's Step 1 instead of committing separately.

- [ ] **Step 3: Commit**

Only commit if Step 2 passes standalone. Otherwise carry these changes uncommitted into Task 3.

```bash
git add backend/src/shared/jobs/inactivityClock.ts
git commit -m "chore: import reply-owed dependencies into inactivityClock job"
```

---

### Task 3: Add `assignedAgentId` to stage candidates and the lock re-check

**Files:**

- Modify: `backend/src/shared/jobs/inactivityClock.ts:59-101`

**Interfaces:**

- Consumes: `conversation.assignedAgentId` column (`backend/src/shared/db/schema/index.ts`).
- Produces: `candidates()` now returns `{ cycleId: string; conversationId: string; assignedAgentId: string | null }[]`; `lockAndCheck()` now returns `{ status: string; confirmPhase: string; assignedAgentId: string | null } | null` instead of `boolean` (callers in Task 4/5 destructure this). Task 4's `runAskStage` relies on both of these exact shapes.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/jobs.inactivityClock.test.ts`, inside `describe('runInactivityClock — stage 1 (ask)', ...)`:

```typescript
it('agent has not replied: does not post the check, re-arms the clock, notifies the assigned agent', async () => {
  const { workspaceId, conversationId, playerId } = await fixture();
  const agentId = await seedAgent();
  await withWorkspace(workspaceId, (tx) =>
    tx
      .update(conversation)
      .set({ assignedAgentId: agentId })
      .where(eq(conversation.id, conversationId)),
  );
  await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });

  expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });

  const messages = await withWorkspace(workspaceId, (tx) =>
    tx.select().from(message).where(eq(message.conversationId, conversationId)),
  );
  expect(messages.some((m) => m.body === RESOLUTION_CHECK_MESSAGE)).toBe(false);

  expect((await readConversation(workspaceId, conversationId)).confirmPhase).toBe('none');
  expect((await readCycle(workspaceId, conversationId)).inactivityDueAt!.toISOString()).toBe(
    nextInactivityDueAt(NOW, 24).toISOString(),
  );

  const notifications = await withWorkspace(workspaceId, (tx) =>
    tx.select().from(notification).where(eq(notification.conversationId, conversationId)),
  );
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.agentId).toBe(agentId);
  expect(notifications[0]!.type).toBe('reply_owed');

  const events = await withWorkspace(workspaceId, (tx) =>
    tx.select().from(event).where(eq(event.conversationId, conversationId)),
  );
  expect(events.some((e) => e.type === 'reply_owed_reminder_sent')).toBe(true);
});
```

Add `seedAgent` and `notification` to the test file's existing imports (`backend/tests/jobs.inactivityClock.test.ts`):

```typescript
import {
  conversation,
  event,
  message,
  notification,
  resolutionCycle,
} from '../src/shared/db/schema/index.ts';
```

```typescript
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter backend test jobs.inactivityClock.test.ts`
Expected: FAIL — the unmodified `runAskStage` still posts `RESOLUTION_CHECK_MESSAGE` unconditionally, so `messages.some(...)` is `true` and `confirmPhase` is `'inactivity_ask'`, not `'none'`.

- [ ] **Step 3: Modify `candidates()` and `lockAndCheck()`**

In `backend/src/shared/jobs/inactivityClock.ts`, replace `candidates()`:

```typescript
async function candidates(
  workspaceId: string,
  now: Date,
  phase: 'none' | 'inactivity_ask',
): Promise<{ cycleId: string; conversationId: string; assignedAgentId: string | null }[]> {
  return withWorkspace(workspaceId, async (tx) =>
    tx
      .select({
        cycleId: resolutionCycle.id,
        conversationId: resolutionCycle.conversationId,
        assignedAgentId: conversation.assignedAgentId,
      })
      .from(resolutionCycle)
      .innerJoin(conversation, eq(conversation.id, resolutionCycle.conversationId))
      .where(
        and(
          isNull(resolutionCycle.resolvedAt),
          lte(resolutionCycle.inactivityDueAt, now),
          inArray(conversation.status, CLOCK_STATUSES),
          eq(conversation.confirmPhase, phase),
        ),
      ),
  );
}
```

Replace `lockAndCheck()`:

```typescript
async function lockAndCheck(
  tx: Tx,
  conversationId: string,
  phase: 'none' | 'inactivity_ask',
): Promise<{ status: string; confirmPhase: string; assignedAgentId: string | null } | null> {
  const [locked] = await tx
    .select({
      status: conversation.status,
      confirmPhase: conversation.confirmPhase,
      assignedAgentId: conversation.assignedAgentId,
    })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1)
    .for('update');

  if (!locked) return null;
  if (locked.confirmPhase !== phase) return null;
  if (!(CLOCK_STATUSES as readonly string[]).includes(locked.status)) return null;
  return locked;
}
```

- [ ] **Step 4: Update `runTimeoutStage`'s call site to the new `lockAndCheck` return shape**

`runTimeoutStage` currently does `if (!(await lockAndCheck(tx, row.conversationId, 'inactivity_ask'))) return false;` — this still works unchanged because `null` is falsy and any returned object is truthy, so no edit is required here. Confirm this by reading `backend/src/shared/jobs/inactivityClock.ts:173` after Step 3 — leave it as-is.

- [ ] **Step 5: Run test to verify it still fails the same way (no crash, just wrong behavior)**

Run: `pnpm --filter backend test jobs.inactivityClock.test.ts`
Expected: FAIL — same assertion failures as Step 2 (posts the check anyway), not a type/runtime error. This confirms Task 3's schema change alone didn't break stage 2 and `runAskStage` compiles against the new `lockAndCheck` return type (TypeScript will still treat `lockAndCheck`'s truthy object as `!(...)` in `runAskStage` too, at `inactivityClock.ts:110` — no signature mismatch since nothing there destructures fields yet).

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/jobs/inactivityClock.ts backend/tests/jobs.inactivityClock.test.ts
git commit -m "feat: surface assignedAgentId in inactivity clock candidate/lock queries"
```

---

### Task 4: Branch `runAskStage` on the last public message's author

**Files:**

- Modify: `backend/src/shared/jobs/inactivityClock.ts:103-164` (`runAskStage`)

**Interfaces:**

- Consumes: `candidates()`/`lockAndCheck()` from Task 3, `notifyAgentReplyOwed` (Task 1), `emitNotificationNew` (`backend/src/shared/realtime/emit.ts:71-77`), `touchInactivityClock` (`backend/src/domain/conversations/resolutionCycle.ts:62-87`), `workspaceMember` table, `appendEvent` (`backend/src/shared/events/appendEvent.ts:30`).
- Produces: `runAskStage` behavior split into two paths as described in the spec. No new exports — this is the terminal task that makes Task 3's test pass.

- [ ] **Step 1: Replace `runAskStage`**

Replace the full body of `runAskStage` in `backend/src/shared/jobs/inactivityClock.ts`:

```typescript
async function runAskStage(workspaceId: string, now: Date): Promise<number> {
  const rows = await candidates(workspaceId, now, 'none');

  let asked = 0;
  for (const row of rows) {
    try {
      const outcome = await withWorkspace(workspaceId, async (tx) => {
        const locked = await lockAndCheck(tx, row.conversationId, 'none');
        if (!locked) return null;

        // Same query stage 2 runs at inactivityClock.ts:179-190 — the last
        // public, non-system message decides whether the agent owes a reply.
        const [last] = await tx
          .select({ authorType: message.authorType })
          .from(message)
          .where(
            and(
              eq(message.conversationId, row.conversationId),
              eq(message.visibility, 'public'),
              ne(message.authorType, 'system'),
            ),
          )
          .orderBy(desc(message.seq))
          .limit(1);

        if (last?.authorType === 'player') {
          // The agent hasn't replied since the player's last message — asking
          // "Did this solve it?" would be nonsensical. Nudge the agent (or
          // every team lead, if unassigned) and re-arm the clock silently
          // instead of posting a player-facing message or flipping confirmPhase.
          const notifiedAgentIds: string[] = [];
          if (locked.assignedAgentId) {
            notifiedAgentIds.push(locked.assignedAgentId);
          } else {
            const leads = await tx
              .select({ agentId: workspaceMember.agentId })
              .from(workspaceMember)
              .where(
                and(
                  eq(workspaceMember.workspaceId, workspaceId),
                  eq(workspaceMember.role, 'team_lead'),
                  isNull(workspaceMember.deactivatedAt),
                ),
              );
            notifiedAgentIds.push(...leads.map((l) => l.agentId));
          }

          const notifications = [];
          for (const agentId of notifiedAgentIds) {
            notifications.push(
              await notifyAgentReplyOwed(tx, {
                workspaceId,
                agentId,
                conversationId: row.conversationId,
              }),
            );
          }

          await touchInactivityClock(tx, { conversationId: row.conversationId, now });

          await appendEvent(tx, {
            workspaceId,
            type: 'reply_owed_reminder_sent',
            conversationId: row.conversationId,
            actorId: null,
            actorType: 'system',
            payload: {
              source: 'inactivity',
              notified: locked.assignedAgentId ? 'agent' : 'team_leads',
            },
          });

          return { kind: 'reply_owed' as const, notifications };
        }

        // `now` is threaded into postMessage so the stage 2 deadline this touch
        // writes is derived from the tick's clock, not from wall time.
        const sent = await postMessage(tx, {
          workspaceId,
          conversationId: row.conversationId,
          authorType: 'system',
          actorId: null,
          body: RESOLUTION_CHECK_MESSAGE,
          visibility: 'public',
          now,
        });

        await tx
          .update(conversation)
          .set({ confirmPhase: 'inactivity_ask' })
          .where(eq(conversation.id, row.conversationId));

        // Same event type the agent's manual ask writes, disambiguated by
        // payload `source` — the pattern conversation_assigned already uses for
        // `via`. Two event types for one fact would split every funnel that
        // counts "questions asked".
        await appendEvent(tx, {
          workspaceId,
          type: 'resolution_check_requested',
          conversationId: row.conversationId,
          actorId: null,
          actorType: 'system',
          payload: { source: 'inactivity' },
        });

        return { kind: 'asked' as const, message: sent };
      });

      if (!outcome) continue;
      asked += 1;

      const io = tryIo('jobs', { workspaceId, conversationId: row.conversationId });
      if (outcome.kind === 'reply_owed') {
        if (io) {
          for (const notificationView of outcome.notifications) {
            emitNotificationNew(io, notificationView.agent_id, notificationView);
          }
        }
      } else {
        if (io) {
          emitMessageToRooms(
            io,
            row.conversationId,
            toPlayerView(outcome.message),
            toAgentView(outcome.message),
          );
          emitPhaseChanged(io, row.conversationId, {
            conversation_id: row.conversationId,
            confirm_phase: 'inactivity_ask',
          });
        }
      }
    } catch (error) {
      logger.error('jobs', `inactivity-clock ask failed for conversation ${row.conversationId}`, {
        workspaceId,
        error: error instanceof Error ? `${error.name} ${error.message}` : String(error),
      });
    }
  }
  return asked;
}
```

Note: `asked` now counts both "asked" and "reply-owed nudged" outcomes as one bucket in `InactivityClockResult.asked`, since the spec's test assertion for the reply-owed case expects `{ asked: 0, timedOut: 0 }` — re-check this against Step 2 below before finalizing; the test in Task 3 asserts `asked: 0` for the reply-owed path, so `asked` must NOT be incremented on the `'reply_owed'` branch. Correct the increment to only happen on the `'asked'` branch:

Replace `if (!outcome) continue; asked += 1;` with:

```typescript
if (!outcome) continue;
if (outcome.kind === 'asked') asked += 1;
```

- [ ] **Step 2: Run the Task 3 test to verify it passes**

Run: `pnpm --filter backend test jobs.inactivityClock.test.ts`
Expected: PASS for the new "agent has not replied" case. The existing "posts the check" test (unchanged fixture, no messages seeded beyond what `fixture()` creates) must also still PASS — `fixture()` seeds no messages, so `last` is `undefined`, `last?.authorType === 'player'` is `false`, and the original ask path runs unchanged.

- [ ] **Step 3: Commit**

```bash
git add backend/src/shared/jobs/inactivityClock.ts
git commit -m "feat: gate inactivity clock ask stage on agent-reply-owed check"
```

---

### Task 5: Remaining spec test cases — unassigned conversation and internal-note exclusion

**Files:**

- Modify: `backend/tests/jobs.inactivityClock.test.ts`

**Interfaces:**

- Consumes: `seedWorkspaceMember(args: { workspaceId: string; agentId: string; role?: 'agent' | 'team_lead'; deactivatedAt?: Date | null }): Promise<string>` (`backend/tests/helpers/db.ts:247-259`), everything from Task 3/4.
- Produces: nothing new — final verification pass.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/jobs.inactivityClock.test.ts`, inside the same `describe('runInactivityClock — stage 1 (ask)', ...)` block:

```typescript
it('unassigned conversation, agent has not replied: notifies every team lead, not plain agents', async () => {
  const { workspaceId, conversationId } = await fixture();
  const leadId = await seedAgent();
  const plainAgentId = await seedAgent();
  const deactivatedLeadId = await seedAgent();
  await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
  await seedWorkspaceMember({ workspaceId, agentId: plainAgentId, role: 'agent' });
  await seedWorkspaceMember({
    workspaceId,
    agentId: deactivatedLeadId,
    role: 'team_lead',
    deactivatedAt: new Date(),
  });
  await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });

  expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });

  const notifications = await withWorkspace(workspaceId, (tx) =>
    tx.select().from(notification).where(eq(notification.conversationId, conversationId)),
  );
  expect(notifications).toHaveLength(1);
  expect(notifications[0]!.agentId).toBe(leadId);
});

it('internal note from the agent does not count as a reply', async () => {
  const { workspaceId, conversationId } = await fixture();
  const agentId = await seedAgent();
  await withWorkspace(workspaceId, (tx) =>
    tx
      .update(conversation)
      .set({ assignedAgentId: agentId })
      .where(eq(conversation.id, conversationId)),
  );
  await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
  await seedMessage({
    workspaceId,
    conversationId,
    seq: 2,
    authorType: 'agent',
    visibility: 'internal',
  });

  expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });

  const messages = await withWorkspace(workspaceId, (tx) =>
    tx.select().from(message).where(eq(message.conversationId, conversationId)),
  );
  expect(messages.some((m) => m.body === RESOLUTION_CHECK_MESSAGE)).toBe(false);
  expect((await readConversation(workspaceId, conversationId)).confirmPhase).toBe('none');
});
```

Add `seedWorkspaceMember` to the existing helper import list in `backend/tests/jobs.inactivityClock.test.ts`.

- [ ] **Step 2: Run tests to verify they pass**

Run: `pnpm --filter backend test jobs.inactivityClock.test.ts`
Expected: PASS for both new cases without further implementation changes — Task 4's code already excludes `visibility = 'internal'` (the `eq(message.visibility, 'public')` filter) and already branches on `assignedAgentId` vs. team-lead lookup.

- [ ] **Step 3: Run the full backend test suite**

Run: `pnpm --filter backend test`
Expected: PASS — confirms no regression in `notifications.notifyAgent.test.ts`, `jobs.inactivityClock.test.ts` (all cases, including the pre-existing "agent had replied" and stage 2 tests), or anywhere else that touches `conversation`, `notification`, or `event`.

- [ ] **Step 4: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/tests/jobs.inactivityClock.test.ts
git commit -m "test: cover unassigned reply-owed and internal-note exclusion cases"
```

---

### Task 6: Register the OpenAPI-adjacent nothing — confirm no route surface changed

**Files:** none (verification-only task; no code changes expected)

**Interfaces:** N/A

This feature adds no new HTTP route, so `backend/src/docs/openapi.ts` needs no edit (per CLAUDE.md's "register new endpoints" rule — this doesn't apply here since nothing is exposed over HTTP). This task exists only to make that explicit so a reviewer doesn't ask for it.

- [ ] **Step 1: Confirm no new route was added**

Run: `git diff --stat HEAD~5 -- backend/src/agent/routes backend/src/docs/openapi.ts` (adjust commit range to cover this plan's commits)
Expected: no output — no route files touched.

- [ ] **Step 2: No commit needed** (verification only)

---

## Self-Review Notes

- **Spec coverage:** §1 gate → Task 4 Step 1 (branch on `last?.authorType`). §2 reply-owed path → Task 1 (`notifyAgentReplyOwed`) + Task 4 (assigned-agent vs. team-lead branch) + Task 2 (`emitNotificationNew`/`tryIo` wiring). §3 re-arm without flipping `confirmPhase` → Task 4 (`touchInactivityClock` call, no `confirmPhase` update on that branch). §4 audit event → Task 4 (`reply_owed_reminder_sent` append). Testing section → Tasks 3 and 5 cover all four `jobs.inactivityClock.test.ts` cases and the `notifyAgentReplyOwed` payload test.
- **Placeholder scan:** no TBD/TODO; all code blocks are complete, runnable diffs.
- **Type consistency:** `lockAndCheck` return type changed from `boolean` to an object-or-`null` in Task 3 — verified `runTimeoutStage`'s existing `!(await lockAndCheck(...))` call site still works unchanged (falsy check holds for `null`). `candidates()`'s new `assignedAgentId` field flows into `runAskStage`'s `row.assignedAgentId`... actually consumed via `locked.assignedAgentId` (from `lockAndCheck`, re-read to avoid the stale-assignment race per the spec) rather than `row.assignedAgentId` (from the earlier, already-committed candidate scan) — Task 4's code correctly reads `locked.assignedAgentId`, not `row.assignedAgentId`, matching the spec's explicit instruction that `lockAndCheck` "should re-read it too, to avoid acting on a stale assignment."
