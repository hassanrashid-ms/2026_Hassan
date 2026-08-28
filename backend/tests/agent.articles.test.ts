import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { articlesRouter } from '../src/agent/routers/articlesRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import { deleteArticleObject, upsertArticleObject } from '../src/shared/weaviate/articlesIndex.ts';
import { presignPutObject } from '../src/shared/storage/presign.ts';

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  upsertArticleObject: vi.fn().mockResolvedValue(undefined),
  deleteArticleObject: vi.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, articlesRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(async () => {
  await truncateAll();
  vi.mocked(upsertArticleObject).mockClear();
  vi.mocked(deleteArticleObject).mockClear();
});

async function seedAgent(
  workspaceId: string,
  role: 'agent' | 'team_lead' = 'agent',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
    [workspaceId, agentId, role],
  );
  const token = await signAgentSession({ agent_id: agentId });
  return { agentId, token };
}

describe('POST /articles', () => {
  it('creates a draft', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);

    const res = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'How to reset your password', body: 'Go to settings...' })
      .expect(201);

    expect(res.body).toMatchObject({
      title: 'How to reset your password',
      state: 'draft',
      intent_id: null,
    });
  });

  it('404s when intent_id belongs to another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    );
    const { token } = await seedAgent(workspaceA);

    await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ title: 'X', body: 'Y', intent_id: rows[0]!.id })
      .expect(404);
  });

  it('persists keywords on create and update', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y', keywords: ['refund', 'billing'] })
      .expect(201);
    expect(created.body.keywords).toEqual(['refund', 'billing']);

    const patched = await request(app)
      .patch(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ keywords: ['refund'] })
      .expect(200);
    expect(patched.body.keywords).toEqual(['refund']);
  });

  it('defaults keywords to an empty array when omitted', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);
    expect(created.body.keywords).toEqual([]);
  });
});

