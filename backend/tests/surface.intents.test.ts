import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts';
import { intentsRouter } from '../src/surface/routers/intentsRouter.ts';
import { closeOwnerPool, ownerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts';
import { mintToken } from './helpers/app.ts';

const app = express();
app.use(express.json());
app.use(requirePlayerToken, intentsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function fixture() {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p-1',
  });
  return { workspaceId, playerId, token };
}

async function seedIntent(
  workspaceId: string,
  overrides: Partial<{ name: string; isSystem: boolean; archivedAt: Date | null }> = {},
) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into intent (workspace_id, name, is_system, archived_at) values ($1, $2, $3, $4) returning id`,
    [
      workspaceId,
      overrides.name ?? 'Billing',
      overrides.isSystem ?? false,
      overrides.archivedAt ?? null,
    ],
  );
  return rows[0]!.id;
}

async function seedArticle(
  workspaceId: string,
  intentId: string | null,
  overrides: Partial<{ title: string; state: string }> = {},
) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'A') returning id`,
    [`a-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into article (workspace_id, intent_id, title, body, state, created_by, published_at)
     values ($1, $2, $3, 'Body text.', $4::article_state, $5, case when $4::text = 'published' then now() else null end)`,
    [workspaceId, intentId, overrides.title ?? 'Article', overrides.state ?? 'published', agentId],
  );
}

describe('GET /intents', () => {
  it('returns an intent with at least one published article', async () => {
    const { workspaceId, token } = await fixture();
    const intentId = await seedIntent(workspaceId, { name: 'Billing' });
    await seedArticle(workspaceId, intentId, { state: 'published' });

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([{ id: intentId, name: 'Billing' }]);
  });

  it('excludes an intent whose only articles are draft or archived', async () => {
    const { workspaceId, token } = await fixture();
    const intentId = await seedIntent(workspaceId, { name: 'Billing' });
    await seedArticle(workspaceId, intentId, { state: 'draft' });
    await seedArticle(workspaceId, intentId, { state: 'archived' });

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([]);
  });

  it('excludes an archived intent even if it has a published article', async () => {
    const { workspaceId, token } = await fixture();
    const intentId = await seedIntent(workspaceId, {
      name: 'Old Category',
      archivedAt: new Date(),
    });
    await seedArticle(workspaceId, intentId, { state: 'published' });

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([]);
  });

  it('includes an isSystem intent when it qualifies', async () => {
    const { workspaceId, token } = await fixture();
    const intentId = await seedIntent(workspaceId, { name: 'Other', isSystem: true });
    await seedArticle(workspaceId, intentId, { state: 'published' });

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([{ id: intentId, name: 'Other' }]);
  });

  it('sorts results alphabetically by name', async () => {
    const { workspaceId, token } = await fixture();
    const zId = await seedIntent(workspaceId, { name: 'Zebra Issues' });
    const aId = await seedIntent(workspaceId, { name: 'Account Access' });
    await seedArticle(workspaceId, zId, { state: 'published' });
    await seedArticle(workspaceId, aId, { state: 'published' });

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents.map((i: { id: string }) => i.id)).toEqual([aId, zId]);
  });

  it('returns an empty list, never an error, when no intent qualifies', async () => {
    const { token } = await fixture();

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([]);
  });

  it('does not return another workspace intent — invisible under RLS', async () => {
    const other = await seedWorkspace();
    const otherIntentId = await seedIntent(other, { name: 'Other Workspace Category' });
    await seedArticle(other, otherIntentId, { state: 'published' });
    const { token } = await fixture();

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.intents).toEqual([]);
  });
});
