import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../src/shared/db/client.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { getChangeLogEntryById } from '../src/shared/changeLog/readChangeLog.ts';
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts';
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

describe('getChangeLogEntryById', () => {
  let workspaceId: string;
  let actorId: string;

  beforeEach(async () => {
    await truncateAll();
    workspaceId = await seedWorkspace();
    actorId = await seedAgent();
  });

  it('returns the row scoped to workspace, entity type and entity id', async () => {
    let id = '';
    await withWorkspace(workspaceId, async (tx) => {
      await appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'prompt', before: null, after: 'x' }],
      });
    });
    const { rows } = await ownerPool.query(`select id from change_log where workspace_id = $1`, [
      workspaceId,
    ]);
    id = String(rows[0]!.id);

    const entry = await withWorkspace(workspaceId, (tx) =>
      getChangeLogEntryById(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        id,
      }),
    );
    expect(entry).toMatchObject({ id, field: 'prompt', beforeValue: null, afterValue: 'x' });
  });

  it('returns null for an id that does not exist', async () => {
    const entry = await withWorkspace(workspaceId, (tx) =>
      getChangeLogEntryById(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        id: '999999',
      }),
    );
    expect(entry).toBeNull();
  });

  it('returns null for a non-numeric id rather than throwing', async () => {
    const entry = await withWorkspace(workspaceId, (tx) =>
      getChangeLogEntryById(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        id: 'not-a-number',
      }),
    );
    expect(entry).toBeNull();
  });

  it('returns null for a real id belonging to another workspace — indistinguishable from unknown', async () => {
    const otherWorkspaceId = await seedWorkspace();
    const otherActorId = await seedAgent();
    await withWorkspace(otherWorkspaceId, async (tx) => {
      await appendChangeLog(tx, {
        workspaceId: otherWorkspaceId,
        entityType: 'bot_config',
        entityId: otherWorkspaceId,
        actorId: otherActorId,
        changes: [{ field: 'prompt', before: null, after: 'y' }],
      });
    });
    const { rows } = await ownerPool.query(`select id from change_log where workspace_id = $1`, [
      otherWorkspaceId,
    ]);
    const otherId = String(rows[0]!.id);

    const entry = await withWorkspace(workspaceId, (tx) =>
      getChangeLogEntryById(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        id: otherId,
      }),
    );
    expect(entry).toBeNull();
  });
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});
