import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts'
import { readChangeLog } from '../src/shared/changeLog/readChangeLog.ts'
import { decodeChangeLogCursor } from '../src/shared/changeLog/cursor.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

const ENTITY = 'bot_config'

/** Two saves' worth of audit rows, written in two transactions so changed_at differs. */
async function seedTrail(workspaceId: string, actorId: string): Promise<void> {
  await withWorkspace(workspaceId, (tx) =>
    appendChangeLog(tx, {
      workspaceId,
      entityType: ENTITY,
      entityId: workspaceId,
      actorId,
      changes: [
        { field: 'is_provisioned', before: false, after: true },
        { field: 'prompt', before: null, after: 'First prompt' },
      ],
    }),
  )
  await withWorkspace(workspaceId, (tx) =>
    appendChangeLog(tx, {
      workspaceId,
      entityType: ENTITY,
      entityId: workspaceId,
      actorId,
      changes: [{ field: 'prompt', before: 'First prompt', after: null }],
    }),
  )
}

describe('readChangeLog', () => {
  it('returns newest first, with the actor joined and the id as a string', async () => {
    const workspaceId = await seedWorkspace()
    const actorId = await seedAgent('auditor@example.test')
    await seedTrail(workspaceId, actorId)

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    )

    expect(page.rows).toHaveLength(3)
    expect(page.rows[0]!.field).toBe('prompt')
    expect(page.rows[0]!.beforeValue).toBe('First prompt')
    expect(page.rows[0]!.afterValue).toBeNull()
    expect(typeof page.rows[0]!.id).toBe('string')
    expect(page.rows[0]!.actor).toEqual({ id: actorId, displayName: 'Test Agent', email: 'auditor@example.test' })
    expect(page.nextCursor).toBeNull()
  })

  // The bug this guards: change_log.id is a bigserial mapped as a JS bigint, and
  // JSON.stringify throws on a bigint. A service returning it raw would 500.
  it('produces a page that JSON.stringify can serialise', async () => {
    const workspaceId = await seedWorkspace()
    const actorId = await seedAgent()
    await seedTrail(workspaceId, actorId)

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    )

    expect(() => JSON.stringify(page)).not.toThrow()
  })

  it('pages with the cursor and never repeats or skips a row', async () => {
    const workspaceId = await seedWorkspace()
    const actorId = await seedAgent()
    await seedTrail(workspaceId, actorId)

    const first = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 2 }),
    )
    expect(first.rows).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    const cursor = decodeChangeLogCursor(first.nextCursor!)!
    const second = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 2, cursor }),
    )

    expect(second.rows).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    const ids = [...first.rows, ...second.rows].map((row) => row.id)
    expect(new Set(ids).size).toBe(3)
  })

  // changed_at is transaction start time, so both rows from one save share it.
  // A cursor on changed_at alone would drop the second one.
  it('pages correctly through rows that share one changed_at', async () => {
    const workspaceId = await seedWorkspace()
    const actorId = await seedAgent()
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: true },
          { field: 'prompt', before: null, after: 'p' },
          { field: 'rules', before: null, after: 'r' },
        ],
      }),
    )

    const first = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 1 }),
    )
    const second = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, {
        workspaceId,
        entityType: ENTITY,
        entityId: workspaceId,
        limit: 5,
        cursor: decodeChangeLogCursor(first.nextCursor!)!,
      }),
    )

    expect(second.rows).toHaveLength(2)
    expect(first.rows[0]!.changedAt.getTime()).toBe(second.rows[0]!.changedAt.getTime())
    expect(second.rows.map((row) => row.id)).not.toContain(first.rows[0]!.id)
  })

  it('sees nothing from another workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const actorId = await seedAgent()
    await seedTrail(workspaceB, actorId)

    const page = await withWorkspace(workspaceA, (tx) =>
      readChangeLog(tx, { workspaceId: workspaceA, entityType: ENTITY, entityId: workspaceB, limit: 50 }),
    )

    expect(page.rows).toEqual([])
  })

  it('filters by entity_type and entity_id', async () => {
    const workspaceId = await seedWorkspace()
    const actorId = await seedAgent()
    await seedTrail(workspaceId, actorId)

    const wrongType = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: 'form', entityId: workspaceId, limit: 50 }),
    )
    expect(wrongType.rows).toEqual([])

    const wrongEntity = await withWorkspace(workspaceId, async (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: await seedWorkspace(), limit: 50 }),
    )
    expect(wrongEntity.rows).toEqual([])
  })

  it('returns an empty page and a null cursor when nothing was ever changed', async () => {
    const workspaceId = await seedWorkspace()
    await ownerPool.query('select 1')

    const page = await withWorkspace(workspaceId, (tx) =>
      readChangeLog(tx, { workspaceId, entityType: ENTITY, entityId: workspaceId, limit: 50 }),
    )

    expect(page).toEqual({ rows: [], nextCursor: null })
  })
})
