import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { adminRouter } from '../src/admin/router.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

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

async function adminToken(workspaceId: string): Promise<string> {
  const agentId = await seedAgent(undefined, { isAdmin: true });
  return signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
}

describe('POST /admin/workspaces/:id/members', () => {
  it('invites a brand-new email, creating a pending agent row', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new-hire@mindstormstudios.com', role: 'agent' })
      .expect(201);

    expect(res.body).toMatchObject({
      email: 'new-hire@mindstormstudios.com',
      role: 'agent',
      status: 'invited',
    });
    const { rows } = await ownerPool.query(
      `select status from agent where email = 'new-hire@mindstormstudios.com'`,
    );
    expect(rows[0].status).toBe('invited');
  });

  it('upserts the role when the email is already a member', async () => {
    const workspaceId = await seedWorkspace();
    const existing = await seedAgent('already-here@mindstormstudios.com');
    await seedWorkspaceMember({ workspaceId, agentId: existing, role: 'agent' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'already-here@mindstormstudios.com', role: 'team_lead' })
      .expect(201);

    expect(res.body.role).toBe('team_lead');
    const { rows } = await ownerPool.query(
      `select role from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, existing],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('team_lead');
  });
});

describe('GET /admin/workspaces/:id/members', () => {
  it('lists active members with their role', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent('lead@mindstormstudios.com');
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .get(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.members).toEqual([
      expect.objectContaining({
        agent_id: leadId,
        role: 'team_lead',
        email: 'lead@mindstormstudios.com',
      }),
    ]);
  });
});

describe('PATCH /admin/workspaces/:id/members/:agentId', () => {
  it('changes a member role', async () => {
    const workspaceId = await seedWorkspace();
    const memberId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: memberId, role: 'agent' });
    const token = await adminToken(workspaceId);

    const res = await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${memberId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'team_lead' })
      .expect(200);

    expect(res.body.role).toBe('team_lead');
  });

  it('removes access by setting deactivated_at, not deleting the row, for an already-active member', async () => {
    const workspaceId = await seedWorkspace();
    const memberId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: memberId, role: 'agent' });
    const token = await adminToken(workspaceId);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${memberId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ remove: true })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select deactivated_at from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, memberId],
    );
    expect(rows[0].deactivated_at).not.toBeNull();
  });

  it('deletes the pending row outright when removing an invited (never-logged-in) member', async () => {
    const workspaceId = await seedWorkspace();
    const token = await adminToken(workspaceId);
    const created = await request(app)
      .post(`/admin/workspaces/${workspaceId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'pending@mindstormstudios.com', role: 'agent' })
      .expect(201);

    await request(app)
      .patch(`/admin/workspaces/${workspaceId}/members/${created.body.agent_id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ remove: true })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select * from workspace_member where workspace_id = $1 and agent_id = $2`,
      [workspaceId, created.body.agent_id],
    );
    expect(rows).toHaveLength(0);
  });
});
