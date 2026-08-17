import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeOwnerPool, ownerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'

afterAll(async () => {
  await closeOwnerPool()
})

beforeEach(truncateAll)

describe('ticket number schema', () => {
  it('has ticket_seq on workspace defaulting to 0', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ ticket_seq: number }>(
      `select ticket_seq from workspace where id = $1`,
      [workspaceId],
    )
    expect(rows[0]!.ticket_seq).toBe(0)
  })

  it('rejects a second conversation with the same number in one workspace', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await ownerPool.query(
      `insert into conversation (workspace_id, player_id, number) values ($1, $2, 7)`,
      [workspaceId, playerId],
    )
    await expect(
      ownerPool.query(`insert into conversation (workspace_id, player_id, number) values ($1, $2, 7)`, [
        workspaceId,
        playerId,
      ]),
    ).rejects.toThrow(/conversation_workspace_number_uk/)
  })

  it('allows the same number in two different workspaces', async () => {
    const wsA = await seedWorkspace()
    const wsB = await seedWorkspace()
    const playerA = await seedPlayer(wsA)
    const playerB = await seedPlayer(wsB)
    await ownerPool.query(`insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`, [wsA, playerA])
    await expect(
      ownerPool.query(`insert into conversation (workspace_id, player_id, number) values ($1, $2, 1)`, [wsB, playerB]),
    ).resolves.toBeDefined()
  })

  it('rejects a conversation with no number', async () => {
    const workspaceId = await seedWorkspace()
    const playerId = await seedPlayer(workspaceId)
    await expect(
      ownerPool.query(`insert into conversation (workspace_id, player_id) values ($1, $2)`, [workspaceId, playerId]),
    ).rejects.toThrow(/not-null/i)
  })

  it('grants support_app UPDATE on ticket_seq but not on secret_hash', async () => {
    const { rows: allowed } = await ownerPool.query<{ ok: boolean }>(
      `select has_column_privilege('support_app', 'workspace', 'ticket_seq', 'UPDATE') as ok`,
    )
    expect(allowed[0]!.ok).toBe(true)

    const { rows: denied } = await ownerPool.query<{ ok: boolean }>(
      `select has_column_privilege('support_app', 'workspace', 'secret_hash', 'UPDATE') as ok`,
    )
    expect(denied[0]!.ok).toBe(false)
  })
})

// The migration's backfill, replayed against rows that were numbered before it
// ran. NOT NULL is already on the column by the time tests run, so the
// constraint is dropped for the duration and restored in a finally — this
// exercises the real statements from the shipped migration file rather than a
// paraphrase of them.
describe('ticket number backfill', () => {
  it('numbers each workspace contiguously from 1 by created_at and leaves ticket_seq at the max', async () => {
    const wsA = await seedWorkspace()
    const wsB = await seedWorkspace()
    const playerA = await seedPlayer(wsA)
    const playerB = await seedPlayer(wsB)

    const mk = async (workspaceId: string, playerId: string, createdAt: string) => {
      const id = randomUUID()
      await ownerPool.query(
        `insert into conversation (id, workspace_id, player_id, number, created_at) values ($1, $2, $3, 999, $4)`,
        [id, workspaceId, playerId, createdAt],
      )
      return id
    }

    // Both the NOT NULL and the uniqueness constraint postdate the backfill in
    // the real migration (they're steps 5, after steps 3-4 run) — drop both
    // for the duration so this placeholder data, which deliberately collides
    // on 999, can be seeded at all.
    await ownerPool.query(`alter table conversation alter column number drop not null`)
    await ownerPool.query(`drop index conversation_workspace_number_uk`)
    try {
      const a1 = await mk(wsA, playerA, '2026-01-01T00:00:00Z')
      const a2 = await mk(wsA, playerA, '2026-01-02T00:00:00Z')
      const a3 = await mk(wsA, playerA, '2026-01-03T00:00:00Z')
      const b1 = await mk(wsB, playerB, '2026-01-05T00:00:00Z')

      await ownerPool.query(`update conversation set number = null`)
      await ownerPool.query(`update workspace set ticket_seq = 0`)

      const sql = readFileSync(new URL('../drizzle/0003_ticket_number.sql', import.meta.url), 'utf8')
      const backfill = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter((s) => s.includes('BACKFILL'))
      expect(backfill).toHaveLength(2)
      for (const statement of backfill) await ownerPool.query(statement)

      const { rows } = await ownerPool.query<{ id: string; number: number }>(
        `select id, number from conversation order by workspace_id, number`,
      )
      const byId = new Map(rows.map((r) => [r.id, r.number]))
      expect(byId.get(a1)).toBe(1)
      expect(byId.get(a2)).toBe(2)
      expect(byId.get(a3)).toBe(3)
      expect(byId.get(b1)).toBe(1)

      const { rows: seqs } = await ownerPool.query<{ id: string; ticket_seq: number }>(
        `select id, ticket_seq from workspace`,
      )
      const seqById = new Map(seqs.map((r) => [r.id, r.ticket_seq]))
      expect(seqById.get(wsA)).toBe(3)
      expect(seqById.get(wsB)).toBe(1)
    } finally {
      await ownerPool.query(`update conversation set number = 0 where number is null`)
      await ownerPool.query(`alter table conversation alter column number set not null`)
      await ownerPool.query(
        `create unique index conversation_workspace_number_uk on conversation using btree (workspace_id, number)`,
      )
    }
  })
})
