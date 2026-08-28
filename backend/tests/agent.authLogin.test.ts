import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { authRouter } from '../src/agent/routers/authRouter.ts';
import { verifyAgentSession } from '../src/shared/auth/agentSession.ts';
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
app.use(authRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('POST /auth/dev-login', () => {
  it('logs in a regular agent with zero memberships — no more "not found" for an unassigned agent', async () => {
    const agentId = await seedAgent();

    const res = await request(app).post('/auth/dev-login').send({ agent_id: agentId }).expect(200);

    expect(res.body.agent.id).toBe(agentId);
    expect(res.body.workspace).toBeUndefined();
    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: agentId, is_admin: false });
  });

  it('logs in a regular agent with active memberships, still with no workspace bound to the token', async () => {
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId, role: 'agent' });

    const res = await request(app).post('/auth/dev-login').send({ agent_id: agentId }).expect(200);

    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: agentId, is_admin: false });
  });

  it('logs in a global admin with is_admin true on the token', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true });

    const res = await request(app).post('/auth/dev-login').send({ agent_id: adminId }).expect(200);

    const claims = await verifyAgentSession(res.body.token);
    expect(claims).toEqual({ agent_id: adminId, is_admin: true });
  });

  it('accepts an invite on first login, flipping status from invited to active', async () => {
    const agentId = await seedAgent(undefined, { status: 'invited' });

    await request(app).post('/auth/dev-login').send({ agent_id: agentId }).expect(200);

    const { rows } = await ownerPool.query('select status from agent where id = $1', [agentId]);
    expect(rows[0].status).toBe('active');
  });

  it('404s an agent id that does not exist', async () => {
    await request(app)
      .post('/auth/dev-login')
      .send({ agent_id: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });
});
