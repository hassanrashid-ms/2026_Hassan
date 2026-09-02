import { createServer } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sendPlayerMessage } from '../src/surface/services/messagesService.ts';
import { withWorkspace } from '../src/shared/db/withWorkspace.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { conversation } from '../src/shared/db/schema/index.ts';
import { HANDOFF_PLAYER_MESSAGES } from '../src/domain/bot/messages.ts';
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts';
import { incrementPresence, closePresenceRedis } from '../src/shared/realtime/presence.ts';
import type { PlayerContext } from '../src/shared/middleware/requirePlayerToken.ts';
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

beforeAll(() => {
  createSocketServer(createServer());
});

afterAll(async () => {
  await closeSocketServer();
  await closeDb();
  await closeOwnerPool();
  await closePresenceRedis();
});

beforeEach(truncateAll);

function ctxFor(workspaceId: string, playerId: string): PlayerContext {
  return {
    workspaceId,
    playerId,
    externalPlayerId: 'p1',
    workspaceSlug: 'ws',
    sdkVersion: null,
    clientVersion: null,
    idempotencyKey: null,
  };
}

async function setResolved(
  conversationId: string,
  args: { resolutionSource: 'bot' | 'agent' | null; assignedAgentId?: string | null },
): Promise<void> {
  await ownerPool.query(
    `update conversation set status = 'resolved', resolution_source = $2, assigned_agent_id = $3 where id = $1`,
    [conversationId, args.resolutionSource, args.assignedAgentId ?? null],
  );
}

describe('reopen', () => {
  it('reopen from resolved posts a handoff line and lands on open, never bot_active', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, { resolutionSource: 'bot' });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hello again' });

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ status: conversation.status })
        .from(conversation)
        .where(eq(conversation.id, conversationId)),
    );
    expect(row!.status).toBe('open');

    const { rows } = await ownerPool.query<{ body: string }>(
      `select body from message where conversation_id = $1 and author_type = 'system'`,
      [conversationId],
    );
    expect(rows.some((r) => (HANDOFF_PLAYER_MESSAGES as readonly string[]).includes(r.body))).toBe(
      true,
    );
  });

  it('awaiting_player -> open posts no system message', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await ownerPool.query(`update conversation set status = 'awaiting_player' where id = $1`, [
      conversationId,
    ]);

    const before = await ownerPool.query(`select id from message where conversation_id = $1`, [
      conversationId,
    ]);

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'reply' });

    const after = await ownerPool.query(`select id from message where conversation_id = $1`, [
      conversationId,
    ]);
    expect(after.rows.length).toBe(before.rows.length + 1); // only the player's own message
  });

  it('a bot-resolved conversation reopens to assignOnHandoff (no previous owner to keep)', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const activeAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: activeAgent });
    await incrementPresence(activeAgent);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, { resolutionSource: 'bot', assignedAgentId: null });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hi' });

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ assignedAgentId: conversation.assignedAgentId })
        .from(conversation)
        .where(eq(conversation.id, conversationId)),
    );
    expect(row!.assignedAgentId).not.toBeNull();
  });

  it('reopen notifies the newly assigned agent, same as every other assignment site', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const activeAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: activeAgent });
    await incrementPresence(activeAgent);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, { resolutionSource: 'bot', assignedAgentId: null });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hi again' });

    const { rows } = await ownerPool.query<{ agent_id: string; type: string; payload: unknown }>(
      `select agent_id, type, payload from notification where conversation_id = $1`,
      [conversationId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_id).toBe(activeAgent);
    expect(rows[0]!.type).toBe('ticket_assigned');
    expect((rows[0]!.payload as { via: string }).via).toBe('reopen');
  });

  it('an agent-resolved conversation with an active previous owner keeps them', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const previousOwnerId = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: previousOwnerId });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, {
      resolutionSource: 'agent',
      assignedAgentId: previousOwnerId,
    });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hi' });

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ assignedAgentId: conversation.assignedAgentId })
        .from(conversation)
        .where(eq(conversation.id, conversationId)),
    );
    expect(row!.assignedAgentId).toBe(previousOwnerId);
  });

  it('an agent-resolved conversation with a deactivated previous owner falls back to assignOnHandoff', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const deactivatedOwnerId = await seedAgent();
    await ownerPool.query(`update agent set status = 'deactivated' where id = $1`, [
      deactivatedOwnerId,
    ]);
    await seedWorkspaceMember({ workspaceId, agentId: deactivatedOwnerId });
    const anotherActiveAgent = await seedAgent();
    await seedWorkspaceMember({ workspaceId, agentId: anotherActiveAgent });
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, {
      resolutionSource: 'agent',
      assignedAgentId: deactivatedOwnerId,
    });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hi' });

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ assignedAgentId: conversation.assignedAgentId })
        .from(conversation)
        .where(eq(conversation.id, conversationId)),
    );
    expect(row!.assignedAgentId).not.toBe(deactivatedOwnerId);
  });

  it('conversation_reopened carries the correct previous_resolution_source', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    await setResolved(conversationId, { resolutionSource: 'bot' });

    await sendPlayerMessage(ctxFor(workspaceId, playerId), { body: 'hi' });

    const { rows } = await ownerPool.query<{
      payload: { previous_resolution_source: string | null };
    }>(`select payload from event where conversation_id = $1 and type = 'conversation_reopened'`, [
      conversationId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ previous_resolution_source: 'bot' });
  });
});
