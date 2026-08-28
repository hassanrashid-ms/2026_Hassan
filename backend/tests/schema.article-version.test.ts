import { afterAll, describe, expect, it } from 'vitest';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeOwnerPool();
});

async function seedAgentRow(): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return rows[0]!.id;
}

async function seedArticleRow(workspaceId: string, agentId: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, title, body, created_by) values ($1, 'X', 'Y', $2) returning id`,
    [workspaceId, agentId],
  );
  return rows[0]!.id;
}

describe('article_version constraints', () => {
  it('rejects a second draft row for the same article', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'A', 'B', $2)`,
      [articleId, agentId],
    );
    await expect(
      ownerPool.query(
        `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'C', 'D', $2)`,
        [articleId, agentId],
      ),
    ).rejects.toThrow();
  });

  it('rejects updating a published row', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, version, title, body, actor_id, changed_fields) values ($1, 'published', 1, 'A', 'B', $2, ARRAY['title'])`,
      [articleId, agentId],
    );
    await expect(
      ownerPool.query(`update article_version set title = 'Z' where article_id = $1`, [articleId]),
    ).rejects.toThrow(/append-only/);
  });

  it('allows updating a draft row', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'A', 'B', $2)`,
      [articleId, agentId],
    );
    await ownerPool.query(`update article_version set title = 'Z' where article_id = $1`, [
      articleId,
    ]);
    const { rows } = await ownerPool.query(`select title from article_version where article_id = $1`, [
      articleId,
    ]);
    expect(rows[0].title).toBe('Z');
  });
});
