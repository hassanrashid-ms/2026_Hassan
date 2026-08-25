import { and, eq } from 'drizzle-orm';
import IORedis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { getEnv } from '../../env.ts';
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts';
import { InvalidPlayerToken, verifyPlayerToken } from '../auth/playerToken.ts';
import { conversation } from '../db/schema/index.ts';
import { withWorkspace } from '../db/withWorkspace.ts';
import { listActiveMembershipsForAgent, listAllWorkspaces } from '../db/workspaceMembership.ts';
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts';
import { decrementPresence, incrementPresence } from './presence.ts';
import { logger } from '../logging/logger.ts';

export type PlayerSocketData = { role: 'player'; workspaceId: string; playerId: string };
export type AgentSocketData = { role: 'agent'; workspaceIds: string[]; agentId: string };
export type SocketData = PlayerSocketData | AgentSocketData;

let ioInstance: Server | undefined;
let redisClients: IORedis[] = [];
// Set true at the start of closeSocketServer, before its adapter's Redis
// clients are quit. Presence bookkeeping runs as fire-and-forget work off a
// socket connect/disconnect and can still be in flight when the server closes
// (this happens routinely in tests that close the server right after a
// socket event); checking this flag before emitting on the now-closing
// adapter avoids publishing over an already-quit Redis connection, which
// ioredis surfaces as an unhandled rejection rather than a catchable error.
let closing = false;

function redisConnection(): IORedis {
  const client = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  redisClients.push(client);
  return client;
}

async function canJoinConversation(data: SocketData, conversationId: string): Promise<boolean> {
  if (data.role === 'player') {
    return withWorkspace(data.workspaceId, async (tx) => {
      const [found] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(and(eq(conversation.id, conversationId), eq(conversation.playerId, data.playerId)))
        .limit(1);
      return found !== undefined;
    });
  }
  // An agent may belong to dozens of workspaces (same bound the design doc's
  // p-limit rationale for Global Inbox relies on) — checked sequentially,
  // short-circuiting on the first match, since which workspace this
  // conversation actually lives in isn't known ahead of time.
  for (const workspaceId of data.workspaceIds) {
    const found = await withWorkspace(workspaceId, async (tx) => {
      const [row] = await tx
        .select({ id: conversation.id })
        .from(conversation)
        .where(eq(conversation.id, conversationId))
        .limit(1);
      return row !== undefined;
    });
    if (found) return true;
  }
  return false;
}

/**
 * Auth is on connect, not per-message: the handshake carries the same player
 * JWT or agent-session token already used for REST, verified once here.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  closing = false;
  const pubClient = redisConnection();
  const subClient = pubClient.duplicate();

  const io = new Server(httpServer, {
    cors: { origin: getEnv().SURFACE_ORIGINS, methods: ['GET', 'POST'] },
    adapter: createAdapter(pubClient, subClient),
  });

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as {
      token?: unknown;
      role?: unknown;
      workspaceId?: unknown;
    };
    if (typeof auth.token !== 'string' || (auth.role !== 'player' && auth.role !== 'agent')) {
      next(new Error('unauthorized'));
      return;
    }
    try {
      if (auth.role === 'player') {
        const claims = await verifyPlayerToken(auth.token);
        socket.data = {
          role: 'player',
          workspaceId: claims.workspace_id,
          playerId: claims.player_id,
        } satisfies PlayerSocketData;
      } else {
        const claims = await verifyAgentSession(auth.token);
        const workspaceIds = claims.is_admin
          ? (await listAllWorkspaces()).map((w) => w.workspaceId)
          : (await listActiveMembershipsForAgent(claims.agent_id)).map((m) => m.workspaceId);
        socket.data = {
          role: 'agent',
          workspaceIds,
          agentId: claims.agent_id,
        } satisfies AgentSocketData;
      }
      next();
    } catch (error) {
      if (error instanceof InvalidPlayerToken || error instanceof InvalidAgentSession) {
        next(new Error('unauthorized'));
        return;
      }
      next(error instanceof Error ? error : new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    if (data.role === 'agent') {
      for (const workspaceId of data.workspaceIds) {
        socket.join(inboxRoom(workspaceId));
      }
      // Reconnecting always lands back on online, never restores a prior
      // away — a fresh session defaults to present.
      void incrementPresence(data.agentId)
        .then(({ wasFirstConnection }) => {
          if (wasFirstConnection && !closing) {
            for (const workspaceId of data.workspaceIds) {
              io.to(inboxRoom(workspaceId)).emit('presence_changed', {
                agentId: data.agentId,
                status: 'online',
              });
            }
          }
        })
        // Fire-and-forget: a socket connect must never crash on a Redis blip,
        // and by the time this settles the process may already be mid-teardown
        // (e.g. test suites closing the socket/Redis connections right after a
        // socket disconnects) — surfacing that as an unhandled rejection is
        // strictly worse than logging and moving on.
        .catch((error) => {
          logger.error(
            'presence',
            `incrementPresence failed for agent ${data.agentId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });

      socket.on('disconnect', () => {
        void decrementPresence(data.agentId)
          .then(({ wasLastConnection }) => {
            if (wasLastConnection && !closing) {
              for (const workspaceId of data.workspaceIds) {
                io.to(inboxRoom(workspaceId)).emit('presence_changed', {
                  agentId: data.agentId,
                  status: 'offline',
                });
              }
            }
          })
          .catch((error) => {
            logger.error(
              'presence',
              `decrementPresence failed for agent ${data.agentId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      });
    }

    socket.on(
      'join_conversation',
      (payload: { conversation_id?: unknown }, ack?: (ok: boolean) => void) => {
        const conversationId = payload.conversation_id;
        if (typeof conversationId !== 'string') {
          ack?.(false);
          return;
        }
        void canJoinConversation(data, conversationId).then((allowed) => {
          if (allowed)
            socket.join(
              data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId),
            );
          ack?.(allowed);
        });
      },
    );

    socket.on('leave_conversation', (payload: { conversation_id?: unknown }) => {
      const conversationId = payload.conversation_id;
      if (typeof conversationId !== 'string') return;
      socket.leave(data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId));
    });
  });

  ioInstance = io;
  return io;
}

export function getIo(): Server {
  if (!ioInstance)
    throw new Error('Socket server not initialised — call createSocketServer first.');
  return ioInstance;
}

/**
 * Test-only teardown. Production never calls this (the process exit closes
 * everything), but a test process shares one Postgres/Redis connection
 * lifetime across every test file in this worker (see vitest.config.ts's
 * fileParallelism: false) — leaving the Redis pub/sub pair open after each
 * file that calls createSocketServer() accumulates real connections for the
 * rest of the run and destabilises unrelated later tests.
 */
export async function closeSocketServer(): Promise<void> {
  closing = true;
  if (ioInstance) {
    await new Promise<void>((resolve) => ioInstance!.close(() => resolve()));
    ioInstance = undefined;
  }
  await Promise.all(redisClients.map((client) => client.quit().catch(() => client.disconnect())));
  redisClients = [];
}
