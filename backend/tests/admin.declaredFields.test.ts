import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function adminToken(): Promise<{ agentId: string; token: string }> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  const token = await signAgentSession({ agent_id: agentId, is_admin: true });
  return { agentId, token };
}

async function promote(
  workspaceId: string,
  token: string,
  overrides: Partial<{ key: string; label: string; type: string }> = {},
) {
  const res = await request(app)
    .post(`/admin/workspaces/${workspaceId}/declared-fields`)
    .set('Authorization', `Bearer ${token}`)
    .send({ key: 'vip_status', label: 'VIP status', type: 'string', ...overrides })
    .expect(201);
  return res.body as { id: string; key: string; status: string };
}

describe('GET /admin/workspaces/:id/declared-fields', () => {
  it('returns active and inactive fields, but never archived, ordered by key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const active = await promote(workspaceId, token, { key: 'ab_bucket', label: 'AB bucket' });
    const inactive = await promote(workspaceId, token, { key: 'vip_status' });
    const archived = await promote(workspaceId, token, { key: 'zz_key', label: 'ZZ' });

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${inactive.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${archived.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.fields.map((f: { key: string; status: string }) => [f.key, f.status])).toEqual([
      ['ab_bucket', 'active'],
      ['vip_status', 'inactive'],
    ]);
    expect(active.key).toBe('ab_bucket');
  });

  it('only returns fields for the requested workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const { token } = await adminToken();

    await promote(workspaceA, token, { key: 'a_only' });

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceB}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.fields).toEqual([]);
  });

  it('forbids a non-admin agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(undefined, { isAdmin: false });
    const token = await signAgentSession({ agent_id: agentId, is_admin: false });

    await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});

describe('POST /admin/workspaces/:id/declared-fields', () => {
  it('promotes a new key as active, stamping the admin as declaredBy', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await adminToken();

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
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
    const { token } = await adminToken();

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'VIP Status!', label: 'VIP status', type: 'string' })
      .expect(422);
  });

  it('409s on a duplicate active key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    await promote(workspaceId, token);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'vip_status', label: 'Different label', type: 'string' })
      .expect(409);
  });

  it('revives an archived key instead of erroring', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const first = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${first.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const revived = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key: 'vip_status', label: 'VIP status v2', type: 'number' })
      .expect(201);

    expect(revived.body).toMatchObject({ id: first.id, status: 'active' });
  });
});

describe('PATCH /admin/workspaces/:id/declared-fields/:fieldId', () => {
  it('updates label and type, ignoring any key in the body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier', type: 'number', key: 'ignored_key' })
      .expect(200);

    expect(res.body).toMatchObject({ key: 'vip_status', label: 'VIP tier', type: 'number' });
  });

  it('404s on an archived field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier' })
      .expect(404);
  });

  it('rejects a type change on a seeded field (no declaredBy), but allows the label', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into declared_field (workspace_id, key, label, type, status)
       values ($1, 'player_level', 'Player level', 'number', 'active')
       returning id`,
      [workspaceId],
    );
    const seededId = rows[0]!.id;

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${seededId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'string' })
      .expect(409);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${seededId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Player Level (v2)' })
      .expect(200);

    expect(res.body).toMatchObject({ key: 'player_level', label: 'Player Level (v2)', type: 'number' });
  });

  it('writes a change_log row per changed field, attributed to the admin', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await adminToken();
    const created = await promote(workspaceId, token);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}`)
      .set('Authorization', `Bearer ${token}`)
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
    const { token } = await adminToken();

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/declared-fields/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'VIP tier' })
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/deactivate', () => {
  it('moves an active field to inactive and keeps it in the list', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'inactive' });
  });

  it('404s deactivating an already-inactive field', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/reactivate', () => {
  it('moves an inactive field back to active', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/deactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ id: created.id, key: 'vip_status', status: 'active' });
  });

  it('404s reactivating an archived field — re-promoting is the only way back', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);
    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/reactivate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});

describe('POST /admin/workspaces/:id/declared-fields/:fieldId/archive', () => {
  it('archives the field and excludes it from later listings', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await adminToken();
    const created = await promote(workspaceId, token);

    await request(app)
      .post(`/admin/workspaces/${workspaceId}/declared-fields/${created.id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const list = await request(app)
      .get(`/admin/workspaces/${workspaceId}/declared-fields`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.fields).toEqual([]);
  });
});
