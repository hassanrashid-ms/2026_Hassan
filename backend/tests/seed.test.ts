import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seed } from '../src/shared/db/seed.ts'
import { intent } from '../src/shared/db/schema/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts'

const SLUG = process.env.SEED_WORKSPACE_SLUG ?? 'demo-workspace'

beforeEach(truncateAll)
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

async function workspaceIdBySlug(slug: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(`select id from workspace where slug = $1`, [slug])
  if (!rows[0]) throw new Error(`seed did not create a workspace with slug ${slug}`)
  return rows[0].id
}

describe('seed', () => {
  it('seeds exactly one is_system intent named Other, and re-running does not duplicate it', async () => {
    await seed()
    await seed()

    const workspaceId = await workspaceIdBySlug(SLUG)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: intent.id })
        .from(intent)
        .where(and(eq(intent.workspaceId, workspaceId), eq(intent.isSystem, true), eq(intent.name, 'Other'))),
    )
    expect(rows).toHaveLength(1)
  })
})
