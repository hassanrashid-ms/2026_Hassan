import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { assignOnHandoff } from '../src/domain/bot/assignOnHandoff.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

beforeEach(truncateAll)
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

async function assignConversationTo(conversationId: string, agentId: string, status = 'open'): Promise<void> {
  await ownerPool.query(`update conversation set assigned_agent_id = $2, status = $3 where id = $1`, [
    conversationId,
    agentId,
    status,
  ])
}

describe('assignOnHandoff', () => {
  it('picks the active member with fewest live-status conversations', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const busyAgent = await seedAgent()
    const idleAgent = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: busyAgent })
    await seedWorkspaceMember({ workspaceId, agentId: idleAgent })

    const busyConvo = await seedConversation({ workspaceId, playerId })
    await assignConversationTo(busyConvo, busyAgent, 'open')

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(idleAgent)
  })

  it('breaks ties by agent.id ascending', async () => {
    const workspaceId = await seedWorkspace()
    const agentLow = await seedAgent('a-low@example.test')
    const agentHigh = await seedAgent('a-high@example.test')
    await seedWorkspaceMember({ workspaceId, agentId: agentLow })
    await seedWorkspaceMember({ workspaceId, agentId: agentHigh })

    const [lo, hi] = [agentLow, agentHigh].sort()
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(lo)
    expect(result).not.toBe(hi)
  })

  it('skips a deactivated workspace member', async () => {
    const workspaceId = await seedWorkspace()
    const deactivated = await seedAgent()
    const active = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: deactivated, deactivatedAt: new Date() })
    await seedWorkspaceMember({ workspaceId, agentId: active })

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(active)
  })

  it('skips an agent whose status is not active', async () => {
    const workspaceId = await seedWorkspace()
    const onLeave = await seedAgent()
    const active = await seedAgent()
    await ownerPool.query(`update agent set status = 'on_leave' where id = $1`, [onLeave])
    await seedWorkspaceMember({ workspaceId, agentId: onLeave })
    await seedWorkspaceMember({ workspaceId, agentId: active })

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(active)
  })

  it('includes admins and team leads', async () => {
    const workspaceId = await seedWorkspace()
    const admin = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: admin, role: 'admin' })

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(admin)
  })

  it('returns null, not an error, when no active agent exists', async () => {
    const workspaceId = await seedWorkspace()
    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBeNull()
  })

  it('never picks an agent from another workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const agentB = await seedAgent()
    await seedWorkspaceMember({ workspaceId: workspaceB, agentId: agentB })

    const result = await withWorkspace(workspaceA, (tx) => assignOnHandoff(tx, workspaceA))
    expect(result).toBeNull()
  })

  it('only counts open, awaiting_player, escalated as live — not resolved or closed', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const agentA = await seedAgent()
    const agentB = await seedAgent()
    await seedWorkspaceMember({ workspaceId, agentId: agentA })
    await seedWorkspaceMember({ workspaceId, agentId: agentB })

    // agentA has two RESOLVED conversations — should not count against them.
    const c1 = await seedConversation({ workspaceId, playerId })
    const c2 = await seedConversation({ workspaceId, playerId })
    await assignConversationTo(c1, agentA, 'resolved')
    await assignConversationTo(c2, agentA, 'closed')

    // agentB has one OPEN conversation — should count.
    const c3 = await seedConversation({ workspaceId, playerId })
    await assignConversationTo(c3, agentB, 'open')

    const result = await withWorkspace(workspaceId, (tx) => assignOnHandoff(tx, workspaceId))
    expect(result).toBe(agentA)
  })
})
