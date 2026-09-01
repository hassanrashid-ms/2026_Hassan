import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { getSpeedMetrics, getVolumeMetrics } from '../src/agent/services/analyticsService.ts'
import { appendEvent } from '../src/shared/events/appendEvent.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

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
