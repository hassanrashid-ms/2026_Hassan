import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { closeAdminDb } from '../src/shared/db/adminClient.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { closeWsAuthRedis } from '../src/shared/auth/wsAuthCache.ts';
import { agentsRouter } from '../src/agent/routers/agentsRouter.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import { startRealtimeServer } from './helpers/realtime.ts';
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
app.use(requireAgentSession, resolveConsoleWorkspace, agentsRouter);
app.use(errorMiddleware);

let realtime: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeAll(async () => {
  realtime = await startRealtimeServer();
});

afterAll(async () => {
  await realtime.close();
  await closePresenceRedis();
  await closeWsAuthRedis();
  await closeDb();
  await closeAdminDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function tokenFor(agentId: string): Promise<string> {
  return signAgentSession({ agent_id: agentId });
}

describe('PATCH /agent/agents/:agentId/leave', () => {
  it('sets on_leave for an active agent', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: true })
      .expect(200);
    expect(res.body.status).toBe('on_leave');
    expect(res.body.onLeaveSince).not.toBeNull();
    expect(res.body.onLeaveUntil).toBeNull();

    const log = await ownerPool.query(
      `select field, before_value, after_value, actor_id from change_log where entity_type = 'agent' and entity_id = $1 order by field`,
      [targetId],
    );
    // on_leave_until stays null before and after (no days given) — appendChangeLog
    // drops that no-op field, leaving only the two fields that actually changed.
    expect(log.rows.map((r) => r.field)).toEqual(['on_leave_since', 'status']);
    expect(log.rows.find((r) => r.field === 'status')).toMatchObject({
      before_value: 'active',
      after_value: 'on_leave',
      actor_id: leadId,
    });
  });

  it('sets a planned return date when days is provided', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: true, days: 5 })
      .expect(200);
    expect(res.body.onLeaveUntil).not.toBeNull();
    expect(new Date(res.body.onLeaveUntil).getTime()).toBeGreaterThan(
      new Date(res.body.onLeaveSince).getTime(),
    );
  });

  it('clearing on_leave falls back to live presence', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [targetId]);
    await incrementPresence(targetId);
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: false })
      .expect(200);
    expect(res.body).toEqual({ status: 'online', onLeaveSince: null, onLeaveUntil: null });
  });

  it('403s for a plain agent caller', async () => {
    const workspaceId = await seedWorkspace();
    const callerId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: callerId, role: 'agent' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    const token = await tokenFor(callerId);

    await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: true })
      .expect(403);
  });

  it('404s for an agent outside the workspace', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${randomUUID()}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: true })
      .expect(404);
    expect(res.body.error.code).toBe('agent_not_found');
  });

  it('409s for a deactivated agent', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    await ownerPool.query(`update agent set status = 'deactivated' where id = $1`, [targetId]);
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: true })
      .expect(409);
    expect(res.body.error.code).toBe('invalid_status');
  });

  it('400s on a non-boolean body', async () => {
    const workspaceId = await seedWorkspace();
    const leadId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: leadId, role: 'team_lead' });
    const targetId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: targetId, role: 'agent' });
    const token = await tokenFor(leadId);

    const res = await request(app)
      .patch(`/agents/${targetId}/leave`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ onLeave: 'yes' })
      .expect(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
