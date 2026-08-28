import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

beforeEach(truncateAll);

describe('article_attachment table', () => {
  it('rejects a row with no matching article', async () => {
    const workspaceId = await seedWorkspace();
    await expect(
      ownerPool.query(
        `insert into article_attachment
           (workspace_id, article_id, storage_key, filename, mime_type, byte_size)
         values ($1, $2, 'ws/x/attachments/y.png', 'shot.png', 'image/png', 10)`,
        [workspaceId, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('rejects a row with a null storage_key', async () => {
    const workspaceId = await seedWorkspace();
    const { rows: agentRows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a@example.test', 'A') returning id`,
    );
    const { rows: articleRows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 't', 'b', $2) returning id`,
      [workspaceId, agentRows[0]!.id],
    );
    await expect(
      ownerPool.query(
        `insert into article_attachment
           (workspace_id, article_id, filename, mime_type, byte_size)
         values ($1, $2, 'shot.png', 'image/png', 10)`,
        [workspaceId, articleRows[0]!.id],
      ),
    ).rejects.toThrow();
  });
});
