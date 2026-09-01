import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { presignPutObject, headObject } from '../src/shared/storage/presign.ts';
import { bulkImportArticles } from '../src/agent/services/articlesService.ts';

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

async function uploadFixtureZip(
  workspaceId: string,
  agentId: string,
  files: Record<string, string>,
): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const body = await zip.generateAsync({ type: 'nodebuffer' });
  const key = `pending/${workspaceId}/${agentId}/${randomUUID()}.zip`;
  const { url } = await presignPutObject({
    key,
    contentType: 'application/zip',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}

describe('bulkImportArticles', () => {
  it('creates one draft article per .md entry, skipping non-md entries', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, {
      'a.md': '---\ntitle: Article A\n---\nBody A.',
      'b.markdown': '# Article B\n\nBody B.',
      'notes/readme.txt': 'ignore me',
      '.DS_Store': 'ignore me too',
    });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary).toEqual({ total: 2, created: 2, failed: 0 });
    const titles = result.results.filter((r) => r.status === 'created').map((r) => r.title);
    expect(titles.sort()).toEqual(['Article A', 'Article B']);

    const { rows } = await ownerPool.query(`select state from article where workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { state: string }) => r.state === 'draft')).toBe(true);
  });

  it('reports a per-file error for an empty markdown entry without blocking the rest', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, {
      'good.md': '# Good\n\nContent.',
      'empty.md': '   ',
    });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary).toEqual({ total: 2, created: 1, failed: 1 });
    const failed = result.results.find((r) => r.status === 'error');
    expect(failed?.filename).toBe('empty.md');
  });

  it('rejects a zip with no markdown entries', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, { 'readme.txt': 'no md here' });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result).toEqual({ ok: false, reason: 'no_markdown_files' });
  });

  it('rejects a batch over the file-count cap without creating anything', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) {
      files[`file-${i}.md`] = `# File ${i}\n\nBody.`;
    }
    const key = await uploadFixtureZip(workspaceId, agentId, files);

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result).toEqual({ ok: false, reason: 'too_many_files' });
    const { rows } = await ownerPool.query(`select count(*)::int from article where workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows[0].count).toBe(0);
  });

  it('rejects a key not owned by this agent', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const result = await bulkImportArticles(
      { agentId, workspaceId, isAdmin: false },
      `pending/${workspaceId}/someone-else/${randomUUID()}.zip`,
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('deletes the pending zip object after processing', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, { 'a.md': '# A\n\nBody.' });

    await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    const meta = await headObject(key);
    expect(meta).toBeNull();
  });
});
