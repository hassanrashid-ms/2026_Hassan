import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { getEnv } from '../src/env.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { appendChangeLog } from '../src/shared/changeLog/appendChangeLog.ts'
import { closeOwnerPool, ownerPool, seedAgent, seedWorkspace, truncateAll } from './helpers/db.ts'

let workspaceId: string
let otherWorkspaceId: string
let actorId: string

type Row = {
  field: string
  before_value: unknown
  after_value: unknown
  actor_id: string
  entity_type: string
  entity_id: string
  changed_at: Date
}

async function rows(ws = workspaceId): Promise<Row[]> {
  const { rows } = await ownerPool.query<Row>(
    `select field, before_value, after_value, actor_id, entity_type, entity_id, changed_at
       from change_log where workspace_id = $1 order by field`,
    [ws],
  )
  return rows
}

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  workspaceId = await seedWorkspace()
  otherWorkspaceId = await seedWorkspace()
  actorId = await seedAgent()
})

describe('appendChangeLog', () => {
  it('writes one row per changed field, all sharing the transaction timestamp', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: true },
          { field: 'prompt', before: null, after: 'be helpful' },
        ],
      }),
    )

    const written = await rows()
    expect(written.map((r) => r.field)).toEqual(['is_provisioned', 'prompt'])
    expect(written.every((r) => r.actor_id === actorId)).toBe(true)
    expect(written.every((r) => r.entity_type === 'bot_config')).toBe(true)
    expect(written.every((r) => r.entity_id === workspaceId)).toBe(true)
    // now() is transaction start time in Postgres, so one insert shares one stamp.
    expect(written[0]?.changed_at.getTime()).toBe(written[1]?.changed_at.getTime())
  })

  it('drops no-ops, and writes nothing at all when every change is a no-op', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: true, after: true },
          { field: 'prompt', before: 'same', after: 'same' },
        ],
      }),
    )
    expect(await rows()).toHaveLength(0)

    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'is_provisioned', before: false, after: false },
          { field: 'prompt', before: null, after: 'new' },
        ],
      }),
    )
    expect((await rows()).map((r) => r.field)).toEqual(['prompt'])
  })

  it('compares deeply, so an equal object is a no-op and a changed one is not', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'shape', before: { a: [1, 2] }, after: { a: [1, 2] } }],
      }),
    )
    expect(await rows()).toHaveLength(0)

    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'shape', before: { a: [1, 2] }, after: { a: [1, 3] } }],
      }),
    )
    expect(await rows()).toHaveLength(1)
  })

  it('keeps the two nulls distinct: unset-before is not the same fact as cleared-after', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'prompt', before: null, after: 'first ever' }],
      }),
    )
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [{ field: 'prompt', before: 'first ever', after: null }],
      }),
    )

    const { rows: history } = await ownerPool.query<Row>(
      `select field, before_value, after_value from change_log
        where workspace_id = $1 order by id`,
      [workspaceId],
    )
    expect(history[0]).toMatchObject({ before_value: null, after_value: 'first ever' })
    expect(history[1]).toMatchObject({ before_value: 'first ever', after_value: null })
  })

  it('treats an undefined value as null rather than dropping the column', async () => {
    await withWorkspace(workspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId,
        entityType: 'bot_config',
        entityId: workspaceId,
        actorId,
        changes: [
          { field: 'prompt', before: undefined, after: 'set' },
          { field: 'is_provisioned', before: undefined, after: undefined },
        ],
      }),
    )
    const written = await rows()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ field: 'prompt', before_value: null, after_value: 'set' })
  })

  it('refuses an actor that is not a real agent — attribution is enforced by the FK', async () => {
    // drizzle-orm's node-postgres driver wraps the underlying pg error in a
    // DrizzleQueryError ("Failed query: ...") and preserves the real message
    // on `.cause` rather than in `.message` — check both.
    let caught: unknown
    try {
      await withWorkspace(workspaceId, (tx) =>
        appendChangeLog(tx, {
          workspaceId,
          entityType: 'bot_config',
          entityId: workspaceId,
          actorId: randomUUID(),
          changes: [{ field: 'prompt', before: null, after: 'x' }],
        }),
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error & { cause?: unknown }
    const message = `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}`
    expect(message).toMatch(/foreign key|violates/i)
    expect(await rows()).toHaveLength(0)
  })

  it('reads back newest-first for one entity, and never across the tenant boundary', async () => {
    for (const [before, after] of [[null, 'one'], ['one', 'two']] as const) {
      await withWorkspace(workspaceId, (tx) =>
        appendChangeLog(tx, {
          workspaceId,
          entityType: 'bot_config',
          entityId: workspaceId,
          actorId,
          changes: [{ field: 'prompt', before, after }],
        }),
      )
    }
    await withWorkspace(otherWorkspaceId, (tx) =>
      appendChangeLog(tx, {
        workspaceId: otherWorkspaceId,
        entityType: 'bot_config',
        entityId: otherWorkspaceId,
        actorId,
        changes: [{ field: 'prompt', before: null, after: 'theirs' }],
      }),
    )

    const visible = await withWorkspace(workspaceId, async (tx) => {
      const result = await tx.execute(
        `select after_value from change_log
          where entity_type = 'bot_config' and entity_id = '${workspaceId}'
          order by changed_at desc, id desc`,
      )
      return result.rows as Array<{ after_value: unknown }>
    })
    expect(visible.map((r) => r.after_value)).toEqual(['two', 'one'])
  })
})

describe('the change_log CHECK constraint', () => {
  let app: Client

  // beforeAll, not beforeEach: a new Client per test would leak connections,
  // because a single afterAll can only end the last one.
  beforeAll(async () => {
    app = new Client({ connectionString: getEnv().DATABASE_URL })
    await app.connect()
  })

  afterAll(async () => {
    await app.end()
  })

  it('refuses a no-op row inserted directly, so a bug in the writer cannot pollute the trail', async () => {
    await app.query('begin')
    await app.query(`select set_config('app.workspace_id', $1, true)`, [workspaceId])
    await expect(
      app.query(
        `insert into change_log (workspace_id, entity_type, entity_id, field, before_value, after_value, actor_id)
         values ($1, 'bot_config', $1, 'prompt', '"same"'::jsonb, '"same"'::jsonb, $2)`,
        [workspaceId, actorId],
      ),
    ).rejects.toThrow(/change_log_value_changed|check constraint/i)
    await app.query('rollback')
  })
})
