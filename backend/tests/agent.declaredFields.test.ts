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
import { declaredFieldRouter } from '../src/agent/routers/declaredFieldRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, resolveConsoleWorkspace, declaredFieldRouter);
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
  role: 'agent' | 'team_lead' | 'admin',
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

async function promote(
  app_: express.Express,
  token: string,
  workspaceId: string,
  overrides: Partial<{ key: string; label: string; type: string }> = {},
) {
  const res = await request(app_)
    .post('/declared-fields')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ key: 'vip_status', label: 'VIP status', type: 'string', ...overrides })
    .expect(201);
  return res.body as { id: string; key: string; status: string };
}

describe('GET /declared-fields', () => {
  it('returns active and inactive fields, but never archived, ordered by key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const active = await promote(app, token, workspaceId, { key: 'ab_bucket', label: 'AB bucket' });
    const inactive = await promote(app, token, workspaceId, { key: 'vip_status' });
    const archived = await promote(app, token, workspaceId, { key: 'zz_key', label: 'ZZ' });

    await request(app)
      .post(`/declared-fields/${inactive.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    await request(app)
      .post(`/declared-fields/${archived.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.fields.map((f: { key: string; status: string }) => [f.key, f.status])).toEqual([
      ['ab_bucket', 'active'],
      ['vip_status', 'inactive'],
    ]);
    expect(active.key).toBe('ab_bucket');
  });

  it('forbids a team lead', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });

  it('forbids a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('POST /declared-fields', () => {
  it('promotes a new key as active', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(201);

    expect(res.body).toMatchObject({
      key: 'vip_status',
      label: 'VIP status',
      type: 'string',
      status: 'active',
      declaredBy: agentId,
    });
  });

  it('rejects an invalid key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'VIP Status!', label: 'VIP status', type: 'string' })
      .expect(422);
  });

  it('409s on a duplicate active key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await promote(app, token, workspaceId);

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'Different label', type: 'string' })
      .expect(409);
  });

  it('revives an inactive key instead of erroring', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const first = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${first.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const revived = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status v2', type: 'number' })
      .expect(201);

    expect(revived.body).toMatchObject({
      id: first.id,
      label: 'VIP status v2',
      type: 'number',
      status: 'active',
    });
  });

  it('revives an archived key instead of erroring', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const first = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${first.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const revived = await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status v2', type: 'number' })
      .expect(201);

    expect(revived.body).toMatchObject({ id: first.id, status: 'active' });

    const list = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.fields.map((f: { key: string }) => f.key)).toEqual(['vip_status']);
  });

  it('forbids a team lead from promoting', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key: 'vip_status', label: 'VIP status', type: 'string' })
      .expect(403);
  });
});

describe('PATCH /declared-fields/:id', () => {
  it('updates label and type, ignoring any key in the body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await promote(app, token, workspaceId);

    const res = await request(app)
      .patch(`/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier', type: 'number', key: 'ignored_key' })
      .expect(200);

    expect(res.body).toMatchObject({ key: 'vip_status', label: 'VIP tier', type: 'number' });
  });

  it('404s on an archived field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .patch(`/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(404);
  });

  it('writes a change_log row per changed field', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentWithRole(workspaceId, 'admin');

    const created = await promote(app, token, workspaceId);

    await request(app)
      .patch(`/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(200);

    const { rows } = await ownerPool.query<{ field: string; actor_id: string }>(
      `select field, actor_id from change_log
        where entity_type = 'declared_field' and entity_id = $1 order by field`,
      [created.id],
    );
    expect(rows).toEqual([{ field: 'label', actor_id: agentId }]);
  });

  it('404s on an unknown id', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .patch('/declared-fields/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(404);
  });

  it('forbids a team lead from editing', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const { token: leadToken } = await seedAgentWithRole(workspaceId, 'team_lead');

    const created = await promote(app, adminToken, workspaceId);

    await request(app)
      .patch(`/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${leadToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ label: 'VIP tier' })
      .expect(403);
  });
});

describe('POST /declared-fields/:id/deactivate', () => {
  it('moves an active field to inactive and keeps it in the list', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);

    const res = await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'inactive' });

    const list = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.fields).toHaveLength(1);
  });

  it('404s deactivating an already-inactive field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('forbids a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');
    const created = await promote(app, adminToken, workspaceId);

    await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});

describe('POST /declared-fields/:id/reactivate', () => {
  it('moves an inactive field back to active', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .post(`/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'active' });
  });

  it('404s reactivating an active (never-deactivated) field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);

    await request(app)
      .post(`/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('404s reactivating an archived field — re-promoting is the only way back', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .post(`/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });
});

describe('POST /declared-fields/:id/archive', () => {
  it('archives the field and excludes it from later listings', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);

    await request(app)
      .post(`/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const list = await request(app)
      .get('/declared-fields')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(list.body.fields).toEqual([]);
  });

  it('works from inactive too', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');
    const created = await promote(app, token, workspaceId);
    await request(app)
      .post(`/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .post(`/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
  });

  it('forbids a plain agent from archiving', async () => {
    const workspaceId = await seedWorkspace();
    const { token: adminToken } = await seedAgentWithRole(workspaceId, 'admin');
    const { token: agentToken } = await seedAgentWithRole(workspaceId, 'agent');
    const created = await promote(app, adminToken, workspaceId);

    await request(app)
      .post(`/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(403);
  });
});
