import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { taxonomyRouter } from '../src/agent/routers/taxonomyRouter.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedArticle,
  seedConversation,
  seedIntent,
  seedPlayer,
  seedSubintent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';

// Standalone app carrying just this router, gated by the real
// requireAgentSession/requireAdminRole middleware — mirrors
// agent.conversations.test.ts's rationale: this keeps the test from racing
// Task 3's edits to backend/src/surface/router.ts, and from needing
// backend/src/agent/router.ts wired before this task's own Step 8 does it.
const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, taxonomyRouter);
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

beforeEach(truncateAll);

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'admin',
): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name, is_admin) values ($1, 'Test Agent', $2) returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`, role === 'admin'],
  );
  const agentId = rows[0]!.id;
  if (role !== 'admin') {
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`,
      [workspaceId, agentId, role],
    );
  }
  const token = await signAgentSession({ agent_id: agentId, is_admin: role === 'admin' });
  return { agentId, token };
}

describe('GET /intents', () => {
  it('lists intents with nested subintents for any role', async () => {
    const workspaceId = await seedWorkspace();
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    );
    await ownerPool.query(
      `insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Refunds')`,
      [workspaceId, rows[0]!.id],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    const res = await request(app)
      .get('/intents')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.intents).toHaveLength(1);
    expect(res.body.intents[0]).toEqual({
      id: rows[0]!.id,
      name: 'Billing',
      isSystem: false,
      archivedAt: null,
      subintents: [
        {
          id: expect.any(String),
          name: 'Refunds',
          formId: null,
          archivedAt: null,
          defaultPriority: null,
          mergedIntoId: null,
        },
      ],
    });
  });
});

describe('POST /intents', () => {
  it('creates an intent for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/intents')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Billing' })
      .expect(201);

    expect(res.body).toEqual({ id: expect.any(String), name: 'Billing' });
  });

  it('refuses a non-admin agent with 403, not 404', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .post('/intents')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Billing' })
      .expect(403);
  });
});

describe('POST /intents/:id/subintents', () => {
  it('creates a subintent for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    );
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Refunds' })
      .expect(201);

    expect(res.body).toEqual({ id: expect.any(String), name: 'Refunds', intent_id: rows[0]!.id });
  });

  it('404s for an intent id from another workspace — invisible under RLS', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    );
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ name: 'Refunds' })
      .expect(404);
  });
});

describe('PATCH /intents/:id', () => {
  it('renames an intent for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Payments' })
      .expect(200);

    expect(res.body).toEqual({ id: intentId, name: 'Payments' });
  });

  it('409s on a name collision with another intent in the workspace', async () => {
    const workspaceId = await seedWorkspace();
    await seedIntent(workspaceId, 'Payments');
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Payments' })
      .expect(409);
  });

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .patch(`/intents/${intentId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Payments' })
      .expect(403);
  });

  it('404s for an unknown intent id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/intents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Payments' })
      .expect(404);
  });
});

describe('POST /intents/:id/archive', () => {
  it('archives an intent with no active subintents or published articles', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body).toEqual({ id: intentId, name: 'Billing', archivedAt: expect.any(String) });
  });

  it('409s for the isSystem intent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Other', true);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
  });

  it('409s while a non-archived subintent still points at it', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
  });

  it('409s while a published article still points at it', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');
    const articleId = await seedArticle({
      workspaceId,
      createdBy: agentId,
      title: 'Refund policy',
    });
    await ownerPool.query(`update article set intent_id = $1, state = 'published' where id = $2`, [
      intentId,
      articleId,
    ]);

    await request(app)
      .post(`/intents/${intentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
  });
});

describe('PATCH /subintents/:id', () => {
  it('renames a subintent and sets its default priority', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .patch(`/subintents/${subintentId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Refund Requests', defaultPriority: 'p2' })
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refund Requests', defaultPriority: 'p2' });
  });

  it('409s on a name collision within the same intent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Invoices' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/subintents/${subintentId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Refunds' })
      .expect(409);
  });

  it('404s for an unknown subintent id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch(`/subintents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ name: 'Refunds' })
      .expect(404);
  });
});

