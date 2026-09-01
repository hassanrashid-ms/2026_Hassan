import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { getBotMetrics, getSpeedMetrics, getTeamMetrics, getVolumeMetrics } from '../src/agent/services/analyticsService.ts'
import { appendEvent } from '../src/shared/events/appendEvent.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts'
import { errorMiddleware } from '../src/errors.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { analyticsRouter } from '../src/agent/routers/analyticsRouter.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

const RANGE = { from: '2026-08-01', to: '2026-08-31', granularity: 'day' as const }

describe('getVolumeMetrics', () => {
  it('counts open conversations and groups by status/priority', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await seedConversation({ workspaceId, playerId, status: 'open', createdAt: new Date('2026-08-05T10:00:00Z') })
    await seedConversation({ workspaceId, playerId, status: 'resolved', createdAt: new Date('2026-08-06T10:00:00Z') })

    const result = await getVolumeMetrics({ workspaceId }, RANGE)

    expect(result.openTotal).toBe(1)
    expect(result.byStatus).toEqual(
      expect.arrayContaining([
        { status: 'open', count: 1 },
        { status: 'resolved', count: 1 },
      ]),
    )
  })

  it("never reflects another workspace's conversations", async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const playerB = await seedPlayer(workspaceB)
    await seedConversation({ workspaceId: workspaceB, playerId: playerB, status: 'open' })

    const result = await getVolumeMetrics({ workspaceId: workspaceA }, RANGE)

    expect(result.openTotal).toBe(0)
  })

  it('counts opened conversations per bucket from createdAt within range', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await seedConversation({ workspaceId, playerId, status: 'open', createdAt: new Date('2026-08-05T10:00:00Z') })
    await seedConversation({ workspaceId, playerId, status: 'open', createdAt: new Date('2026-08-05T14:00:00Z') })

    const result = await getVolumeMetrics({ workspaceId }, RANGE)

    expect(result.series).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: '2026-08-05', opened: 2 })]))
  })
})

describe('getSpeedMetrics', () => {
  it('computes first-response time from conversation_opened to the first agent message_sent event', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' })
    const opened = new Date('2026-08-05T10:00:00Z')
    const firstReply = new Date('2026-08-05T10:02:00Z') // 120s later

    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, { workspaceId, type: 'conversation_opened', conversationId, actorType: 'system', occurredAt: opened })
      await appendEvent(tx, {
        workspaceId,
        type: 'message_sent',
        conversationId,
        actorType: 'agent',
        occurredAt: firstReply,
      })
    })

    const result = await getSpeedMetrics({ workspaceId }, RANGE)

    expect(result.firstResponse.avgSeconds).toBe(120)
  })

  it('computes resolution time from conversation_opened to conversation_resolved', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'resolved' })
    const opened = new Date('2026-08-05T10:00:00Z')
    const resolved = new Date('2026-08-05T11:00:00Z') // 3600s later

    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, { workspaceId, type: 'conversation_opened', conversationId, actorType: 'system', occurredAt: opened })
      await appendEvent(tx, { workspaceId, type: 'conversation_resolved', conversationId, actorType: 'agent', occurredAt: resolved })
    })

    const result = await getSpeedMetrics({ workspaceId }, RANGE)

    expect(result.resolution.avgSeconds).toBe(3600)
  })

  it('computes time-to-claim from conversation_opened to conversation_assigned', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' })
    const opened = new Date('2026-08-05T10:00:00Z')
    const claimed = new Date('2026-08-05T10:01:00Z') // 60s later

    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, { workspaceId, type: 'conversation_opened', conversationId, actorType: 'system', occurredAt: opened })
      await appendEvent(tx, { workspaceId, type: 'conversation_assigned', conversationId, actorType: 'agent', occurredAt: claimed })
    })

    const result = await getSpeedMetrics({ workspaceId }, RANGE)

    expect(result.timeToClaim.series).toEqual([{ bucket: '2026-08-05', seconds: 60 }])
  })
})

