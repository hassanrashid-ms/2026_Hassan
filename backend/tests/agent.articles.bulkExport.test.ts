import { createServer } from 'node:http';
import express from 'express';
import JSZip from 'jszip';
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
import { bulkExportArticles, createArticle } from '../src/agent/services/articlesService.ts';

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

async function unzipFilenames(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).sort();
}

describe('bulkExportArticles', () => {
  it('exports the given article ids as one .md file each, with frontmatter', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const ctx = { agentId, workspaceId, isAdmin: false };
    const a = await createArticle(ctx, { title: 'Refund Policy', body: 'Body A.', keywords: ['refund'] });
    const b = await createArticle(ctx, { title: 'Getting Started', body: 'Body B.', keywords: [] });
    if (!a.ok || !b.ok) throw new Error('seed failed');

    const result = await bulkExportArticles(ctx, [a.article.id, b.article.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const filenames = await unzipFilenames(result.zip);
    expect(filenames).toEqual(['getting-started.md', 'refund-policy.md']);

    const zip = await JSZip.loadAsync(result.zip);
    const content = await zip.file('refund-policy.md')!.async('string');
    expect(content).toContain('title: "Refund Policy"');
    expect(content).toContain('tags: ["refund"]');
    expect(content).toContain('state: draft');
    expect(content).toContain('Body A.');
  });

  it('dedupes filenames for articles with the same title', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const ctx = { agentId, workspaceId, isAdmin: false };
    const a = await createArticle(ctx, { title: 'Same Title', body: 'A.', keywords: [] });
    const b = await createArticle(ctx, { title: 'Same Title', body: 'B.', keywords: [] });
    if (!a.ok || !b.ok) throw new Error('seed failed');

    const result = await bulkExportArticles(ctx, [a.article.id, b.article.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const filenames = await unzipFilenames(result.zip);
    expect(filenames).toEqual(['same-title-2.md', 'same-title.md']);
  });

  it('silently drops ids not found in this workspace', async () => {
    const workspaceId = await seedWorkspace();
    const otherWorkspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const { agentId: otherAgentId } = await seedAgent(otherWorkspaceId);
    const ctx = { agentId, workspaceId, isAdmin: false };
    const otherCtx = { agentId: otherAgentId, workspaceId: otherWorkspaceId, isAdmin: false };
    const mine = await createArticle(ctx, { title: 'Mine', body: 'A.', keywords: [] });
    const theirs = await createArticle(otherCtx, { title: 'Theirs', body: 'B.', keywords: [] });
    if (!mine.ok || !theirs.ok) throw new Error('seed failed');

    const result = await bulkExportArticles(ctx, [mine.article.id, theirs.article.id]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const filenames = await unzipFilenames(result.zip);
    expect(filenames).toEqual(['mine.md']);
  });

  it('rejects when none of the given ids resolve to a row in this workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const result = await bulkExportArticles(
      { agentId, workspaceId, isAdmin: false },
      ['00000000-0000-0000-0000-000000000000'],
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('POST /agent/articles/bulk-export', () => {
  it('exports over HTTP as a team lead, with zip content headers', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const created = await createArticle(
      { agentId, workspaceId, isAdmin: false },
      { title: 'Export Me', body: 'Body.', keywords: [] },
    );
    if (!created.ok) throw new Error('seed failed');

    const res = await request(app)
      .post('/articles/bulk-export')
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ ids: [created.article.id] })
      .expect(200);

    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('attachment');
    const filenames = await unzipFilenames(res.body as Buffer);
    expect(filenames).toEqual(['export-me.md']);
  });

  it('403s for a plain agent (not team lead or admin)', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'agent');
    const created = await createArticle(
      { agentId, workspaceId, isAdmin: false },
      { title: 'X', body: 'Body.', keywords: [] },
    );
    if (!created.ok) throw new Error('seed failed');

    await request(app)
      .post('/articles/bulk-export')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ ids: [created.article.id] })
      .expect(403);
  });

  it('404s when no given id resolves', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');

    await request(app)
      .post('/articles/bulk-export')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ ids: ['00000000-0000-0000-0000-000000000000'] })
      .expect(404);
  });

  it('422s when ids is missing or empty', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');

    await request(app)
      .post('/articles/bulk-export')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ ids: [] })
      .expect(422);
  });
});