describe('POST /subintents/:id/archive', () => {
  it('archives a subintent', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    await seedSubintent({ workspaceId, intentId: otherIntentId, name: 'Other' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${subintentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refunds', archivedAt: expect.any(String) });
  });

  it("409s for the workspace's Other subintent", async () => {
    const workspaceId = await seedWorkspace();
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    const otherSubintentId = await seedSubintent({
      workspaceId,
      intentId: otherIntentId,
      name: 'Other',
    });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${otherSubintentId}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(409);
  });
});

describe('POST /subintents/:id/move', () => {
  it('moves a subintent to a new intent', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const accountId = await seedIntent(workspaceId, 'Account Access');
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    await seedSubintent({ workspaceId, intentId: otherIntentId, name: 'Other' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intentId: accountId })
      .expect(200);

    expect(res.body).toEqual({ id: subintentId, name: 'Refunds', intentId: accountId });
  });

  it('404s when the target intent is archived', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const archivedIntentId = await seedIntent(workspaceId, 'Old Category');
    await ownerPool.query(`update intent set archived_at = now() where id = $1`, [
      archivedIntentId,
    ]);
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    await seedSubintent({ workspaceId, intentId: otherIntentId, name: 'Other' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intentId: archivedIntentId })
      .expect(404);
  });

  it('404s when the target intent does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId: billingId, name: 'Refunds' });
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    await seedSubintent({ workspaceId, intentId: otherIntentId, name: 'Other' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intentId: randomUUID() })
      .expect(404);
  });

  it("409s for the workspace's Other subintent", async () => {
    const workspaceId = await seedWorkspace();
    const billingId = await seedIntent(workspaceId, 'Billing');
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    const otherSubintentId = await seedSubintent({
      workspaceId,
      intentId: otherIntentId,
      name: 'Other',
    });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${otherSubintentId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intentId: billingId })
      .expect(409);
  });
});

describe('POST /subintents/:id/merge', () => {
  it('reassigns conversations to the survivor and archives the loser with mergedIntoId set', async () => {
    const workspaceId = await seedWorkspace();
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    await seedSubintent({ workspaceId, intentId: otherIntentId, name: 'Other' });
    const intentId = await seedIntent(workspaceId, 'Billing');
    const loserId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const survivorId = await seedSubintent({ workspaceId, intentId, name: 'Refund Requests' });
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set subintent_id = $1 where id = $2`, [
      loserId,
      conversationId,
    ]);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intoId: survivorId })
      .expect(200);

    expect(res.body).toEqual({
      id: loserId,
      name: 'Refunds',
      archivedAt: expect.any(String),
      mergedIntoId: survivorId,
    });

    const { rows } = await ownerPool.query<{ subintent_id: string }>(
      `select subintent_id from conversation where id = $1`,
      [conversationId],
    );
    expect(rows[0]!.subintent_id).toBe(survivorId);
  });

  it('409s when the target is archived', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const loserId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const survivorId = await seedSubintent({ workspaceId, intentId, name: 'Refund Requests' });
    await ownerPool.query(`update subintent set archived_at = now() where id = $1`, [survivorId]);
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intoId: survivorId })
      .expect(409);
  });

  it('409s when the target is the loser itself', async () => {
    const workspaceId = await seedWorkspace();
    const intentId = await seedIntent(workspaceId, 'Billing');
    const subintentId = await seedSubintent({ workspaceId, intentId, name: 'Refunds' });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${subintentId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intoId: subintentId })
      .expect(409);
  });

  it('409s when the target belongs to a different workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const intentA = await seedIntent(workspaceA, 'Billing');
    const intentB = await seedIntent(workspaceB, 'Billing');
    const loserId = await seedSubintent({
      workspaceId: workspaceA,
      intentId: intentA,
      name: 'Refunds',
    });
    const otherWorkspaceSubintentId = await seedSubintent({
      workspaceId: workspaceB,
      intentId: intentB,
      name: 'Refunds',
    });
    const { token } = await seedAgentWithRole(workspaceA, 'admin');

    await request(app)
      .post(`/subintents/${loserId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceA)
      .send({ intoId: otherWorkspaceSubintentId })
      .expect(409);
  });

  it("409s when the loser is the workspace's Other subintent", async () => {
    const workspaceId = await seedWorkspace();
    const otherIntentId = await seedIntent(workspaceId, 'Other', true);
    const otherSubintentId = await seedSubintent({
      workspaceId,
      intentId: otherIntentId,
      name: 'Other',
    });
    const billingIntentId = await seedIntent(workspaceId, 'Billing');
    const survivorId = await seedSubintent({
      workspaceId,
      intentId: billingIntentId,
      name: 'Refunds',
    });
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post(`/subintents/${otherSubintentId}/merge`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ intoId: survivorId })
      .expect(409);
  });
});
