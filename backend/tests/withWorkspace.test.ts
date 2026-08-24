import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, db } from '../src/shared/db/client.ts';
import {
  InvalidWorkspaceId,
  withWorkspace,
  withoutWorkspace,
} from '../src/shared/db/withWorkspace.ts';
import { appendEvent } from '../src/shared/events/appendEvent.ts';
import { event, player, workspace } from '../src/shared/db/schema/index.ts';
import { closeOwnerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('withWorkspace', () => {
  it('sets the tenant for the duration of the transaction', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    const b = await seedWorkspace({ slug: 'game-b' });
    await seedPlayer(a, 'p-a');
    await seedPlayer(b, 'p-b');

    const seen = await withWorkspace(a, async (tx) => tx.select().from(player));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.externalId).toBe('p-a');
  });

  it('reverts the setting after the transaction so a pooled connection cannot leak it', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    await seedPlayer(a, 'p-a');
    await withWorkspace(a, async (tx) => tx.select().from(player));

    const leaked = await withoutWorkspace(async (tx) =>
      tx.execute(sql`select nullif(current_setting('app.workspace_id', true), '') as ws`),
    );
    expect(leaked.rows[0]?.ws).toBeNull();
  });

  it('rolls back everything when the callback throws', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    await expect(
      withWorkspace(a, async (tx) => {
        await tx.insert(player).values({ workspaceId: a, externalId: 'doomed' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await withWorkspace(a, async (tx) => tx.select().from(player));
    expect(rows).toHaveLength(0);
  });

  it('reads the unscoped tables through withoutWorkspace', async () => {
    await seedWorkspace({ slug: 'game-a' });
    await seedWorkspace({ slug: 'game-b' });
    const rows = await withoutWorkspace(async (tx) => tx.select().from(workspace));
    expect(rows).toHaveLength(2);
  });

  it('rejects a malformed workspace id before opening a transaction', async () => {
    await expect(
      withWorkspace('not-a-uuid', async (tx) => tx.select().from(player)),
    ).rejects.toThrow(InvalidWorkspaceId);
    // Also reject empty string and a SQL-injection-shaped value — neither is a UUID,
    // and both must fail fast rather than ever reaching Postgres.
    await expect(withWorkspace('', async (tx) => tx.select().from(player))).rejects.toThrow(
      InvalidWorkspaceId,
    );
    await expect(
      withWorkspace("'; drop table player; --", async (tx) => tx.select().from(player)),
    ).rejects.toThrow(InvalidWorkspaceId);
  });

  it('does not leak the workspace id onto a bare query that reuses the same pooled connection', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    await seedPlayer(a, 'p-a');

    await withWorkspace(a, async (tx) => tx.select().from(player));

    // Bare query — no transaction wrapper — issued on the SAME pool withWorkspace
    // just used. node-postgres's pool (pg-pool) keeps idle clients in a LIFO stack:
    // `release()` pushes onto `_idle`, `connect()` pops from the end of `_idle`. This
    // query runs immediately and serially after the transaction above has already
    // resolved (so its connection has already been released) with nothing else
    // contending for the pool in between, so popping `_idle` is guaranteed — not
    // merely likely — to hand back that exact physical connection. If
    // `set_config`'s third argument were `false` (session-scoped) instead of `true`
    // (transaction-local), the workspace filter would still be active on this
    // connection and this query would wrongly see the row.
    const rows = await db.select().from(player);
    expect(rows).toHaveLength(0);
  });
});

describe('appendEvent', () => {
  it('writes a row with the workspace, actor and snapshotted payload', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    const p = await seedPlayer(a, 'p-a');
    const at = new Date('2026-08-04T09:12:00Z');

    await withWorkspace(a, (tx) =>
      appendEvent(tx, {
        workspaceId: a,
        type: 'session_start',
        actorType: 'player',
        actorId: p,
        occurredAt: at,
        payload: { entry_point: 'settings_menu' },
      }),
    );

    const rows = await withWorkspace(a, async (tx) =>
      tx.select().from(event).where(eq(event.type, 'session_start')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorType).toBe('player');
    expect(rows[0]?.actorId).toBe(p);
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-08-04T09:12:00.000Z');
    expect(rows[0]?.payload).toEqual({ entry_point: 'settings_menu' });
  });

  it('defaults the payload to an empty object rather than null', async () => {
    const a = await seedWorkspace({ slug: 'game-a' });
    await withWorkspace(a, (tx) =>
      appendEvent(tx, { workspaceId: a, type: 'sdk_incident', actorType: 'system' }),
    );
    const rows = await withWorkspace(a, async (tx) => tx.select().from(event));
    expect(rows[0]?.payload).toEqual({});
  });
});
