import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeEach } from 'vitest'
import { agentRouter } from '../src/agent/router.ts'
import {
  seedAgent,
  seedWorkspace,
  truncateAll,
} from './helpers/db.ts'
import { ownerPool } from './helpers/db.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'

async function setupAgent(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

const app = express()
app.use(express.json())
app.use('/agent', agentRouter)

describe('GET /agent/agents', () => {
  beforeEach(async () => {
    await truncateAll()
  })

  it('lists agents in the workspace', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId, token } = await setupAgent(workspaceId)
    
    // Create a second agent in the workspace
    const agent2Id = await seedAgent('agent2@example.test')
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceId,
      agent2Id,
    ])

    // Create a third agent NOT in the workspace
    await seedAgent('agent3@example.test')

    const res = await request(app)
      .get('/agent/agents')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    expect(res.body.agents).toHaveLength(2)
    const agentIds = res.body.agents.map((a: any) => a.id).sort()
    const expectedIds = [agentId, agent2Id].sort()
    expect(agentIds).toEqual(expectedIds)
    
    const agent2 = res.body.agents.find((a: any) => a.id === agent2Id)
    expect(agent2).toMatchObject({
      display_name: 'Test Agent',
      email: 'agent2@example.test',
      role: 'agent',
    })
  })
})
