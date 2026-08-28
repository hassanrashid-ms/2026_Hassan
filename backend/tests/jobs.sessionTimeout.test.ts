import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { event, session } from '../src/shared/db/schema/index.ts';
import { closeStaleSessions } from '../src/shared/jobs/sessionTimeout.ts';
import {
  closeOwnerPool,
  seedPlayer,
  seedSession,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

const NOW = new Date('2026-08-04T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('closeStaleSessions', () => {
  it('closes a session older than the timeout and marks it ended_by timeout', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    const stale = await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) });

    const closed = await closeStaleSessions({ now: NOW, timeoutMinutes: 30 });
    expect(closed).toBe(1);

    const rows = await withWorkspace(workspaceId, async (tx) =>
      tx.select().from(session).where(eq(session.id, stale)),
    );
    expect(rows[0]!.endedAt!.toISOString()).toBe(NOW.toISOString());
    expect(rows[0]!.endedBy).toBe('timeout');
  });

  it('appends one session_end event with a system actor and the derived duration', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) });

    await closeStaleSessions({ now: NOW, timeoutMinutes: 30 });

    const events = await withWorkspace(workspaceId, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_end')),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe('system');
    expect(events[0]!.actorId).toBeNull();
    expect(events[0]!.payload).toMatchObject({
      ended_by: 'timeout',
      duration_ms_derived: 45 * 60_000,
    });
  });

  it('leaves a recent session alone', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(10) });

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0);
    const rows = await withWorkspace(workspaceId, async (tx) => tx.select().from(session));
    expect(rows[0]!.endedAt).toBeNull();
  });

  it('leaves an already-ended session alone and does not double-append', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    await seedSession({
      workspaceId,
      playerId,
      startedAt: minutesAgo(45),
      endedAt: minutesAgo(40),
    });

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0);
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event));
    expect(events).toHaveLength(0);
  });

  it('is idempotent across runs', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) });

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(1);
    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0);
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event));
    expect(events).toHaveLength(1);
  });

  it('sweeps every workspace, each in its own tenant scope', async () => {
    const ids: string[] = [];
    for (const slug of ['game-a', 'game-b', 'game-c']) {
      const workspaceId = await seedWorkspace({ slug });
      const playerId = await seedPlayer(workspaceId, 'UserId7661');
      await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) });
      ids.push(workspaceId);
    }

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(3);
    for (const workspaceId of ids) {
      const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event));
      expect(events, workspaceId).toHaveLength(1);
      expect(events[0]!.workspaceId).toBe(workspaceId);
    }
  });

  it('skips a disabled workspace', async () => {
    const workspaceId = await seedWorkspace({
      slug: 'retired',
      disabledAt: new Date('2026-07-01T00:00:00Z'),
    });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    await seedSession({ workspaceId, playerId, startedAt: minutesAgo(45) });

    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(0);
  });

  it('closes many stale sessions in one pass', async () => {
    const workspaceId = await seedWorkspace({ slug: 'demo-game' });
    const playerId = await seedPlayer(workspaceId, 'UserId7661');
    for (let i = 0; i < 5; i += 1) {
      await seedSession({ workspaceId, playerId, startedAt: minutesAgo(31 + i) });
    }
    expect(await closeStaleSessions({ now: NOW, timeoutMinutes: 30 })).toBe(5);
    const events = await withWorkspace(workspaceId, async (tx) => tx.select().from(event));
    expect(events).toHaveLength(5);
  });
});
