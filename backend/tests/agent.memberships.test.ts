import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { membershipsRouter } from '../src/agent/routers/membershipsRouter.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

// membershipsRouter is mounted before resolveConsoleWorkspace in the real
// agentRouter — no X-Workspace-Id needed to ask "which workspaces am I in".
const app = express();
app.use(express.json());
app.use(requireAgentSession, membershipsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /agent/memberships', () => {
  it('lists a regular agent’s active memberships with role, excluding a deactivated one', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a', name: 'Workspace A' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b', name: 'Workspace B' });
    const workspaceC = await seedWorkspace({ slug: 'ws-c', name: 'Workspace C' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'team_lead' });
    await seedWorkspaceMember({
      workspaceId: workspaceC,
      agentId,
      role: 'agent',
      deactivatedAt: new Date(),
    });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships).toEqual(
      expect.arrayContaining([
        {
          workspace_id: workspaceA,
          workspace_slug: 'ws-a',
          workspace_name: 'Workspace A',
          role: 'agent',
        },
        {
          workspace_id: workspaceB,
          workspace_slug: 'ws-b',
          workspace_name: 'Workspace B',
          role: 'team_lead',
        },
      ]),
    );
    expect(res.body.memberships).toHaveLength(2);
  });

  it('returns every workspace with role admin for a global admin', async () => {
    await seedWorkspace({ slug: 'ws-x' });
    await seedWorkspace({ slug: 'ws-y' });
    const adminId = await seedAgent(undefined, { isAdmin: true });
    const token = await signAgentSession({ agent_id: adminId, is_admin: true });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships.every((m: { role: string }) => m.role === 'admin')).toBe(true);
    expect(res.body.memberships.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty list, not an error, for an agent with no memberships', async () => {
    const agentId = await seedAgent();
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/memberships')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.memberships).toEqual([]);
  });
});
