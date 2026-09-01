import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { getVolumeMetrics } from '../src/agent/services/analyticsService.ts'
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

    const result = await getVolumeMetrics({ agentId: 'unused', workspaceId }, RANGE)

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

    const result = await getVolumeMetrics({ agentId: 'unused', workspaceId: workspaceA }, RANGE)

    expect(result.openTotal).toBe(0)
  })

  it('counts opened conversations per bucket from createdAt within range', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await seedConversation({ workspaceId, playerId, status: 'open', createdAt: new Date('2026-08-05T10:00:00Z') })
    await seedConversation({ workspaceId, playerId, status: 'open', createdAt: new Date('2026-08-05T14:00:00Z') })

    const result = await getVolumeMetrics({ agentId: 'unused', workspaceId }, RANGE)

    expect(result.series).toEqual(expect.arrayContaining([expect.objectContaining({ bucket: '2026-08-05', opened: 2 })]))
  })
})
