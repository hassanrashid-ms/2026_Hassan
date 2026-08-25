import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { errorMiddleware } from '../src/errors.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { globalInboxRouter } from '../src/agent/routers/globalInboxRouter.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import {
  closeOwnerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

// Mounted before resolveConsoleWorkspace in the real agentRouter — no
// X-Workspace-Id needed, the whole point is it scatters across all of them.
const app = express();
app.use(express.json());
app.use(requireAgentSession, globalInboxRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('GET /agent/global-inbox', () => {
  it('returns tickets assigned to this agent across every workspace they belong to, with no X-Workspace-Id header', async () => {
    const workspaceA = await seedWorkspace({ slug: 'ws-a' });
    const workspaceB = await seedWorkspace({ slug: 'ws-b' });
    const agentId = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceA, agentId, role: 'agent' });
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId, role: 'agent' });
    const playerA = await seedPlayer(workspaceA);
    const playerB = await seedPlayer(workspaceB);
    const convA = await seedConversation({
      workspaceId: workspaceA,
      playerId: playerA,
      status: 'open',
      assignedAgentId: agentId,
    });
    const convB = await seedConversation({
      workspaceId: workspaceB,
      playerId: playerB,
      status: 'open',
      assignedAgentId: agentId,
    });
    const token = await signAgentSession({ agent_id: agentId });

    const res = await request(app)
      .get('/global-inbox')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.conversations.map((c: { id: string }) => c.id)).toEqual(
      expect.arrayContaining([convA, convB]),
    );
    expect(res.body.failed_workspaces).toEqual([]);
  });
});
