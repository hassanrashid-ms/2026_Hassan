import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { conversation, event, message, resolutionCycle } from '../src/shared/db/schema/index.ts';
import { runInactivityClock } from '../src/shared/jobs/inactivityClock.ts';
import {
  RESOLUTION_CHECK_MESSAGE,
  nextInactivityDueAt,
} from '../src/domain/conversations/index.ts';
import {
  closeOwnerPool,
  seedConversation,
  seedMessage,
  seedPlayer,
  seedResolutionCycle,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-18T12:00:00Z');
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

type FixtureArgs = {
  status?: 'open' | 'awaiting_player' | 'escalated' | 'bot_active' | 'resolved';
  confirmPhase?: 'none' | 'inactivity_ask' | 'agent_ask';
  dueAt?: Date | null;
  resolvedAt?: Date | null;
  slug?: string;
};

async function fixture(args: FixtureArgs = {}) {
  const workspaceId = await seedWorkspace({ slug: args.slug ?? 'demo-game' });
  const playerId = await seedPlayer(workspaceId);
  const conversationId = await seedConversation({
    workspaceId,
    playerId,
    status: args.status ?? 'open',
    confirmPhase: args.confirmPhase ?? 'none',
  });
  const cycleId = await seedResolutionCycle({
    workspaceId,
    conversationId,
    inactivityDueAt: args.dueAt === undefined ? hoursAgo(1) : args.dueAt,
    resolvedAt: args.resolvedAt ?? null,
  });
  return { workspaceId, playerId, conversationId, cycleId };
}

const readConversation = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select().from(conversation).where(eq(conversation.id, conversationId));
    return row!;
  });

const readCycle = (workspaceId: string, conversationId: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(resolutionCycle)
      .where(eq(resolutionCycle.conversationId, conversationId));
    return row!;
  });

describe('runInactivityClock — stage 1 (ask)', () => {
  it('posts the check, sets inactivity_ask and pushes the clock a window out', async () => {
    const { workspaceId, conversationId } = await fixture();

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 1, timedOut: 0 });

    const messages = await withWorkspace(workspaceId, (tx) =>
      tx
        .select()
        .from(message)
        .where(eq(message.conversationId, conversationId))
        .orderBy(asc(message.seq)),
    );
    expect(messages.at(-1)!.body).toBe(RESOLUTION_CHECK_MESSAGE);
    expect(messages.at(-1)!.authorType).toBe('system');
    expect(messages.at(-1)!.visibility).toBe('public');

    expect((await readConversation(workspaceId, conversationId)).confirmPhase).toBe(
      'inactivity_ask',
    );
    expect((await readCycle(workspaceId, conversationId)).inactivityDueAt!.toISOString()).toBe(
      nextInactivityDueAt(NOW, 24).toISOString(),
    );
  });

  it('appends resolution_check_requested with a system actor and source inactivity', async () => {
    const { workspaceId } = await fixture();
    await runInactivityClock({ now: NOW });

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'resolution_check_requested')),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity' });
  });

  it('does not ask before the due date', async () => {
    await fixture({ dueAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it.each(['escalated', 'bot_active', 'resolved'] as const)('skips %s', async (status) => {
    // escalated also has a NULL clock in production; the status filter is the
    // second guard and is asserted here with the clock deliberately left running.
    await fixture({ status });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('skips a conversation that already has a question on screen', async () => {
    await fixture({ confirmPhase: 'agent_ask' });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('skips a cycle that is already resolved', async () => {
    await fixture({ status: 'open', resolvedAt: hoursAgo(48) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });

  it('never asks twice in one tick', async () => {
    const { workspaceId, conversationId } = await fixture();
    await runInactivityClock({ now: NOW });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
    const messages = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, conversationId)),
    );
    expect(messages.filter((m) => m.body === RESOLUTION_CHECK_MESSAGE)).toHaveLength(1);
  });
});

describe('runInactivityClock — stage 2 (timeout)', () => {
  it('resolves as timed_out and closes the cycle', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 1 });

    const conv = await readConversation(workspaceId, conversationId);
    expect(conv.status).toBe('resolved');
    expect(conv.confirmPhase).toBe('none');
    expect(conv.resolutionSource).toBe('timed_out');

    const cycle = await readCycle(workspaceId, conversationId);
    expect(cycle.resolutionKind).toBe('timed_out');
    expect(cycle.resolvedAt!.toISOString()).toBe(NOW.toISOString());
    expect(cycle.inactivityDueAt).toBeNull();

    const events = await withWorkspace(workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.type, 'conversation_resolved')),
    );
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.payload).toMatchObject({ source: 'inactivity', confirmed_by: 'timeout' });
  });

  it('flags support_owed when the last public word was the player’s', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    // Stage 1's own ask. It must not be what the flag is computed from.
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'system' });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(true);
  });

  it('does not flag support_owed when an agent had replied', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    await seedMessage({ workspaceId, conversationId, seq: 2, authorType: 'agent' });
    await seedMessage({ workspaceId, conversationId, seq: 3, authorType: 'system' });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(false);
  });

  it('ignores an internal note when deciding support_owed', async () => {
    const { workspaceId, conversationId } = await fixture({ confirmPhase: 'inactivity_ask' });
    await seedMessage({ workspaceId, conversationId, seq: 1, authorType: 'player' });
    await seedMessage({
      workspaceId,
      conversationId,
      seq: 2,
      authorType: 'agent',
      visibility: 'internal',
    });

    await runInactivityClock({ now: NOW });
    expect((await readCycle(workspaceId, conversationId)).supportOwedFlag).toBe(true);
  });

  it('does not time out before the second window elapses', async () => {
    await fixture({ confirmPhase: 'inactivity_ask', dueAt: new Date(NOW.getTime() + 3_600_000) });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });
});

describe('runInactivityClock — both stages in one tick', () => {
  it('never asks and times out the same conversation in one run', async () => {
    const { workspaceId, conversationId } = await fixture();
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 1, timedOut: 0 });
    expect((await readConversation(workspaceId, conversationId)).status).toBe('open');
  });

  it('sweeps every workspace, each in its own tenant scope', async () => {
    for (const slug of ['game-a', 'game-b', 'game-c']) await fixture({ slug });
    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 3, timedOut: 0 });
  });

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({
      slug: 'retired',
      disabledAt: new Date('2026-07-01T00:00:00Z'),
    });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' });
    await seedResolutionCycle({ workspaceId, conversationId, inactivityDueAt: hoursAgo(1) });

    expect(await runInactivityClock({ now: NOW })).toEqual({ asked: 0, timedOut: 0 });
  });
});
