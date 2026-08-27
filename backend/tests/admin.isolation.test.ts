import express from 'express';
import { adminRouter } from '../src/admin/router.ts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { requireAdminAccess } from '../src/shared/middleware/requireAdminAccess.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeOwnerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use('/admin/probe', requireAgentSession, requireAdminAccess, (_req, res) => {
  res.status(200).json({ ok: true });
});
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('requireAdminAccess', () => {
  it('admits a globally is_admin agent', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: agentId });
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('refuses a non-admin agent with 403', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });
    await request(app).get('/admin/probe').set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('requires authentication before it can check the flag', async () => {
    await request(app).get('/admin/probe').expect(401);
  });
});

const fullApp = express();
fullApp.use(express.json());
fullApp.use('/admin', adminRouter);
fullApp.use(errorMiddleware);

describe('admin cross-workspace isolation', () => {
  it('a single admin request reads across every workspace, unlike a normal RLS-scoped request', async () => {
    const workspaceA = await seedWorkspace({ name: 'Isolated A' });
    const workspaceB = await seedWorkspace({ name: 'Isolated B' });
    const adminId = await seedAgent(undefined, { isAdmin: true });
    // Session names workspace A; the admin endpoint must still see workspace B.
    const token = await signAgentSession({ agent_id: adminId });

    const res = await request(fullApp)
      .get('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const names = res.body.workspaces.map((w: any) => w.name);
    expect(names).toContain('Isolated A');
    expect(names).toContain('Isolated B');
  });

  it('a non-admin session is refused by the real admin router at 403, not merely the probe', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    await request(fullApp)
      .get('/admin/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
});
