import { afterAll, describe, expect, it } from 'vitest'
import { FORM_FIELD_TYPES } from '@support/types'
import { ownerPool, closeOwnerPool, seedWorkspace, seedPlayer } from './helpers/db.ts'

const EXPECTED_TABLES = [
  'agent',
  'article',
  'article_attachment',
  'bot_config',
  'change_log',
  'conversation',
  'declared_field',
  'event',
  'form',
  'form_answer',
  'form_submission',
  'form_version',
  'intent',
  'message',
  'player',
  'player_state_snapshot',
  'session',
  'subintent',
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

  it('creates exactly the twenty tables of the SDK-path + articles-KB + bot-config + forms subset', async () => {
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

  it('keys bot_config by workspace_id itself — one row per workspace is structural', async () => {
    const cols = await columns('bot_config')
    expect(cols.has('id')).toBe(false)
    expect(cols.get('is_provisioned')?.nullable).toBe(false)
    expect(cols.get('is_provisioned')?.hasDefault).toBe(true)
    expect(cols.get('prompt')?.nullable).toBe(true)
    // Rules are their own column, not appended into prompt: separately stored,
    // separately audited, joined only at send time by buildSystemPrompt.
    expect(cols.get('rules')?.type).toBe('text')
    expect(cols.get('rules')?.nullable).toBe(true)
    expect(cols.get('updated_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ column_name: string }>(
      `select a.attname as column_name
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
        where t.relname = 'bot_config' and c.contype = 'p'`,
    )
    expect(rows.map((r) => r.column_name)).toEqual(['workspace_id'])
  })

  it('gives change_log a growing bigserial key, both value columns nullable, and a NOT NULL actor', async () => {
    const cols = await columns('change_log')
    expect(cols.get('id')?.type).toBe('bigint')
    expect(cols.get('entity_type')?.type).toBe('text')
    expect(cols.get('entity_id')?.type).toBe('uuid')
    expect(cols.get('before_value')?.nullable).toBe(true)
    expect(cols.get('after_value')?.nullable).toBe(true)
    expect(cols.get('actor_id')?.nullable).toBe(false)
    expect(cols.get('changed_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'change_log'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/\(workspace_id, entity_type, entity_id, changed_at\)/)
    expect(defs).toMatch(/brin \(changed_at\)/)
  })

  it('makes a no-op audit row impossible at the database layer', async () => {
    const { rows } = await ownerPool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname = 'change_log' and c.contype = 'c'`,
    )
    expect(rows.map((r) => r.def).join('\n')).toMatch(/before_value IS DISTINCT FROM after_value/i)
  })

  it('restricts every delete on the two new tables — nothing is ever deleted', async () => {
    const { rows } = await ownerPool.query<{ table_name: string; def: string }>(
      `select t.relname as table_name, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname in ('bot_config', 'change_log') and c.contype = 'f'`,
    )
    expect(rows).toHaveLength(3) // bot_config→workspace, change_log→workspace, change_log→agent
    for (const row of rows) {
      expect(row.def, `${row.table_name}: ${row.def}`).toMatch(/ON DELETE RESTRICT/)
    }
  })

  it('gives subintent a (workspace_id, id) unique key for the composite FK', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'subintent'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE INDEX .* ON public\.subintent USING btree \(workspace_id, id\)/)
  })

  it('adds a nullable, composite-FK conversation.subintent_id', async () => {
    const cols = await columns('conversation')
    expect(cols.has('subintent_id')).toBe(true)
    expect(cols.get('subintent_id')?.nullable).toBe(true)

    const { rows } = await ownerPool.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype
         from pg_constraint
        where conrelid = 'conversation'::regclass
          and contype = 'f'
          and conkey = (
            select array_agg(attnum order by attnum)
              from pg_attribute
             where attrelid = 'conversation'::regclass
               and attname in ('workspace_id', 'subintent_id')
          )`,
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.confdeltype).toBe('r') // ON DELETE RESTRICT
  })

  it('conversation.status still defaults to bot_active', async () => {
    const { rows } = await ownerPool.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'conversation' and column_name = 'status'`,
    )
    expect(rows[0]?.column_default).toContain('bot_active')
  })

  it('conversation.confirm_phase defaults to none, accepts agent_ask, and rejects an unknown value', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const { rows } = await ownerPool.query<{ id: string; confirm_phase: string }>(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, 1) returning id, confirm_phase`,
      [workspaceId, playerId],
    )
    expect(rows[0]?.confirm_phase).toBe('none')

    await ownerPool.query(`update conversation set confirm_phase = 'agent_ask' where id = $1`, [rows[0]?.id])
    await ownerPool.query(`update conversation set confirm_phase = 'bot_article' where id = $1`, [rows[0]?.id])

    await expect(
      ownerPool.query(`update conversation set confirm_phase = 'bogus' where id = $1`, [rows[0]?.id]),
    ).rejects.toThrow()
  })

  it('conversation.confirm_phase accepts form', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    const { rows } = await ownerPool.query<{ confirm_phase: string }>(
      `insert into conversation (workspace_id, player_id, confirm_phase)
       values ($1, $2, 'form') returning confirm_phase`,
      [workspaceId, playerId],
    )
    expect(rows[0]!.confirm_phase).toBe('form')
  })

  it('adds a nullable conversation.resolution_source column', async () => {
    const cols = await columns('conversation')
    expect(cols.get('resolution_source')?.nullable).toBe(true)
  })

  it('declares form_field_type in the same order as FORM_FIELD_TYPES, and form_status with four values', async () => {
    const { rows } = await ownerPool.query<{ typname: string; labels: string[] }>(
      `select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
         from pg_type t join pg_enum e on e.enumtypid = t.oid
        where t.typname in ('form_field_type', 'form_status')
        group by t.typname`,
    )
    const byName = new Map(rows.map((r) => [r.typname, r.labels]))
    expect(byName.get('form_field_type')).toEqual([...FORM_FIELD_TYPES])
    expect(byName.get('form_status')).toEqual(['in_progress', 'completed', 'partial', 'skipped'])
  })

  it('gives form a nullable created_by and archived_at, and both of its unique keys', async () => {
    const cols = await columns('form')
    expect(cols.get('name')?.nullable).toBe(false)
    expect(cols.get('created_by')?.nullable).toBe(true)
    expect(cols.get('archived_at')?.nullable).toBe(true)
    expect(cols.get('created_at')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, name\)/)
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })

  it('stores form_version fields as jsonb defaulting to an empty array, with a nullable published_at', async () => {
    const cols = await columns('form_version')
    expect(cols.get('fields')?.type).toBe('jsonb')
    expect(cols.get('fields')?.nullable).toBe(false)
    expect(cols.get('fields')?.hasDefault).toBe(true)
    expect(cols.get('version')?.nullable).toBe(false)
    expect(cols.get('published_at')?.nullable).toBe(true)
    expect(cols.get('published_by')?.nullable).toBe(true)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_version'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(form_id, version\)/)
  })

  it('snapshots form_version as a plain int on form_submission and offers a form once per conversation', async () => {
    const cols = await columns('form_submission')
    expect(cols.get('form_version')?.type).toBe('integer')
    expect(cols.get('form_version')?.nullable).toBe(false)
    expect(cols.get('status')?.nullable).toBe(false)
    expect(cols.get('status')?.hasDefault).toBe(true)
    expect(cols.get('started_at')?.nullable).toBe(false)
    expect(cols.get('submitted_at')?.nullable).toBe(true)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_submission'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/UNIQUE.*\(conversation_id, form_id\)/)
    expect(defs).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })

  it('gives form_answer a NOT NULL value, a snapshotted field_type, and the newest-wins read index', async () => {
    const cols = await columns('form_answer')
    expect(cols.get('field_key')?.nullable).toBe(false)
    expect(cols.get('field_type')?.nullable).toBe(false)
    expect(cols.get('value')?.type).toBe('jsonb')
    expect(cols.get('value')?.nullable).toBe(false)

    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'form_answer'`,
    )
    const defs = rows.map((r) => r.indexdef).join('\n')
    expect(defs).toMatch(/\(form_submission_id, field_key, created_at\)/)
    expect(defs).not.toMatch(/UNIQUE.*\(form_submission_id, field_key\)/)
  })

  it('carries a composite tenancy FK on every new scoped-to-scoped edge, all ON DELETE RESTRICT', async () => {
    const { rows } = await ownerPool.query<{ conname: string; def: string }>(
      `select c.conname, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where c.contype = 'f'
          and (t.relname in ('form', 'form_version', 'form_submission', 'form_answer')
               or c.conname = 'subintent_form_fk')`,
    )
    const byName = new Map(rows.map((r) => [r.conname, r.def]))
    for (const [name, def] of byName) expect(def, name).toMatch(/ON DELETE RESTRICT/)

    const composite = (def: string | undefined) => def !== undefined && /FOREIGN KEY \([^)]*workspace_id/.test(def)
    expect(composite(byName.get('form_version_form_fk'))).toBe(true)
    expect(composite(byName.get('form_submission_conversation_fk'))).toBe(true)
    expect(composite(byName.get('form_submission_form_fk'))).toBe(true)
    expect(composite(byName.get('form_answer_submission_fk'))).toBe(true)
    expect(composite(byName.get('subintent_form_fk'))).toBe(true)

    const versionFk = byName.get('form_submission_version_fk')
    expect(versionFk).toMatch(/FOREIGN KEY \(form_id, form_version\)/)
    expect(versionFk).toMatch(/REFERENCES form_version\(form_id, "?version"?\)/)
  })

  it('gives conversation the composite-FK parent key form_submission needs', async () => {
    const { rows } = await ownerPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'conversation'`,
    )
    expect(rows.map((r) => r.indexdef).join('\n')).toMatch(/UNIQUE.*\(workspace_id, id\)/)
  })
})
