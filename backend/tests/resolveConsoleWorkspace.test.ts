import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { resolveConsoleWorkspace } from '../src/shared/middleware/resolveConsoleWorkspace.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { conversationsRouter } from '../src/agent/routers/conversationsRouter.ts'
import { messagesRouter } from '../src/agent/routers/messagesRouter.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

// Mirrors the real agentRouter's middleware order (requireAgentSession, then
// resolveConsoleWorkspace, then the routers) — see
// 2026-08-21-superadmin-workspace-console-access-design.md.
const app = express()
app.use(express.json())
app.use(requireAgentSession, resolveConsoleWorkspace, conversationsRouter, messagesRouter)
app.use(errorMiddleware)

beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

// claimConversation only matches ACTIVE_AGENT_STATUSES ('open' | 'awaiting_player' |
// 'escalated') — 'bot_active' is take-over territory, not claim territory.
async function claimableConversation(workspaceId: string): Promise<string> {
  const playerId = await seedPlayer(workspaceId)
  return seedConversation({ workspaceId, playerId, status: 'open' })
}

describe('resolveConsoleWorkspace', () => {
  it('lets an admin claim a conversation in a workspace they hold no membership in, via X-Workspace-Id', async () => {
    const workspaceId = await seedWorkspace()
    const conversationId = await claimableConversation(workspaceId)
    const adminId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: adminId, is_admin: true })

    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200)

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationId],
    )
    // The real admin's own agent_id, not a placeholder or null — no ghost author.
    expect(rows[0]!.assigned_agent_id).toBe(adminId)
  })

  it('404s an admin session with no X-Workspace-Id header', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: adminId, is_admin: true })

    await request(app).get('/conversations?status=mine').set('Authorization', `Bearer ${token}`).expect(404)
  })

  it('404s an admin session whose X-Workspace-Id is not a valid uuid', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: adminId, is_admin: true })

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', 'not-a-uuid')
      .expect(404)
  })

  it('404s an admin session whose X-Workspace-Id names a workspace that does not exist', async () => {
    const adminId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: adminId, is_admin: true })

    await request(app)
      .get('/conversations?status=mine')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', randomUUID())
      .expect(404)
  })

  it('ignores X-Workspace-Id entirely for a regular agent session — their own JWT workspace wins', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const conversationInA = await claimableConversation(workspaceA)
    const agentId = await seedAgent()
    await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
      workspaceA,
      agentId,
    ])
    const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceA })

    // Header names workspace B; the claim must still land against workspace A's
    // conversation, proving the header had no effect on a non-admin session.
    await request(app)
      .post(`/conversations/${conversationInA}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceB)
      .expect(200)

    const { rows } = await ownerPool.query<{ assigned_agent_id: string | null }>(
      `select assigned_agent_id from conversation where id = $1`,
      [conversationInA],
    )
    expect(rows[0]!.assigned_agent_id).toBe(agentId)
  })

  it('attributes a message posted by an admin, in a workspace they are not a member of, to the admin — no ghost author', async () => {
    const workspaceId = await seedWorkspace()
    const conversationId = await claimableConversation(workspaceId)
    const adminId = await seedAgent(undefined, { isAdmin: true })
    const token = await signAgentSession({ agent_id: adminId, is_admin: true })

    // Sending a message requires the conversation to already be assigned to
    // the sender, so claim it first — same admin flow, same header.
    await request(app)
      .post(`/conversations/${conversationId}/claim`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200)

    await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ conversation_id: conversationId, body: 'checking in', visibility: 'internal' })
      .expect(200)

    const { rows } = await ownerPool.query<{ author_agent_id: string | null }>(
      `select author_agent_id from message where conversation_id = $1`,
      [conversationId],
    )
    expect(rows[0]!.author_agent_id).toBe(adminId)
  })
})
