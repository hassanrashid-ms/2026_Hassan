import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { resolveFallbackSubintent } from '../src/domain/bot/fallbackSubintent.ts'
import { intent, subintent } from '../src/shared/db/schema/index.ts'
import { closeOwnerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

beforeEach(truncateAll)
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

describe('resolveFallbackSubintent', () => {
  it('resolves the seeded Other/Other pair', async () => {
    const workspaceId = await seedWorkspace()
    await withWorkspace(workspaceId, async (tx) => {
      const [other] = await tx.insert(intent).values({ workspaceId, name: 'Other', isSystem: true }).returning({ id: intent.id })
      await tx.insert(subintent).values({ workspaceId, intentId: other!.id, name: 'Other' })
    })

    const id = await withWorkspace(workspaceId, (tx) => resolveFallbackSubintent(tx, workspaceId))
    expect(id).toBeTypeOf('string')
  })

  it('throws when Other has not been seeded for this workspace', async () => {
    const workspaceId = await seedWorkspace()
    await expect(withWorkspace(workspaceId, (tx) => resolveFallbackSubintent(tx, workspaceId))).rejects.toThrow(/Other/)
  })
})
