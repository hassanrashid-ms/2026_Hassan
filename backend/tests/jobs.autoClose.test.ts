import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { runAutoClose } from '../src/shared/jobs/autoClose.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function resolvedFixture(args: {
  resolvedAt: Date;
  autoCloseDays?: number;
  status?: 'resolved' | 'open' | 'closed';
  slug?: string;
  closedAt?: Date | null;
}) {
  const workspaceId = await seedWorkspace({
    slug: args.slug ?? 'demo-game',
    autoCloseDays: args.autoCloseDays ?? 7,
  });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: args.status ?? 'resolved',
    resolutionSource: 'agent',
  });
  const cycleId = await seedResolutionCycle({
    workspaceId,
    conversationId,
    resolvedAt: args.resolvedAt,
    resolutionKind: 'agent',
    closedAt: args.closedAt ?? null,
  });
  return { workspaceId, conversationId, cycleId };
}

const read = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [conv] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    const [cycle] = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId));
    return { conv: conv!, cycle: cycle! };
  });

describe('runAutoClose', () => {
  it('closes a conversation resolved longer ago than the window', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({ resolvedAt: daysAgo(8) });

    expect(await runAutoClose({ now: NOW })).toBe(1);

    const { conv, cycle } = await read(workspaceId, conversationId);
    expect(conv.status).toBe('closed');
    expect(cycle.closedAt!.toISOString()).toBe(NOW.toISOString());
  });

  it('appends conversation_closed with a system actor and the window it used', async () => {
    const { workspaceId } = await resolvedFixture({ resolvedAt: daysAgo(8) });
    await runAutoClose({ now: NOW });

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_closed')),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.payload).toMatchObject({ reason: 'auto_close', days: 7 });
  });

  it('leaves a conversation inside the window alone', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({ resolvedAt: daysAgo(3) });
    expect(await runAutoClose({ now: NOW })).toBe(0);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('resolved');
  });

  it('respects a non-default auto_close_days', async () => {
    const { workspaceId, conversationId } = await resolvedFixture({
      resolvedAt: daysAgo(3),
      autoCloseDays: 2,
    });
    expect(await runAutoClose({ now: NOW })).toBe(1);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('closed');
  });

  it('skips a superseded cycle whose conversation was reopened', async () => {
    // The old cycle keeps resolved_at and a null closed_at forever — correct,
    // "this resolution never got auto-closed because it reopened first". The
    // status join is what stops it being closed under the live conversation.
    const { workspaceId, conversationId } = await resolvedFixture({
      resolvedAt: daysAgo(30),
      status: 'open',
    });
    expect(await runAutoClose({ now: NOW })).toBe(0);
    expect((await read(workspaceId, conversationId)).conv.status).toBe('open');
  });

  it('skips a cycle that is already closed', async () => {
    await resolvedFixture({ resolvedAt: daysAgo(30), closedAt: daysAgo(20), status: 'closed' });
    expect(await runAutoClose({ now: NOW })).toBe(0);
  });

  it('is idempotent across runs', async () => {
    const { workspaceId } = await resolvedFixture({ resolvedAt: daysAgo(8) });
    expect(await runAutoClose({ now: NOW })).toBe(1);
    expect(await runAutoClose({ now: NOW })).toBe(0);
    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_closed')),
    );
    expect(events).toHaveLength(1);
  });

  it('sweeps every workspace with its own window', async () => {
    await resolvedFixture({ resolvedAt: daysAgo(8), slug: 'game-a', autoCloseDays: 7 });
    await resolvedFixture({ resolvedAt: daysAgo(8), slug: 'game-b', autoCloseDays: 30 });
    expect(await runAutoClose({ now: NOW })).toBe(1);
  });

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({ slug: 'retired', disabledAt: daysAgo(60) });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' });
    await seedResolutionCycle({
      workspaceId,
      conversationId,
      resolvedAt: daysAgo(30),
      resolutionKind: 'bot',
    });

    expect(await runAutoClose({ now: NOW })).toBe(0);
  });
});
