import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { tagsRouter } from '../src/agent/routers/tagsRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

// Standalone app carrying just this router, gated by the real
// requireAgentSession middleware — mirrors agent.taxonomy.test.ts's rationale.
const app = express();
app.use(express.json());
app.use(requireAgentSession, tagsRouter);
app.use(errorMiddleware);

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentSession(workspaceId: string): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { agentId, token };
}

describe('POST /tags', () => {
  it('creates a fresh tag with 201', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    const res = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    expect(res.body).toEqual({
      id: expect.any(String),
      name: 'VIP',
      colorIndex: expect.any(Number),
    });
  });

  it('returns the existing active tag as-is for an exact duplicate (200, no-op)', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    const first = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);
    const second = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(200);

    expect(second.body).toEqual(first.body);
  });

  it('normalizes case and whitespace to reuse the same tag', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    const first = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);
    const second = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  vip  ' })
      .expect(200);

    expect(second.body.id).toBe(first.body.id);
  });

  it('un-archives a matching archived tag instead of creating a duplicate', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);
    await request(app)
      .post(`/tags/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const revived = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(200);

    expect(revived.body.id).toBe(created.body.id);

    const { rows } = await ownerPool.query<{ archived_at: string | null }>(
      `select archived_at from tag where id = $1`,
      [created.body.id],
    );
    expect(rows[0]!.archived_at).toBeNull();
  });
});

describe('GET /tags', () => {
  it('lists only active tags, alphabetically', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Zebra' })
      .expect(201);
    const archived = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Archived' })
      .expect(201);
    await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Alpha' })
      .expect(201);
    await request(app)
      .post(`/tags/${archived.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app).get('/tags').set('Authorization', `Bearer ${token}`).expect(200);

    expect(res.body.map((t: { name: string }) => t.name)).toEqual(['Alpha', 'Zebra']);
  });

  it('filters by normalizedName prefix', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP Whale' })
      .expect(201);
    await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refund' })
      .expect(201);

    const res = await request(app)
      .get('/tags?query=vip')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('VIP Whale');
  });
});

describe('PATCH /tags/:id', () => {
  it('renames a tag', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    const res = await request(app)
      .patch(`/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Whale' })
      .expect(200);

    expect(res.body).toEqual({
      id: created.body.id,
      name: 'Whale',
      colorIndex: created.body.colorIndex,
    });
  });

  it('409s on a name collision with another active tag', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Whale' })
      .expect(201);
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    await request(app)
      .patch(`/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Whale' })
      .expect(409);
  });

  it('404s for an unknown tag id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);

    await request(app)
      .patch(`/tags/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Whale' })
      .expect(404);
  });
});

describe('POST /tags/:id/archive', () => {
  it('archives a tag while leaving existing conversation_tag rows intact and visible', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    await request(app)
      .post(`/conversations/${conversationId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tagId: created.body.id })
      .expect(200);

    await request(app)
      .post(`/tags/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { rows } = await ownerPool.query<{ removed_at: string | null }>(
      `select removed_at from conversation_tag where conversation_id = $1 and tag_id = $2`,
      [conversationId, created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.removed_at).toBeNull();
  });
});

describe('POST /conversations/:id/tags', () => {
  it('attaches a tag, idempotently', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    await request(app)
      .post(`/conversations/${conversationId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tagId: created.body.id })
      .expect(200);
    await request(app)
      .post(`/conversations/${conversationId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tagId: created.body.id })
      .expect(200);

    const { rows } = await ownerPool.query<{ count: string }>(
      `select count(*) from conversation_tag where conversation_id = $1 and tag_id = $2`,
      [conversationId, created.body.id],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('404s for a tag id from another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceA);
    const { token: tokenB } = await seedAgentSession(workspaceB);
    const playerId = await seedPlayer(workspaceA);
    const conversationId = await seedConversation({ workspaceId: workspaceA, playerId });
    const otherWorkspaceTag = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'VIP' })
      .expect(201);

    await request(app)
      .post(`/conversations/${conversationId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tagId: otherWorkspaceTag.body.id })
      .expect(404);
  });
});

describe('DELETE /conversations/:id/tags/:tagId', () => {
  it('detaches an attached tag, idempotently (no-op if already detached)', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);
    await request(app)
      .post(`/conversations/${conversationId}/tags`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tagId: created.body.id })
      .expect(200);

    await request(app)
      .delete(`/conversations/${conversationId}/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const { rows } = await ownerPool.query<{ removed_at: string | null }>(
      `select removed_at from conversation_tag where conversation_id = $1 and tag_id = $2`,
      [conversationId, created.body.id],
    );
    expect(rows[0]!.removed_at).not.toBeNull();

    // No-op second detach.
    await request(app)
      .delete(`/conversations/${conversationId}/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('no-ops (200) detaching a tag that was never attached', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentSession(workspaceId);
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const created = await request(app)
      .post('/tags')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'VIP' })
      .expect(201);

    await request(app)
      .delete(`/conversations/${conversationId}/tags/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
