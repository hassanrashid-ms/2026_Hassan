import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { FormField } from '@support/types'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { conversation, event, formSubmission, message } from '../src/shared/db/schema/index.ts'
import { completeFormAndHandoff } from '../src/domain/forms/completeFormAndHandoff.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormAnswer,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

const FIELDS: FormField[] = [
  { key: 'a', label: 'A', type: 'short_text', isRequired: true, position: 0 },
  { key: 'b', label: 'B', type: 'short_text', isRequired: false, position: 1 },
  { key: 'c', label: 'C', type: 'short_text', isRequired: false, position: 2 },
  { key: 'd', label: 'D', type: 'short_text', isRequired: false, position: 3 },
]

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function offered(answers: string[]) {
  const workspaceId = await seedWorkspace()
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [conversationId])
  const formId = await seedForm({ workspaceId })
  await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: new Date() })
  const submissionId = await seedFormSubmission({ workspaceId, conversationId, formId, formVersion: 1 })
  // The offer event the terminate step reads the handoff reason back out of.
  await ownerPool.query(
    `insert into event (workspace_id, type, conversation_id, actor_type, payload)
     values ($1, 'form_offered', $2, 'bot', $3::jsonb)`,
    [
      workspaceId,
      conversationId,
      JSON.stringify({ form_id: formId, form_version: 1, field_count: 4, handoff_reason: 'no_article' }),
    ],
  )
  for (const key of answers) {
    await seedFormAnswer({ workspaceId, formSubmissionId: submissionId, fieldKey: key, fieldType: 'short_text', value: 'x' })
  }
  return { workspaceId, agentId, playerId, conversationId, submissionId }
}

function terminate(f: Awaited<ReturnType<typeof offered>>, by: 'submit' | 'skip' | 'timeout') {
  return withWorkspace(f.workspaceId, (tx) =>
    completeFormAndHandoff(
      tx,
      {
        workspaceId: f.workspaceId,
        conversationId: f.conversationId,
        submissionId: f.submissionId,
        actorType: by === 'timeout' ? 'system' : 'player',
        actorId: by === 'timeout' ? null : f.playerId,
        sessionId: null,
      },
      by,
    ),
  )
}

describe('completeFormAndHandoff', () => {
  it('derives completed when every field has an answer', async () => {
    const f = await offered(['a', 'b', 'c', 'd'])
    const result = await terminate(f, 'submit')
    expect(result!.formStatus).toBe('completed')
    expect(result!.answeredCount).toBe(4)
    expect(result!.fieldCount).toBe(4)
  })

  it('derives partial when some fields are answered and keeps the answers', async () => {
    const f = await offered(['a', 'b'])
    const result = await terminate(f, 'skip')
    expect(result!.formStatus).toBe('partial')
    expect(result!.answeredCount).toBe(2)
    const rows = await withWorkspace(f.workspaceId, (tx) => tx.select().from(formSubmission))
    expect(rows[0]!.status).toBe('partial')
    const { rows: answers } = await ownerPool.query(`select field_key from form_answer order by field_key`)
    expect(answers.map((r) => r.field_key)).toEqual(['a', 'b'])
  })

  it('derives skipped when there are no answers at all', async () => {
    const f = await offered([])
    const result = await terminate(f, 'skip')
    expect(result!.formStatus).toBe('skipped')
    expect(result!.answeredCount).toBe(0)
  })

  it('counts distinct field keys, not answer rows, when a field was corrected', async () => {
    const f = await offered(['a', 'a', 'b'])
    const result = await terminate(f, 'submit')
    expect(result!.answeredCount).toBe(2)
    expect(result!.formStatus).toBe('partial')
  })

  it('assigns an agent, opens the conversation and clears the phase', async () => {
    const f = await offered(['a', 'b', 'c', 'd'])
    await terminate(f, 'submit')
    const [conv] = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(conversation).where(eq(conversation.id, f.conversationId)),
    )
    expect(conv!.status).toBe('open')
    expect(conv!.confirmPhase).toBe('none')
    expect(conv!.assignedAgentId).toBe(f.agentId)
  })

  it('writes exactly one bot_handoff carrying the reason from the offer, and one form_completed', async () => {
    const f = await offered(['a'])
    await terminate(f, 'timeout')
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    )
    const handoffs = events.filter((e) => e.type === 'bot_handoff')
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.payload).toEqual({ reason: 'no_article', assigned_agent_id: f.agentId })
    const completed = events.filter((e) => e.type === 'form_completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]!.actorType).toBe('system')
    expect(completed[0]!.actorId).toBeNull()
    expect(completed[0]!.payload).toEqual({
      status: 'partial',
      terminated_by: 'timeout',
      answered_count: 1,
      field_count: 4,
    })
  })

  it('posts exactly one non-empty summary card and no other message', async () => {
    const f = await offered([])
    await terminate(f, 'skip')
    const rows = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(message).where(eq(message.conversationId, f.conversationId)),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.authorType).toBe('system')
    expect(rows[0]!.visibility).toBe('public')
    expect(rows[0]!.body.trim().length).toBeGreaterThan(0)
  })

  it('returns null on a second call and writes nothing the second time', async () => {
    const f = await offered(['a'])
    await terminate(f, 'submit')
    const second = await terminate(f, 'skip')
    expect(second).toBeNull()
    const events = await withWorkspace(f.workspaceId, (tx) =>
      tx.select().from(event).where(eq(event.conversationId, f.conversationId)),
    )
    expect(events.filter((e) => e.type === 'bot_handoff')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'form_completed')).toHaveLength(1)
  })
})
