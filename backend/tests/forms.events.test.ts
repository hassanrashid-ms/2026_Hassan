import { createServer } from 'node:http'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormField } from '@support/types'
import { req as request } from './helpers/http.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts'
import { formRouter } from '../src/surface/routers/formRouter.ts'
import * as appendEventModule from '../src/shared/events/appendEvent.ts'
import { mintToken } from './helpers/app.ts'
import {
  closeOwnerPool,
  ownerPool,
  seedAgent,
  seedConversation,
  seedForm,
  seedFormSubmission,
  seedFormVersion,
  seedPlayer,
  seedSession,
  seedWorkspace,
  seedWorkspaceMember,
  truncateAll,
} from './helpers/db.ts'

const FIELDS: FormField[] = [
  {
    key: 'store',
    label: 'Store',
    type: 'choice',
    isRequired: true,
    position: 0,
    options: ['Apple App Store', 'Google Play'],
  },
  { key: 'quantity', label: 'Quantity', type: 'number', isRequired: false, position: 1 },
  { key: 'proof', label: 'Proof', type: 'attachment', isRequired: false, position: 2 },
]

const app = express()
app.use(express.json())
app.use(requirePlayerToken, formRouter)
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
afterEach(() => vi.restoreAllMocks())

async function liveForm() {
  const workspaceId = await seedWorkspace()
  const agentId = await seedAgent()
  await seedWorkspaceMember({ workspaceId, agentId })
  const playerId = await seedPlayer(workspaceId)
  const conversationId = await seedConversation({ workspaceId, playerId })
  await ownerPool.query(`update conversation set confirm_phase = 'form' where id = $1`, [conversationId])
  const formId = await seedForm({ workspaceId })
  await seedFormVersion({ workspaceId, formId, version: 1, fields: FIELDS, publishedAt: new Date() })
  const submissionId = await seedFormSubmission({ workspaceId, conversationId, formId, formVersion: 1 })
  await ownerPool.query(
    `insert into event (workspace_id, type, conversation_id, actor_type, payload)
     values ($1, 'form_offered', $2, 'bot', $3::jsonb)`,
    [
      workspaceId,
      conversationId,
      JSON.stringify({ form_id: formId, form_version: 1, field_count: 3, handoff_reason: 'no_article' }),
    ],
  )
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p-1' })
  return { workspaceId, agentId, playerId, conversationId, submissionId, formId, token }
}

function answer(f: Awaited<ReturnType<typeof liveForm>>, key: string, value: unknown, sessionId?: string) {
  return request(app)
    .post('/form/answer')
    .set('Authorization', `Bearer ${f.token}`)
    .send({ field_key: key, value, ...(sessionId ? { session_id: sessionId } : {}) })
}

describe('form events', () => {
  it('writes one form_field_answered per accepted answer, in position order, with no answer value', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'quantity', 3)

    const { rows } = await ownerPool.query(
      `select payload from event where type = 'form_field_answered' order by id`,
    )
    expect(rows).toHaveLength(2)
    // Exact key set, not a subset. A later change that adds `value` fails here
    // rather than quietly leaking player-written text into `event`.
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(
      ['field_key', 'field_type', 'form_id', 'is_correction', 'position'].sort(),
    )
    expect(rows.map((r) => r.payload.position)).toEqual([0, 1])
    expect(rows[0]!.payload).toMatchObject({ field_key: 'store', field_type: 'choice', is_correction: false })
  })

  it('sets is_correction on the second answer for a field and not the first', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'store', 'Apple App Store')
    const { rows } = await ownerPool.query(
      `select payload from event where type = 'form_field_answered' order by id`,
    )
    expect(rows.map((r) => r.payload.is_correction)).toEqual([false, true])
  })

  it('writes neither an event nor an answer row for a rejected answer', async () => {
    const f = await liveForm()
    const res = await answer(f, 'store', 'Steam')
    expect(res.status).toBe(422)
    const events = await ownerPool.query(`select 1 from event where type = 'form_field_answered'`)
    const answers = await ownerPool.query(`select 1 from form_answer`)
    expect(events.rowCount).toBe(0)
    expect(answers.rowCount).toBe(0)
  })

  it('snapshots position from the submission version, not the current one', async () => {
    const f = await liveForm()
    // v2 reorders the fields. The live submission still points at v1.
    await seedFormVersion({
      workspaceId: f.workspaceId,
      formId: f.formId,
      version: 2,
      fields: [
        { key: 'quantity', label: 'Quantity', type: 'number', isRequired: false, position: 0 },
        {
          key: 'store',
          label: 'Store',
          type: 'choice',
          isRequired: true,
          position: 1,
          options: ['Apple App Store', 'Google Play'],
        },
      ],
      publishedAt: new Date(),
    })
    await answer(f, 'store', 'Google Play')
    const { rows } = await ownerPool.query(`select payload from event where type = 'form_field_answered'`)
    expect(rows[0]!.payload.position).toBe(0)
  })

  it('stamps session_id when the session is verified', async () => {
    const f = await liveForm()
    const sessionId = await seedSession({ workspaceId: f.workspaceId, playerId: f.playerId })
    await answer(f, 'store', 'Google Play', sessionId)
    const { rows } = await ownerPool.query(`select session_id from event where type = 'form_field_answered'`)
    expect(rows[0]!.session_id).toBe(sessionId)
  })

  it('degrades session_id to null on a miss without rejecting the answer', async () => {
    const f = await liveForm()
    const otherWorkspace = await seedWorkspace()
    const otherPlayer = await seedPlayer(otherWorkspace)
    const foreign = await seedSession({ workspaceId: otherWorkspace, playerId: otherPlayer })
    const res = await answer(f, 'store', 'Google Play', foreign)
    expect(res.status).toBe(200)
    const { rows } = await ownerPool.query(`select session_id from event where type = 'form_field_answered'`)
    expect(rows[0]!.session_id).toBeNull()
  })

  it('rolls the answer row back when appendEvent fails', async () => {
    // The same assertion changeLog.test.ts makes, through a real transaction
    // rather than a mock: a row without its event, or an event without its row,
    // is exactly the divergence appendEvent exists to prevent.
    const f = await liveForm()
    const spy = vi.spyOn(appendEventModule, 'appendEvent').mockRejectedValueOnce(new Error('boom'))
    const res = await answer(f, 'store', 'Google Play')
    expect(res.status).toBeGreaterThanOrEqual(500)
    const answers = await ownerPool.query(`select 1 from form_answer`)
    expect(answers.rowCount).toBe(0)
    spy.mockRestore()
  })

  it('answered_count counts distinct keys, not events, when a field was corrected', async () => {
    const f = await liveForm()
    await answer(f, 'store', 'Google Play')
    await answer(f, 'store', 'Apple App Store')
    await request(app).post('/form/submit').set('Authorization', `Bearer ${f.token}`).send({})
    const { rows } = await ownerPool.query(`select payload from event where type = 'form_completed'`)
    expect(rows[0]!.payload.answered_count).toBe(1)
    const events = await ownerPool.query(`select 1 from event where type = 'form_field_answered'`)
    expect(events.rowCount).toBe(2)
  })
})
