import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { uploadsRouter } from '../src/agent/routers/uploadsRouter.ts';
import { headObject } from '../src/shared/storage/presign.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, uploadsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentToken(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return {
    agentId,
    token: await signAgentSession({ agent_id: agentId }),
  };
}

describe('POST /agent/uploads', () => {
  it('returns a presigned PUT url for an allowed image type', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ filename: 'screenshot.png', content_type: 'image/png', byte_size: 1024 })
      .expect(200);

    expect(res.body.key).toContain(`pending/${workspaceId}/${agentId}/`);
    expect(res.body.upload_url).toContain('http');
    expect(res.body.expires_at).toBeTruthy();
  });

  it('422s for a disallowed content type', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ filename: 'doc.pdf', content_type: 'application/pdf', byte_size: 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });

  it('422s for a byte_size over the cap', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ filename: 'big.png', content_type: 'image/png', byte_size: 11 * 1024 * 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /agent/uploads/:key', () => {
  it('deletes an object the caller owns', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentToken(workspaceId);
    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(key)}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(204);
    expect(await headObject(key)).toBeNull();
  });

  it("404s for a key under a different agent's path", async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);
    const otherKey = `pending/${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(otherKey)}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });
});
