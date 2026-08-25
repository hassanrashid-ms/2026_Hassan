import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { mintToken } from './helpers/app.ts';
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts';
import { connectClient, startRealtimeServer } from './helpers/realtime.ts';

let server: Awaited<ReturnType<typeof startRealtimeServer>>;

beforeEach(async () => {
  await truncateAll();
  server = await startRealtimeServer();
});

afterEach(async () => {
  await server.close();
});

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

function waitFor(socket: ReturnType<typeof connectClient>, event: string): Promise<void> {
  return new Promise((resolve) => socket.on(event, () => resolve()));
}

describe('internal notes never reach the player room', () => {
  it('posting an internal note through sendAgentMessage end-to-end never emits to conv:{id}:player', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent-note@example.test', 'Agent Note') returning id`,
    );
    const agentId = rows[0]!.id;
    await ownerPool.query(
      `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
      [workspaceId, agentId],
    );
    await ownerPool.query(`update conversation set assigned_agent_id = $2 where id = $1`, [
      conversationId,
      agentId,
    ]);
    const agentToken = await signAgentSession({ agent_id: agentId });

    const playerToken = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' });
    await waitFor(playerSocket, 'connect');
    await new Promise<boolean>((resolve) =>
      playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    );

    const playerReceived: unknown[] = [];
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload));

    await request(server.url)
      .post('/agent/messages')
      .set('Authorization', `Bearer ${agentToken}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'internal only', visibility: 'internal' })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(playerReceived).toEqual([]);
    playerSocket.close();
  });

  it('a bot unavailable outcome posts an internal note that never reaches conv:{id}:player', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });

    const playerToken = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const playerSocket = connectClient(server.url, { token: playerToken, role: 'player' });
    await waitFor(playerSocket, 'connect');
    await new Promise<boolean>((resolve) =>
      playerSocket.emit('join_conversation', { conversation_id: conversationId }, resolve),
    );

    const playerReceived: unknown[] = [];
    playerSocket.on('message:new', (payload: unknown) => playerReceived.push(payload));

    const { applyBotTurn } = await import('../src/domain/bot/applyBotTurn.ts');
    const { withWorkspace } = await import('../src/shared/db/withWorkspace.ts');
    const { toAgentView, toPlayerView } = await import('../src/domain/conversations/index.ts');
    const { emitMessageToRooms } = await import('../src/shared/realtime/emit.ts');
    const { getIo } = await import('../src/shared/realtime/socketServer.ts');

    const { posted } = await withWorkspace(workspaceId, (tx) =>
      applyBotTurn(tx, { workspaceId, conversationId }, { kind: 'unavailable', reason: 'error' }),
    );
    for (const msg of posted) {
      emitMessageToRooms(getIo(), conversationId, toPlayerView(msg), toAgentView(msg));
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Three messages were posted (public handoff line + internal note +
    // public no-agents-online line, since no agent is online in this test);
    // only the two public ones may reach the player.
    expect(playerReceived.length).toBe(2);
    playerSocket.close();
  });
});
