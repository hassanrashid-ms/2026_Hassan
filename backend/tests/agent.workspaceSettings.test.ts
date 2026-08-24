import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { workspaceSettingsRouter } from '../src/agent/routers/workspaceSettingsRouter.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, workspaceSettingsRouter);
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

async function seedAgentWithRole(
  workspaceId: string,
  role: 'agent' | 'team_lead' | 'admin',
): Promise<{ token: string }> {
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
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId });
  return { token };
}

describe('GET /workspace-settings', () => {
  it('returns the schema defaults for a freshly seeded workspace', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .get('/workspace-settings')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({
      max_assigned_tickets: 5,
      auto_close_days: 7,
      inactivity_window_hours: 24,
      form_timeout_minutes: 30,
    });
  });

  it('allows a team lead to read', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app).get('/workspace-settings').set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('forbids a plain agent', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'agent');

    await request(app).get('/workspace-settings').set('Authorization', `Bearer ${token}`).expect(403);
  });
});

describe('POST /workspace-settings', () => {
  it('updates all four settings for an admin', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    const res = await request(app)
      .post('/workspace-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        max_assigned_tickets: 10,
        auto_close_days: 14,
        inactivity_window_hours: 48,
        form_timeout_minutes: 60,
      })
      .expect(200);

    expect(res.body).toEqual({
      max_assigned_tickets: 10,
      auto_close_days: 14,
      inactivity_window_hours: 48,
      form_timeout_minutes: 60,
    });
  });

  it('forbids a team lead from writing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'team_lead');

    await request(app)
      .post('/workspace-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        max_assigned_tickets: 10,
        auto_close_days: 14,
        inactivity_window_hours: 48,
        form_timeout_minutes: 60,
      })
      .expect(403);
  });

  it('rejects a value outside bounds', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentWithRole(workspaceId, 'admin');

    await request(app)
      .post('/workspace-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({
        max_assigned_tickets: 0,
        auto_close_days: 14,
        inactivity_window_hours: 48,
        form_timeout_minutes: 60,
      })
      .expect(422);
  });
});
