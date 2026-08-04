import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { getEnv } from '../src/env.ts'
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts'

let app: Client
const WS_A = '11111111-1111-1111-1111-111111111111'
const WS_B = '22222222-2222-2222-2222-222222222222'
const PLAYER_A = 'aaaaaaaa-1111-1111-1111-111111111111'
const PLAYER_B = 'bbbbbbbb-2222-2222-2222-222222222222'

beforeAll(async () => {
  app = new Client({ connectionString: getEnv().DATABASE_URL })
  await app.connect()
})

afterAll(async () => {
  await app.end()
  await closeOwnerPool()
})

beforeEach(async () => {
  await truncateAll()
  for (const [id, slug] of [[WS_A, 'game-a'], [WS_B, 'game-b']] as const) {
    await ownerPool.query(
      `insert into workspace (id, name, slug, secret_hash) values ($1, $2, $3, 'x')`,
      [id, slug, slug],
    )
  }
  for (const [player, ws, ext] of [[PLAYER_A, WS_A, 'p-a'], [PLAYER_B, WS_B, 'p-b']] as const) {
    await ownerPool.query(
      `insert into player (id, workspace_id, external_id) values ($1, $2, $3)`,
      [player, ws, ext],
    )
  }
})

async function asWorkspace<T>(id: string | null, fn: () => Promise<T>): Promise<T> {
  await app.query('begin')
  try {
    if (id !== null) await app.query(`select set_config('app.workspace_id', $1, true)`, [id])
    const result = await fn()
    await app.query('commit')
    return result
  } catch (error) {
    await app.query('rollback')
    throw error
  }
}

describe('row-level security', () => {
  it('hides another workspace rows entirely', async () => {
    const rows = await asWorkspace(WS_A, async () => (await app.query('select id from player')).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(PLAYER_A)
  })

  it('returns zero rows when no workspace is set — there is no code path around it', async () => {
    const rows = await asWorkspace(null, async () => (await app.query('select id from player')).rows)
    expect(rows).toHaveLength(0)
  })

  it('refuses a write that claims another workspace', async () => {
    await expect(
      asWorkspace(WS_A, () =>
        app.query(`insert into player (workspace_id, external_id) values ($1, 'smuggled')`, [WS_B]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('cannot update or delete an event — the spine is append-only', async () => {
    await ownerPool.query(
      `insert into event (workspace_id, type, actor_type) values ($1, 'session_start', 'player')`,
      [WS_A],
    )
    await expect(
      asWorkspace(WS_A, () => app.query(`update event set type = 'tampered'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(asWorkspace(WS_A, () => app.query('delete from event'))).rejects.toThrow(/permission denied/i)
  })

  it('grants DELETE on nothing at all — no hard deletes anywhere', async () => {
    for (const table of ['player', 'session', 'conversation', 'message', 'player_state_snapshot']) {
      await expect(
        asWorkspace(WS_A, () => app.query(`delete from ${table}`)),
        `delete from ${table}`,
      ).rejects.toThrow(/permission denied/i)
    }
  })

  it('has no DDL rights — the app role can never alter the schema', async () => {
    await expect(asWorkspace(WS_A, () => app.query('create table sneaky (id int)'))).rejects.toThrow(
      /permission denied/i,
    )
  })

  it('forces the policy even for the table owner', async () => {
    const { rows } = await ownerPool.query<{ relforcerowsecurity: boolean; relname: string }>(
      `select relname, relforcerowsecurity from pg_class
        where relname in ('player','session','player_state_snapshot','declared_field',
                          'conversation','message','event')`,
    )
    expect(rows).toHaveLength(7)
    for (const row of rows) expect(row.relforcerowsecurity, row.relname).toBe(true)
  })

  it('leaves workspace and agent unscoped — they are the only two', async () => {
    const { rows } = await ownerPool.query<{ relname: string }>(
      `select relname from pg_class where relrowsecurity = true and relkind = 'r'`,
    )
    const scoped = rows.map((r) => r.relname).sort()
    expect(scoped).not.toContain('workspace')
    expect(scoped).not.toContain('agent')
    expect(scoped).toHaveLength(8) // workspace_member + the 7 above
  })
})
