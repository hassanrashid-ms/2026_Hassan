import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { applyResolutionAnswer } from '../src/domain/conversations/index.ts';
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts';
import { runInactivityClock } from '../src/shared/jobs/inactivityClock.ts';
import { runAutoClose } from '../src/shared/jobs/autoClose.ts';
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts';

const T0 = new Date('2026-08-18T12:00:00Z');
const plusHours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const plusDays = (n: number) => new Date(T0.getTime() + n * 86_400_000);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

const state = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    const cycles = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId))
      .orderBy(desc(resolutionCycle.cycleNo));
    return { conv: conv!, cycles };
  });

describe('inactivity clock end to end', () => {
  it('runs open → ask → timeout → auto-close → reopen as one cycle chain', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game', autoCloseDays: 7 });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'my gems vanished' });
    await withWorkspace(workspaceId, (tx) =>
      tx.update(conversation).set({ status: 'open' }).where(eq(conversation.id, conversation_id)),
    );
    // A public reply is what starts the clock — the same hook every path uses.
    await withWorkspace(workspaceId, (tx) =>
      tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id)),
    );

    // Stage 1 at T+25h.
    expect(await runInactivityClock({ now: plusHours(25) })).toEqual({ asked: 1, timedOut: 0 });
    expect((await state(workspaceId, conversation_id)).conv.confirmPhase).toBe('inactivity_ask');

    // Stage 2 at T+50h — 24h after the ask, nobody answered.
    expect(await runInactivityClock({ now: plusHours(50) })).toEqual({ asked: 0, timedOut: 1 });
    const timedOut = await state(workspaceId, conversation_id);
    expect(timedOut.conv.status).toBe('resolved');
    expect(timedOut.conv.resolutionSource).toBe('timed_out');
    expect(timedOut.cycles[0]!.resolutionKind).toBe('timed_out');
    expect(timedOut.cycles[0]!.supportOwedFlag).toBe(true);

    // Auto-close seven days after the resolve.
    expect(await runAutoClose({ now: plusDays(10) })).toBe(1);
    const closed = await state(workspaceId, conversation_id);
    expect(closed.conv.status).toBe('closed');
    expect(closed.cycles[0]!.closedAt).not.toBeNull();

    // Reopen opens cycle 2 and leaves cycle 1's record intact.
    await sendPlayerMessage(ctx, { body: 'it happened again' });
    const reopened = await state(workspaceId, conversation_id);
    expect(reopened.conv.status).toBe('open');
    expect(reopened.cycles.map((c) => c.cycleNo)).toEqual([2, 1]);
    expect(reopened.cycles[1]!.resolutionKind).toBe('timed_out');
    expect(reopened.cycles[0]!.inactivityDueAt).not.toBeNull();
  });

  it('a player answering Yes to the clock resolves as player_confirmed and stops the clock', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'open' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    await runInactivityClock({ now: plusHours(25) });
    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(
        tx,
        { workspaceId, conversationId: conversation_id, playerId, sessionId: null },
        true,
      ),
    );

    const after = await state(workspaceId, conversation_id);
    expect(after.conv.status).toBe('resolved');
    expect(after.conv.resolutionSource).toBe('player_confirmed');
    expect(after.cycles[0]!.inactivityDueAt).toBeNull();

    // Stage 2 must find nothing left to time out.
    expect(await runInactivityClock({ now: plusHours(60) })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('a player answering No restarts the clock instead of resolving', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'open' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(24) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    await runInactivityClock({ now: plusHours(25) });
    await withWorkspace(workspaceId, (tx) =>
      applyResolutionAnswer(
        tx,
        { workspaceId, conversationId: conversation_id, playerId, sessionId: null },
        false,
      ),
    );

    const after = await state(workspaceId, conversation_id);
    expect(after.conv.status).toBe('open');
    expect(after.conv.confirmPhase).toBe('none');
    expect(after.cycles[0]!.resolvedAt).toBeNull();
    expect(after.cycles[0]!.inactivityDueAt).not.toBeNull();
  });

  it('an escalated conversation is never asked and never timed out', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId);
    const ctx = { workspaceId, playerId } as never;

    const { conversation_id } = await sendPlayerMessage(ctx, { body: 'help' });
    await withWorkspace(workspaceId, async (tx) => {
      await tx
        .update(conversation)
        .set({ status: 'escalated' })
        .where(eq(conversation.id, conversation_id));
      await tx
        .update(resolutionCycle)
        .set({ inactivityDueAt: plusHours(1) })
        .where(eq(resolutionCycle.conversationId, conversation_id));
    });

    expect(await runInactivityClock({ now: plusHours(100) })).toEqual({ asked: 0, timedOut: 0 });
  });
});