describe('draft -> publish -> archive', () => {
  it('walks the full state machine', async () => {
    const workspaceId = await seedWorkspace();
    // Publish/archive require Team Lead or Admin; team_lead can also
    // create/edit drafts, so one seeded agent covers the whole walk.
    const { token } = await seedAgent(workspaceId, 'team_lead');

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);
    const id = created.body.id as string;

    const patched = await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Updated title' })
      .expect(200);
    expect(patched.body.title).toBe('Updated title');

    const published = await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(published.body.state).toBe('published');
    expect(published.body.published_by).toBeTruthy();
    expect(published.body.published_at).toBeTruthy();

    await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Should fail' })
      .expect(409);

    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);

    const archived = await request(app)
      .post(`/articles/${id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(archived.body.state).toBe('archived');
  });

  it('refuses to publish empty title or body with 409', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, ' ', ' ', $2) returning id`,
      [workspaceId, agentId],
    );
    const { token } = await seedAgent(workspaceId, 'team_lead');

    await request(app)
      .post(`/articles/${rows[0]!.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
  });

  it('archive succeeds from any state, unlike patch and publish', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, state, created_by, published_at)
       values ($1, 'X', 'Y', 'published', $2, now()) returning id`,
      [workspaceId, agentId],
    );
    const { token } = await seedAgent(workspaceId, 'team_lead');

    await request(app)
      .post(`/articles/${rows[0]!.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });

  it('upserts the Weaviate object on publish and deletes it on archive', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y', keywords: ['k'] })
      .expect(201);
    const id = created.body.id as string;

    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(upsertArticleObject).toHaveBeenCalledWith(
      expect.objectContaining({ id, title: 'X', body: 'Y', keywords: ['k'] }),
    );

    await request(app)
      .post(`/articles/${id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(deleteArticleObject).toHaveBeenCalledWith(id);
  });

  it('does not advance state when the Weaviate publish call fails', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    vi.mocked(upsertArticleObject).mockRejectedValueOnce(new Error('weaviate unreachable'));

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);
    const id = created.body.id as string;

    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(500);

    const { rows } = await ownerPool.query<{ state: string }>(
      `select state from article where id = $1`,
      [id],
    );
    expect(rows[0]!.state).toBe('draft');
  });

  it('403s a plain agent trying to publish — building a draft is theirs, publishing is not', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);

    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('403s a plain agent trying to archive', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);

    await request(app)
      .post(`/articles/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('draft overlay on a published article', () => {
  async function publishedArticle(workspaceId: string, token: string) {
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Original title', body: 'Original body' })
      .expect(201);
    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    return created.body.id as string;
  }

  it('saves a draft on a published article without touching live content', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);

    const res = await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Edited title' })
      .expect(200);

    expect(res.body.draft).toMatchObject({ title: 'Edited title' });
    expect(res.body.title).toBe('Original title');
    expect(res.body.state).toBe('published');
  });

  it('409s saving a draft on an article that is not published', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);

    await request(app)
      .patch(`/articles/${created.body.id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Z' })
      .expect(409);
  });

  it('upserts the same draft row across repeated saves', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);

    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'First edit' })
      .expect(200);
    const second = await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ body: 'Second edit body' })
      .expect(200);

    expect(second.body.draft).toMatchObject({ title: 'First edit', body: 'Second edit body' });
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from article_version where article_id = $1 and status = 'draft'`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('discards a draft, clearing it without touching live content', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);
    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Edited title' })
      .expect(200);

    const res = await request(app)
      .delete(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.draft).toBeNull();
    expect(res.body.title).toBe('Original title');
    const { rows } = await ownerPool.query(
      `select status from article_version where article_id = $1`,
      [id],
    );
    expect(rows[0].status).toBe('discarded');
  });
});

describe('workspace isolation', () => {
  it('GET /articles/:id 404s for another workspace article', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceB);
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 'X', 'Y', $2) returning id`,
      [workspaceB, agentId],
    );
    const { token } = await seedAgent(workspaceA);

    await request(app)
      .get(`/articles/${rows[0]!.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .expect(404);
  });
});

async function uploadFixtureImage(workspaceId: string, agentId: string) {
  const key = `pending/${workspaceId}/${agentId}/${randomUUID()}.png`;
  const body = Buffer.from('fake-png-bytes');
  const { url } = await presignPutObject({
    key,
    contentType: 'image/png',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}

describe('POST /agent/articles/:id/attachments', () => {
  it('claims a pending upload onto a draft article', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(200);

    expect(res.body).toMatchObject({
      filename: 'diagram.png',
      mime_type: 'image/png',
      byte_size: 14,
    });
    expect(res.body.url).toBeTruthy();

    const { rows } = await ownerPool.query(
      `select storage_key from article_attachment where article_id = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_key).toContain(`ws/${workspaceId}/attachments/`);
  });

  it('409s when the article is not a draft', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(409);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('422s with attachment_not_found for a bogus key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({
        key: `pending/${workspaceId}/nobody/${randomUUID()}.png`,
        filename: 'ghost.png',
        mime_type: 'image/png',
        byte_size: 14,
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it('422s with attachment_mismatch when declared byte_size disagrees with the real object', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 999999 })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_mismatch');
  });
});

describe('GET /agent/articles/:id with an attachment', () => {
  it('returns a fetchable presigned url for a finalized attachment', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    const key = await uploadFixtureImage(workspaceId, agentId);
    await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(200);

    const res = await request(app)
      .get(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].url).toBeTruthy();
    const getRes = await fetch(res.body.attachments[0].url);
    expect(getRes.status).toBe(200);
  });
});

describe('POST /agent/articles/:id/publish with empty fields', () => {
  it('409s when body is empty', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Refund policy', body: '' })
      .expect(201);

    const res = await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
    expect(res.body.error.message).toMatch(/non-empty/i);
  });

  it('allows creating and updating a draft with an empty body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: '', body: '' })
      .expect(201);
    expect(created.body.title).toBe('');

    await request(app)
      .patch(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Now has a title' })
      .expect(200);
  });
});
