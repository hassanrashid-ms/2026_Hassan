import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { assignOnHandoff } from '../src/domain/bot/assignOnHandoff.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import {
  incrementPresence,
  setPresenceStatus,
  closePresenceRedis,
} from '../src/shared/realtime/presence.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts';

beforeEach(truncateAll);
afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

async function assignConversationTo(
  conversationId: string,
  agentId: string,
  status = 'open',
): Promise<void> {
  await ownerPool.query(
    `update conversation set assigned_agent_id = $2, status = $3 where id = $1`,
    [conversationId, agentId, status],
  );
}

describe('assignOnHandoff', () => {
  it('picks the online member with fewest live-status conversations', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const busyAgent = await seedAgent();
    const idleAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: busyAgent });
    await seedWorkspaceMember({ workspaceId, agentId: idleAgent });
    await incrementPresence(busyAgent);
    await incrementPresence(idleAgent);

    const busyConvo = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(busyConvo, busyAgent, 'open');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(idleAgent);
  });

  it('breaks ties by agent.id ascending', async () => {
    const workspaceId = await seedWorkspace();
    const agentLow = await seedAgent('a-low@example.test');
    const agentHigh = await seedAgent('a-high@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: agentLow });
    await seedWorkspaceMember({ workspaceId, agentId: agentHigh });
    await incrementPresence(agentLow);
    await incrementPresence(agentHigh);

    const [lo, hi] = [agentLow, agentHigh].sort();
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(lo);
    expect(result).not.toBe(hi);
  });

  it('skips a deactivated workspace member', async () => {
    const workspaceId = await seedWorkspace();
    const deactivated = await seedAgent();
    const active = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: deactivated, deactivatedAt: new Date() });
    await seedWorkspaceMember({ workspaceId, agentId: active });
    await incrementPresence(deactivated);
    await incrementPresence(active);

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(active);
  });

  it('skips an agent whose status is not active', async () => {
    const workspaceId = await seedWorkspace();
    const onLeave = await seedAgent();
    const active = await seedAgent();
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [onLeave]);
    await seedWorkspaceMember({ workspaceId, agentId: onLeave });
    await seedWorkspaceMember({ workspaceId, agentId: active });
    await incrementPresence(onLeave);
    await incrementPresence(active);

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(active);
  });

  it('includes team leads', async () => {
    const workspaceId = await seedWorkspace();
    const lead = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: lead, role: 'team_lead' });
    await incrementPresence(lead);

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(lead);
  });

  it('never assigns a global admin, who holds no workspace_member row', async () => {
    const workspaceId = await seedWorkspace();
    const admin = await seedAgent(undefined, { isAdmin: true });
    const active = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: active });
    await incrementPresence(admin);
    await incrementPresence(active);

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(active);
  });

  it('returns null, not an error, when no active agent exists', async () => {
    const workspaceId = await seedWorkspace();
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBeNull();
  });

  it('never picks an agent from another workspace', async () => {
    const workspaceA = await seedWorkspace();
    const workspaceB = await seedWorkspace();
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId: agentB });
    await incrementPresence(agentB);

    const result = await withWorkspace(workspaceA, (tx) => assignOnHandoff(tx, workspaceA));
    expect(result).toBeNull();
  });

  it('excludes an agent at the max-assigned-tickets cap, picking an under-cap agent', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const atCap = await seedAgent();
    const underCap = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: atCap });
    await seedWorkspaceMember({ workspaceId, agentId: underCap });
    await incrementPresence(atCap);
    await incrementPresence(underCap);
    await ownerPool.query(`update workspace set max_assigned_tickets = 1 where id = $1`, [
      workspaceId,
    ]);

    const c1 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c1, atCap, 'open');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(underCap);
  });

  it('returns null when every active agent is at or over the cap', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await seedAgent();
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: agentA });
    await seedWorkspaceMember({ workspaceId, agentId: agentB });
    await incrementPresence(agentA);
    await incrementPresence(agentB);
    await ownerPool.query(`update workspace set max_assigned_tickets = 1 where id = $1`, [
      workspaceId,
    ]);

    const c1 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c1, agentA, 'open');
    const c2 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c2, agentB, 'escalated');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBeNull();
  });

  it('only counts open, awaiting_player, escalated as live — not resolved or closed', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const agentA = await seedAgent();
    const agentB = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: agentA });
    await seedWorkspaceMember({ workspaceId, agentId: agentB });
    await incrementPresence(agentA);
    await incrementPresence(agentB);

    // agentA has two RESOLVED conversations — should not count against them.
    const c1 = await seedConversation({ workspaceId, playerId });
    const c2 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c1, agentA, 'resolved');
    await assignConversationTo(c2, agentA, 'closed');

    // agentB has one OPEN conversation — should count.
    const c3 = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(c3, agentB, 'open');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(agentA);
  });

  it('excludes an offline agent even if less loaded, picking the online one', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const idleOffline = await seedAgent();
    const busyOnline = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: idleOffline });
    await seedWorkspaceMember({ workspaceId, agentId: busyOnline });

    // busyOnline carries a live ticket (so it would lose on load alone) but
    // has an open socket connection; idleOffline has none.
    const busyConvo = await seedConversation({ workspaceId, playerId });
    await assignConversationTo(busyConvo, busyOnline, 'open');
    await incrementPresence(busyOnline);

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBe(busyOnline);
  });

  it('excludes an away agent — only online counts, same as offline', async () => {
    const workspaceId = await seedWorkspace();
    const away = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: away });
    await incrementPresence(away);
    await setPresenceStatus(away, 'away');

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBeNull();
  });

  it('returns null, not the least-loaded pick, when every eligible agent is offline', async () => {
    const workspaceId = await seedWorkspace();
    const agentLow = await seedAgent('a-low@example.test');
    const agentHigh = await seedAgent('a-high@example.test');
    await seedWorkspaceMember({ workspaceId, agentId: agentLow });
    await seedWorkspaceMember({ workspaceId, agentId: agentHigh });

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId));
    expect(result).toBeNull();
  });
});
