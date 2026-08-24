import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { getOrCreateSystemActor, SYSTEM_ACTOR_EMAIL } from '../src/domain/bot/systemActor.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

describe('getOrCreateSystemActor', () => {
  let workspaceId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
  });

  it('creates the system agent row on first call', async () => {
    const id = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx));
    const { rows } = await ownerPool.query(`select email, display_name from agent where id = $1`, [
      id,
    ]);
    expect(rows[0]).toEqual({ email: SYSTEM_ACTOR_EMAIL, display_name: 'System' });
  });

  it('returns the same id on a second call rather than inserting twice', async () => {
    const first = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx));
    const second = await withWorkspace(workspaceId, (tx) => getOrCreateSystemActor(tx));
    expect(second).toBe(first);
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from agent where email = $1`,
      [SYSTEM_ACTOR_EMAIL],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});
