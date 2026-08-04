import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ownerPool, closeOwnerPool } from './helpers/db.ts'

const EXPECTED_TABLES = [
  'agent',
  'conversation',
  'declared_field',
  'event',
  'message',
  'player',
  'player_state_snapshot',
  'session',
  'workspace',
  'workspace_member',
]

async function columns(table: string): Promise<Map<string, { type: string; nullable: boolean; hasDefault: boolean }>> {
  const { rows } = await ownerPool.query<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  )
  return new Map(
    rows.map((r) => [
      r.column_name,
      { type: r.data_type, nullable: r.is_nullable === 'YES', hasDefault: r.column_default !== null },
    ]),
  )
}

describe('schema', () => {
  afterAll(closeOwnerPool)

  it('creates exactly the ten tables of the SDK-path subset', async () => {
    const { rows } = await ownerPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    )
    expect(rows.map((r) => r.table_name)).toEqual(EXPECTED_TABLES)
  })

  it('gives session a client-supplied primary key with no default', async () => {
    const cols = await columns('session')
    expect(cols.get('id')?.hasDefault).toBe(false)
    expect(cols.get('ended_at')?.nullable).toBe(true)
    expect(cols.get('ended_by')?.nullable).toBe(true)
    expect(cols.get('entry_point')?.nullable).toBe(false)
  })

  it('carries the two columns the wire contract adds to workspace', async () => {
    const cols = await columns('workspace')
    expect(cols.get('secret_hash')?.nullable).toBe(false)
    expect(cols.get('disabled_at')?.nullable).toBe(true)
  })

  it('stores the snapshot split as two jsonb columns keyed to the session', async () => {
    const cols = await columns('player_state_snapshot')
    expect(cols.get('declared')?.type).toBe('jsonb')
    expect(cols.get('raw')?.type).toBe('jsonb')
    expect(cols.get('is_missing')?.nullable).toBe(false)
    expect(cols.get('degraded_reason')?.nullable).toBe(true)
    expect(cols.get('captured_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'player_state_snapshot'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(session_id\)/)
    expect(defs).toMatch(/gin \(declared jsonb_path_ops\)/)
  })

  it('indexes event for time-range scans and per-conversation reads', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'event'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/USING brin \(occurred_at\)/)
    expect(defs).toMatch(/\(conversation_id, occurred_at\)/)
  })

  it('carries workspace_id on every table except workspace and agent', async () => {
    for (const table of EXPECTED_TABLES) {
      const cols = await columns(table)
      const expected = table === 'workspace' || table === 'agent'
      expect(cols.has('workspace_id'), `${table}.workspace_id`).toBe(!expected)
    }
  })

  it('restricts every delete rather than cascading', async () => {
    const { rows } = await ownerPool.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype from pg_constraint where contype = 'f'`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.confdeltype, row.conname).toBe('r') // r = RESTRICT
  })

  it('makes (conversation_id, seq) unique so ordering cannot collide', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'message'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(conversation_id, seq\)/)
  })
})
