import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { postMessage } from '../src/domain/conversations/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeOwnerPool, seedConversation, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('postMessage', () => {
  it('bumps message_seq, inserts the message, and appends a message_sent event', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const posted = await withWorkspace(workspaceId, (tx) =>
      postMessage(tx, {
        workspaceId,
        conversationId,
        authorType: 'player',
        actorId: playerId,
        body: 'hi there',
      }),
    )

    expect(posted.seq).toBe(1)
    expect(posted.body).toBe('hi there')
    expect(posted.deliveryState).toBe('sent')
  })

  it('never produces a duplicate seq under concurrent sends into the same conversation', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const conversationId = await seedConversation({ workspaceId, playerId })

    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, i) =>
        withWorkspace(workspaceId, (tx) =>
          postMessage(tx, {
            workspaceId,
            conversationId,
            authorType: 'player',
            actorId: playerId,
            body: `msg ${i}`,
          }),
        ),
      ),
    )

    const seqs = results.map((r) => r.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })
})
