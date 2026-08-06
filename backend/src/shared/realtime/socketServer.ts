import { and, eq } from 'drizzle-orm'
import IORedis from 'ioredis'
import { createAdapter } from '@socket.io/redis-adapter'
import { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import { getEnv } from '../../env.ts'
import { InvalidAgentSession, verifyAgentSession } from '../auth/agentSession.ts'
import { InvalidPlayerToken, verifyPlayerToken } from '../auth/playerToken.ts'
import { conversation } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'
import { agentRoom, inboxRoom, playerRoom } from './rooms.ts'

export type PlayerSocketData = { role: 'player'; workspaceId: string; playerId: string }
export type AgentSocketData = { role: 'agent'; workspaceId: string; agentId: string }
export type SocketData = PlayerSocketData | AgentSocketData

let ioInstance: Server | undefined

function redisConnection(): IORedis {
  return new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null })
}

async function canJoinConversation(data: SocketData, conversationId: string): Promise<boolean> {
  return withWorkspace(data.workspaceId, async (tx) => {
    const where =
      data.role === 'player'
        ? and(eq(conversation.id, conversationId), eq(conversation.playerId, data.playerId))
        : eq(conversation.id, conversationId)
    const [found] = await tx.select({ id: conversation.id }).from(conversation).where(where).limit(1)
    return found !== undefined
  })
}

/**
 * Auth is on connect, not per-message: the handshake carries the same player
 * JWT or agent-session token already used for REST, verified once here.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const pubClient = redisConnection()
  const subClient = pubClient.duplicate()

  const io = new Server(httpServer, {
    cors: { origin: getEnv().SURFACE_ORIGINS, methods: ['GET', 'POST'] },
    adapter: createAdapter(pubClient, subClient),
  })

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown; role?: unknown }
    if (typeof auth.token !== 'string' || (auth.role !== 'player' && auth.role !== 'agent')) {
      next(new Error('unauthorized'))
      return
    }
    try {
      if (auth.role === 'player') {
        const claims = await verifyPlayerToken(auth.token)
        socket.data = { role: 'player', workspaceId: claims.workspace_id, playerId: claims.player_id } satisfies PlayerSocketData
      } else {
        const claims = await verifyAgentSession(auth.token)
        socket.data = { role: 'agent', workspaceId: claims.workspace_id, agentId: claims.agent_id } satisfies AgentSocketData
      }
      next()
    } catch (error) {
      if (error instanceof InvalidPlayerToken || error instanceof InvalidAgentSession) {
        next(new Error('unauthorized'))
        return
      }
      next(error instanceof Error ? error : new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    const data = socket.data as SocketData
    if (data.role === 'agent') {
      socket.join(inboxRoom(data.workspaceId))
    }

    socket.on('join_conversation', (payload: { conversation_id?: unknown }, ack?: (ok: boolean) => void) => {
      const conversationId = payload.conversation_id
      if (typeof conversationId !== 'string') {
        ack?.(false)
        return
      }
      void canJoinConversation(data, conversationId).then((allowed) => {
        if (allowed) socket.join(data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId))
        ack?.(allowed)
      })
    })

    socket.on('leave_conversation', (payload: { conversation_id?: unknown }) => {
      const conversationId = payload.conversation_id
      if (typeof conversationId !== 'string') return
      socket.leave(data.role === 'player' ? playerRoom(conversationId) : agentRoom(conversationId))
    })
  })

  ioInstance = io
  return io
}

export function getIo(): Server {
  if (!ioInstance) throw new Error('Socket server not initialised — call createSocketServer first.')
  return ioInstance
}