describe('getBotMetrics', () => {
  it('computes containment rate as bot-resolved over total resolved', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await seedConversation({ workspaceId, playerId, status: 'resolved', resolutionSource: 'bot' })
    await seedConversation({ workspaceId, playerId, status: 'resolved', resolutionSource: 'agent' })

    const result = await getBotMetrics({ workspaceId }, RANGE)

    expect(result.containmentRate).toBe(0.5)
  })

  it('groups handoffs by reason from the event payload', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'escalated' })
    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, {
        workspaceId,
        type: 'bot_handoff',
        conversationId,
        actorType: 'bot',
        payload: { reason: 'article_rejected' },
        occurredAt: new Date('2026-08-05T10:00:00Z'),
      })
    })

    const result = await getBotMetrics({ workspaceId }, RANGE)

    expect(result.handoff.byReason).toEqual([{ reason: 'article_rejected', count: 1 }])
  })

  it('computes article hit rate as offered over searched', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'bot_active' })
    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, {
        workspaceId,
        type: 'bot_search',
        conversationId,
        actorType: 'bot',
        occurredAt: new Date('2026-08-05T10:00:00Z'),
      })
      await appendEvent(tx, {
        workspaceId,
        type: 'bot_search',
        conversationId,
        actorType: 'bot',
        occurredAt: new Date('2026-08-05T10:01:00Z'),
      })
      await appendEvent(tx, {
        workspaceId,
        type: 'bot_article_offered',
        conversationId,
        actorType: 'bot',
        occurredAt: new Date('2026-08-05T10:01:00Z'),
      })
    })

    const result = await getBotMetrics({ workspaceId }, RANGE)

    expect(result.articleHitRate).toBe(0.5)
  })
})

describe('getTeamMetrics', () => {
  it('divides assigned open conversations by active agent count', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
    )
    const agentId = rows[0]!.id
    await seedWorkspaceMember({ workspaceId, agentId })
    await seedConversation({ workspaceId, playerId, status: 'open', assignedAgentId: agentId })
    await seedConversation({ workspaceId, playerId, status: 'open', assignedAgentId: agentId })

    const result = await getTeamMetrics({ workspaceId }, RANGE)

    expect(result.avgOpenPerActiveAgent).toBe(2)
  })

  it('counts unassigned queue depth per bucket for conversations opened but never assigned', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId, status: 'open' })

    await withWorkspace(workspaceId, async (tx) => {
      await appendEvent(tx, {
        workspaceId,
        type: 'conversation_opened',
        conversationId,
        actorType: 'system',
        occurredAt: new Date('2026-08-05T10:00:00Z'),
      })
    })

    const result = await getTeamMetrics({ workspaceId }, RANGE)

    expect(result.unassignedQueueDepth.series).toEqual([{ bucket: '2026-08-05', depth: 1 }])
  })
})

describe('GET /agent/analytics', () => {
  const app = express()
  app.use(express.json())
  app.use(requireAgentSession, resolveConsoleWorkspace, analyticsRouter)
  app.use(errorMiddleware)

  it('returns every metric group for the given range', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
    )
    const agentId = rows[0]!.id
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      agentId,
    ])
    const token = await signAgentSession({ agent_id: agentId })

    const res = await request(app)
      .get('/analytics')
      .query({ from: '2026-08-01', to: '2026-08-31', granularity: 'day' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200)

    expect(res.body).toHaveProperty('volume')
    expect(res.body).toHaveProperty('speed')
    expect(res.body).toHaveProperty('bot')
    expect(res.body).toHaveProperty('team')
  })

  it('422s on an invalid granularity', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
    )
    const agentId = rows[0]!.id
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      agentId,
    ])
    const token = await signAgentSession({ agent_id: agentId })

    await request(app)
      .get('/analytics')
      .query({ from: '2026-08-01', to: '2026-08-31', granularity: 'month' })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(422)
  })
})
