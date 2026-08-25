import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeOwnerPool, seedAgent, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin', adminRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /admin/agents', () => {
  it('lists the directory, filterable by email/name', async () => {
    const admin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    await seedAgent('nomatch@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: admin });

    const res = await request(app)
      .get('/admin/agents?q=super')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({
      email: 'super@mindstormstudios.com',
      is_admin: true,
      is_super_admin: true,
    });
  });
});

describe('PATCH /admin/agents/:id/admin', () => {
  it('super admin grants admin to another agent', async () => {
    const superAdmin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const target = await seedAgent('target@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: superAdmin });

    const res = await request(app)
      .patch(`/admin/agents/${target}/admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_admin: true })
      .expect(200);

    expect(res.body.is_admin).toBe(true);
  });

  it('refuses a plain admin (not super admin) with 403', async () => {
    const plainAdmin = await seedAgent('admin@mindstormstudios.com', { isAdmin: true });
    const target = await seedAgent('target@mindstormstudios.com');
    const token = await signAgentSession({ agent_id: plainAdmin });

    await request(app)
      .patch(`/admin/agents/${target}/admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_admin: true })
      .expect(403);
  });
});

describe('PATCH /admin/agents/:id/super-admin', () => {
  it('blocks a super admin from revoking their own flag', async () => {
    const superAdmin = await seedAgent('super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    // A second super admin so "last super admin" is not the reason for the 422.
    await seedAgent('other-super@mindstormstudios.com', { isAdmin: true, isSuperAdmin: true });
    const token = await signAgentSession({ agent_id: superAdmin });

    await request(app)
      .patch(`/admin/agents/${superAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(422);
  });

  it('blocks revoking the last super admin', async () => {
    const onlySuperAdmin = await seedAgent('only-super@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const otherAdmin = await seedAgent('admin2@mindstormstudios.com', {
      isAdmin: true,
      isSuperAdmin: true,
    });
    const token = await signAgentSession({ agent_id: otherAdmin });

    await request(app)
      .patch(`/admin/agents/${onlySuperAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(200); // otherAdmin revoking onlySuperAdmin is fine — two exist before this call

    // Now only `otherAdmin` remains a super admin — revoking them must be blocked.
    await request(app)
      .patch(`/admin/agents/${otherAdmin}/super-admin`)
      .set('Authorization', `Bearer ${token}`)
      .send({ is_super_admin: false })
      .expect(422);
  });
});
